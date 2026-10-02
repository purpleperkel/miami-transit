import { createContext, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { LiveError } from '@/domain/live/types';
import { buildWalkRequest, parseWalkTimes, WALK_ROUTER_URL } from '@/domain/walk/one-to-many';
import { backoffS, needsWalkRequest, nextWalkCheckS, requestTargets, type WalkCache, type WalkEstimate, walkFor, type WalkStop } from '@/domain/walk/walk-cache';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, type Result } from '@/lib/result';
import { detach } from '@/live/detach';
import { EXPO_FETCH } from '@/live/http';

import { useUserPosition } from '../map/use-user-location';
import { appVersion } from '../routes/plan-client';
import { fetchWalkJson, type WalkGet } from './walk-fetch';

/**
 * mfix9 (Jamie, 2026-10-02 09:12: "chill" for Fifth Street, a walk Google put at 11 min): the app's ONE routed-walk
 * runtime. The root layout mounts it once, inside UserLocationProvider (it follows the rider's one fix) and around the
 * root Stack. Every verdict that walks to a platform registers its stops through useWalkTo — the Now bar's near trip
 * (src/ui/now), the station sheet (src/ui/hurry), the route chip off the plan start (src/ui/routes) — and gets back,
 * per stop, the street-routed walk Transitous's one-to-many gave (walkFor: 'routed') when one is known, else the
 * straight-line estimate ('estimated'). Without this provider useWalkTo IS that estimate, and never throws, so m7c's
 * and mfix8's tests that render the bar and the sheet bare keep their verdicts.
 *
 * REQUEST RULES (Transitous's terms, transitous#2538: FEW requests): only while AppState is 'active', with a fix and
 * at least one wanted stop; one request in flight; every consumer's stops in ONE request — the nearest
 * WALK_MAX_TARGETS, and only those count as wanted, so farther stops never re-trigger it; needsWalkRequest decides,
 * and when the 60 s gap or a backoff ends the provider looks again on its own (a timer, never a poll). An answer
 * becomes the cache, with the rider's position and the wall-clock instant the request was made; ANY failure (429, 5xx,
 * another status, network, timeout, an answer that is not a list of walks) keeps the old cache and backs off 60 → 120
 * → 240 → 480 → 600 s; a success resets the backoff. The clock is the wall clock (Date.now).
 *
 * fetchWalk is injectable (tests never touch the network); by default it is the app's typed HTTP, src/live/http.ts's
 * EXPO_FETCH, under walk-fetch.ts's abort timer.
 */

/** The one-to-many exchange: the parsed JSON body, or a typed failure. */
export type WalkFetch = (request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }, signal: AbortSignal) => Promise<Result<unknown, LiveError>>;

export type RoutedWalkProviderProps = { readonly children?: ReactNode; readonly fetchWalk?: WalkFetch };

/** What consumers share: the latest answer, and how to register the stops they walk to. */
type WalkShared = {
  readonly cache: WalkCache | null;
  /** Registers a consumer's stops (replacing its previous ones); returns the release. */
  readonly register: (consumer: string, stops: readonly WalkStop[]) => () => void;
};

const WalkContext = createContext<WalkShared | null>(null);

/** Each mounted consumer's stops, by its React id. */
type Wanted = ReadonlyMap<string, readonly WalkStop[]>;
const NO_CONSUMERS: Wanted = new Map();

/** The provider's request bookkeeping across renders: the request in flight, failures in a row, and when the backoff ends (epoch s). */
type WalkRun = { inFlight: AbortController | null; failures: number; backoffUntilS: number };

export function RoutedWalkProvider({ children, fetchWalk = expoWalkFetch }: RoutedWalkProviderProps) {
  const position = useUserPosition().coordinate;
  const active = useAppActive();
  const [wanted, setWanted] = useState<Wanted>(NO_CONSUMERS);
  const [cache, setCache] = useState<WalkCache | null>(null);
  const [wake, setWake] = useState(0);
  const run = useRef<WalkRun>({ inFlight: null, failures: 0, backoffUntilS: 0 });
  useEffect(() => {
    const current = run.current;
    return () => abandon(current);
  }, []);
  useEffect(
    () => walkTurn({ position, active, stops: [...wanted.values()].flat(), cache, wake, fetchWalk, run: run.current, onCache: setCache, onWake: () => setWake((n) => n + 1) }),
    [position, active, wanted, cache, wake, fetchWalk],
  );
  const register = useCallback((consumer: string, stops: readonly WalkStop[]) => registerStops(setWanted, consumer, stops), []);
  const shared = useMemo<WalkShared>(() => ({ cache, register }), [cache, register]);
  invariant(cache === null || cache.paths.size > 0, 'a cache holds the answer to a request, which carried at least one stop');
  invariant(position === null || isLatLon(position), 'the walks are asked from a real fix, or not at all');
  return <WalkContext.Provider value={shared}>{children}</WalkContext.Provider>;
}

/** The default fetchWalk: the app's typed HTTP (src/live/http.ts's EXPO_FETCH) under walk-fetch.ts's abort timer. */
function expoWalkFetch(request: WalkGet, signal: AbortSignal): Promise<Result<unknown, LiveError>> {
  invariant(request.url.startsWith(`${WALK_ROUTER_URL}?`), 'the default fetch only ever asks Transitous for walks');
  invariant(Object.keys(request.headers).length === 1 && request.headers['User-Agent'] !== undefined, 'a walk request carries the User-Agent and no key');
  return fetchWalkJson(EXPO_FETCH, request, signal);
}

/** Adds (or replaces) a consumer's stops; the release removes them. */
function registerStops(setWanted: (update: (prev: Wanted) => Wanted) => void, consumer: string, stops: readonly WalkStop[]): () => void {
  invariant(consumer.length > 0, 'a consumer is registered under its React id');
  invariant(stops.every((stop) => stop.stopId.length > 0 && isLatLon(stop)), 'every stop is a GTFS stop_id at a real coordinate');
  setWanted((prev) => new Map(prev).set(consumer, stops));
  return () => setWanted((prev) => withoutConsumer(prev, consumer));
}

/** The registry without `consumer` (it unmounted, or registers other stops). */
function withoutConsumer(wanted: Wanted, consumer: string): Wanted {
  invariant(consumer.length > 0, 'a consumer is released under its React id');
  const next = new Map(wanted);
  next.delete(consumer);
  invariant(!next.has(consumer) && next.size >= wanted.size - 1, 'only that consumer is released');
  return next;
}

/** Cancels the request in flight (the provider has gone): its late answer is dropped by settle. */
function abandon(run: WalkRun): void {
  invariant(run.failures >= 0, 'the run counts failures in a row');
  run.inFlight?.abort();
  run.inFlight = null;
  invariant(run.inFlight === null, 'nothing is in flight once the provider has gone');
}

/** Everything one look at the request rules reads, and where it reports. */
type Turn = {
  readonly position: LatLon | null;
  readonly active: boolean;
  readonly stops: readonly WalkStop[];
  readonly cache: WalkCache | null;
  /** Bumped by a timer or a settled request: the look it asks for. */
  readonly wake: number;
  readonly fetchWalk: WalkFetch;
  readonly run: WalkRun;
  readonly onCache: (cache: WalkCache) => void;
  readonly onWake: () => void;
};

/** One look at the rules: ask now, or set a timer for when a request comes due; returns the timer's teardown. */
function walkTurn(turn: Turn): (() => void) | undefined {
  invariant(Number.isSafeInteger(turn.wake) && turn.wake >= 0, 'a look follows a render, a timer or a settled request');
  invariant(turn.run.failures === 0 || turn.run.backoffUntilS > 0, 'a failure always sets when its backoff ends');
  if (!turn.active || turn.position === null || turn.stops.length === 0 || turn.run.inFlight !== null) {
    return undefined;
  }
  const targets = requestTargets(turn.stops, turn.position);
  const ids = targets.map((stop) => stop.stopId);
  const nowS = Date.now() / 1000;
  if (needsWalkRequest(turn.cache, turn.position, nowS, ids, turn.run.backoffUntilS)) {
    startRequest(turn, turn.position, targets, nowS);
    return undefined;
  }
  const atS = nextWalkCheckS(turn.cache, turn.position, ids, turn.run.backoffUntilS);
  if (atS === null) {
    return undefined;
  }
  const timer = setTimeout(turn.onWake, Math.max(1, Math.ceil((atS - nowS) * 1000)));
  return () => clearTimeout(timer);
}

/** A request on its way: where and when it was asked, the stops it carries, and its cancel. */
type Sent = { readonly origin: LatLon; readonly requestedAtS: number; readonly targets: readonly WalkStop[]; readonly controller: AbortController };

/** Asks for every target from the rider's position; the answer, or the failure, settles the run. */
function startRequest(turn: Turn, origin: LatLon, targets: readonly WalkStop[], nowS: number): void {
  const request = buildWalkRequest(origin, targets, appVersion());
  invariant(request.ok, `a walk request from a fix to ${targets.length} stops can always be made`);
  const sent: Sent = { origin, requestedAtS: nowS, targets, controller: new AbortController() };
  turn.run.inFlight = sent.controller;
  detach(
    turn.fetchWalk(request.value, sent.controller.signal).then(
      (answer) => settle(turn, sent, answer),
      (reason: unknown) => settle(turn, sent, err({ kind: 'network', message: `the walk request failed: ${String(reason)}` })),
    ),
    (message) => settle(turn, sent, err({ kind: 'network', message: `the walk answer could not be kept: ${message}` })),
  );
  invariant(turn.run.inFlight === sent.controller, 'one request is in flight until its answer lands');
}

/** The answer lands: a list of walks becomes the cache and resets the backoff; any failure backs off and keeps the cache. */
function settle(turn: Turn, sent: Sent, answer: Result<unknown, LiveError>): void {
  invariant(sent.targets.length > 0 && Number.isFinite(sent.requestedAtS), 'a request carried stops and was made at an instant');
  if (turn.run.inFlight !== sent.controller) {
    return;
  }
  turn.run.inFlight = null;
  const parsed = answer.ok ? parseWalkTimes(answer.value, sent.targets.length) : answer;
  if (parsed.ok) {
    turn.run.failures = 0;
    turn.run.backoffUntilS = 0;
    turn.onCache({ origin: sent.origin, requestedAtS: sent.requestedAtS, paths: new Map(sent.targets.map((stop, i) => [stop.stopId, parsed.value[i] ?? null])) });
  } else {
    turn.run.failures += 1;
    turn.run.backoffUntilS = Date.now() / 1000 + backoffS(turn.run.failures);
  }
  invariant(parsed.ok === (turn.run.failures === 0), 'a success clears the failures; a failure counts one more');
  turn.onWake();
}

/** Whether the app is in the foreground (AppState 'active'), following every change. */
function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  invariant(typeof AppState.addEventListener === 'function', 'React Native reports the app\'s state');
  invariant(typeof active === 'boolean', 'the app is in the foreground or it is not');
  return active;
}

/**
 * The walk to each of `stops` from the rider's latest fix: the street-routed walk when the provider knows one, else the
 * straight-line estimate. Registers the stops with the provider while the caller is mounted (the union over every
 * consumer is asked for in one request); pass the same array while the stops are the same (useMemo), since a new array
 * registers again. Without a provider: the estimate (walkFor(null, …)), never a throw. Call the result only while the
 * rider is located, and only for a stop in `stops`.
 */
export function useWalkTo(stops: readonly WalkStop[]): (stopId: string) => WalkEstimate {
  const shared = useContext(WalkContext);
  const position = useUserPosition().coordinate;
  const consumer = useId();
  const register = shared === null ? null : shared.register;
  const cache = shared === null ? null : shared.cache;
  useEffect(() => (register === null ? undefined : register(consumer, stops)), [register, consumer, stops]);
  const walk = useMemo(() => walker(cache, stops, position), [cache, stops, position]);
  invariant(shared !== null || cache === null, 'only a provider knows routed walks');
  invariant(stops.every((stop) => stop.stopId.length > 0), 'every stop is named by its GTFS stop_id');
  return walk;
}

/** stop_id → its WalkEstimate from `position`, over `cache` (null: the estimate). */
function walker(cache: WalkCache | null, stops: readonly WalkStop[], position: LatLon | null): (stopId: string) => WalkEstimate {
  const byId = new Map(stops.map((stop) => [stop.stopId, stop]));
  invariant(position === null || isLatLon(position), 'the rider is a real coordinate, or not located');
  invariant(cache === null || cache.paths.size > 0, 'a cache holds walks');
  return (stopId) => {
    const stop = byId.get(stopId);
    invariant(stop !== undefined && position !== null, `a walk is asked for a stop given to useWalkTo (${stopId}), while the rider is located`);
    return walkFor(cache, stop, position);
  };
}
