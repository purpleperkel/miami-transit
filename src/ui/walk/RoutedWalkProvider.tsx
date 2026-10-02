import { createContext, type Dispatch, type ReactNode, type SetStateAction, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { LiveError } from '@/domain/live/types';
import { buildWalkRequest, parseWalkTimes, WALK_MAX_TARGETS, WALK_ROUTER_URL } from '@/domain/walk/one-to-many';
import {
  backoffS,
  dropStaleWalks,
  mergeWalks,
  needsWalkRequest,
  nextWalkCheckS,
  requestTargets,
  type WalkAnswer,
  type WalkCache,
  walkFor,
  walkKey,
  type WalkStop,
  type WalkTo,
} from '@/domain/walk/walk-cache';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';
import { detach } from '@/live/detach';
import { EXPO_FETCH } from '@/live/http';
import { useLive } from '@/live/live-context';

import { useUserPosition } from '../map/use-user-location';
import { appVersion } from '../routes/plan-client';
import { useAppActive } from '../use-app-active';
import { fetchWalkJson, type WalkGet } from './walk-fetch';

/**
 * mfix9 (Jamie, 2026-10-02 09:12: "chill" for Fifth Street, a walk Google put at 11 min): the app's ONE routed-walk
 * runtime. The root layout mounts it once, inside UserLocationProvider (it follows the rider's one fix) and around the
 * root Stack. Every verdict that walks to a platform registers its stops through useWalkTo — the Now bar's near trip
 * (src/ui/now), the station sheet (src/ui/hurry), the route chip (src/ui/routes) — and gets back, per stop, the
 * street-routed walk Transitous's one-to-many gave (walkFor: 'routed') when one is known, else the straight-line
 * estimate ('estimated'). Without this provider useWalkTo IS that estimate, and never throws, so m7c's and mfix8's tests
 * that render the bar and the sheet bare keep their verdicts.
 *
 * REQUEST RULES (Transitous's terms, transitous#2538: FEW requests): only while AppState is 'active', with a fix and
 * at least one wanted stop; one request in flight; every consumer's stops in ONE request — the nearest
 * WALK_MAX_TARGETS, and only those count as wanted, so farther stops never re-trigger it; needsWalkRequest decides
 * (a wanted stop with no entry, or one asked from more than REFRESH_MOVE_M away), and when the 60 s gap or a backoff
 * ends the provider looks again on its own (a timer, never a poll). An answer is MERGED into the cache (mergeWalks: its
 * stops' entries replaced, every other entry kept), so consumers that want different stops cost one request each and
 * then none while the rider stands still; entries asked more than STALE_ORIGIN_M from the rider are dropped. ANY
 * failure (429, 5xx, another status, network, timeout, an answer that is not a list of walks) keeps the cache, backs
 * off 60 → 120 → 240 → 480 → 600 s, and is kept quietly as the status's lastError for Diagnostics (useWalkStatus); a
 * success resets both. The clock is the wall clock (Date.now).
 *
 * BUGS (src/live/detach.ts's contract): a request is detached work, and every expected failure is a Result, so a throw
 * while handling an answer — or a fetchWalk that rejects instead of answering a Result — is a BUG. It never vanishes:
 * it goes where the live runtime's own bugs go (LiveRuntime.reportBug, its state's internalError) and stays in the
 * status; the request it broke counts as a failure, so the provider backs off rather than asking again at once.
 *
 * fetchWalk is injectable (tests never touch the network); by default it is the app's typed HTTP, src/live/http.ts's
 * EXPO_FETCH, under walk-fetch.ts's abort timer.
 */

/** The one-to-many exchange: the parsed JSON body, or a typed failure. It never rejects (a rejection is a bug). */
export type WalkFetch = (request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }, signal: AbortSignal) => Promise<Result<unknown, LiveError>>;

export type RoutedWalkProviderProps = { readonly children?: ReactNode; readonly fetchWalk?: WalkFetch };

/** A bug in handling a walk answer. Each report is its own object, so a bug that happens twice is passed on twice. */
export type WalkBug = { readonly message: string };

/** What the provider holds, for Diagnostics (useWalkStatus). */
export type WalkStatus = {
  /** The walks held, merged from every answer; null before the first. */
  readonly cache: WalkCache | null;
  /** The latest request's ordinary failure, kept quietly while the provider backs off; null once a request succeeds. */
  readonly lastError: LiveError | null;
  /** The latest bug in handling an answer (also reported to the live runtime); null while none has happened. */
  readonly bug: WalkBug | null;
};

const NO_STATUS: WalkStatus = Object.freeze({ cache: null, lastError: null, bug: null });

/** What consumers share: the provider's status, and how to register the stops they walk to. */
type WalkShared = {
  readonly status: WalkStatus;
  /** Registers a consumer's stops (replacing its previous ones); returns the release. */
  readonly register: (consumer: string, stops: readonly WalkStop[]) => () => void;
};

const WalkContext = createContext<WalkShared | null>(null);

/** Each mounted consumer's stops, by its React id. */
type Wanted = ReadonlyMap<string, readonly WalkStop[]>;
const NO_CONSUMERS: Wanted = new Map();

/**
 * The provider's request bookkeeping across renders — the request in flight, failures in a row, when the backoff ends
 * (epoch s) — and the walks held: the one copy answers merge into, which the provider renders through its status.
 */
type WalkRun = { inFlight: AbortController | null; failures: number; backoffUntilS: number; cache: WalkCache | null };

export function RoutedWalkProvider({ children, fetchWalk = expoWalkFetch }: RoutedWalkProviderProps) {
  const position = useUserPosition().coordinate;
  const active = useAppActive();
  const runtime = useLive().runtime;
  const [wanted, setWanted] = useState<Wanted>(NO_CONSUMERS);
  const [status, setStatus] = useState<WalkStatus>(NO_STATUS);
  const [wake, setWake] = useState(0);
  const run = useRef<WalkRun>({ inFlight: null, failures: 0, backoffUntilS: 0, cache: null });
  const onWake = useCallback(() => setWake((n) => n + 1), []);
  useEffect(() => {
    const current = run.current;
    return () => abandon(current);
  }, []);
  useEffect(() => dropBehind(run.current, position, setStatus), [position]);
  useEffect(() => (runtime === null || status.bug === null ? undefined : runtime.reportBug(`Routed walks: ${status.bug.message}`)), [runtime, status.bug]);
  useEffect(
    () => walkTurn({ position, active, stops: [...wanted.values()].flat(), fetchWalk, run: run.current, onStatus: setStatus, onWake }),
    [position, active, wanted, status.cache, wake, fetchWalk, onWake],
  );
  const register = useCallback((consumer: string, stops: readonly WalkStop[]) => registerStops(setWanted, consumer, stops), []);
  const shared = useMemo<WalkShared>(() => ({ status, register }), [status, register]);
  invariant(position === null || isLatLon(position), 'the walks are asked from a real fix, or not at all');
  invariant(status.lastError === null || status.lastError.kind !== 'no-key', 'Transitous takes no key: a walk never fails for want of one');
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
  invariant(wanted.has(consumer), 'only a registered consumer is released (each release follows its own registration)');
  const next = new Map(wanted);
  next.delete(consumer);
  return next;
}

/** Cancels the request in flight (the provider has gone): its late answer is dropped by settle. */
function abandon(run: WalkRun): void {
  invariant(run.inFlight === null || !run.inFlight.signal.aborted, 'a request in flight is cancelled here, and only here');
  invariant(Number.isSafeInteger(run.failures) && run.failures >= 0, 'the run counts failures in a row');
  run.inFlight?.abort();
  run.inFlight = null;
}

/** Drops the walks asked more than STALE_ORIGIN_M from where the rider is now, and renders what is left. */
function dropBehind(run: WalkRun, position: LatLon | null, onStatus: Dispatch<SetStateAction<WalkStatus>>): void {
  invariant(position === null || isLatLon(position), 'the rider is a real coordinate, or not located');
  invariant(run.cache === null || run.cache.lastRequestAtS > 0, 'a cache holds the answers to requests made at real instants');
  const kept = position === null || run.cache === null ? run.cache : dropStaleWalks(run.cache, position);
  if (kept !== run.cache) {
    run.cache = kept;
    onStatus((prev) => ({ ...prev, cache: kept }));
  }
}

/** Everything one look at the request rules reads, and where it reports. */
type Turn = {
  readonly position: LatLon | null;
  readonly active: boolean;
  readonly stops: readonly WalkStop[];
  readonly fetchWalk: WalkFetch;
  readonly run: WalkRun;
  readonly onStatus: Dispatch<SetStateAction<WalkStatus>>;
  /** Asks for another look at the rules (a timer, a settled request). */
  readonly onWake: () => void;
};

/** One look at the rules: ask now, or set a timer for when a request comes due; returns the timer's teardown. */
function walkTurn(turn: Turn): (() => void) | undefined {
  invariant(turn.run.failures === 0 || turn.run.backoffUntilS > 0, 'a failure always sets when its backoff ends');
  invariant(turn.position === null || isLatLon(turn.position), 'the walks are asked from a real fix, or not at all');
  if (!turn.active || turn.position === null || turn.stops.length === 0 || turn.run.inFlight !== null) {
    return undefined;
  }
  const targets = requestTargets(turn.stops, turn.position);
  const nowS = Date.now() / 1000;
  if (needsWalkRequest(turn.run.cache, turn.position, nowS, targets, turn.run.backoffUntilS)) {
    startRequest(turn, turn.position, targets, nowS);
    return undefined;
  }
  const atS = nextWalkCheckS(turn.run.cache, turn.position, targets, turn.run.backoffUntilS);
  if (atS === null) {
    return undefined;
  }
  const timer = setTimeout(turn.onWake, Math.max(1, Math.ceil((atS - nowS) * 1000)));
  return () => clearTimeout(timer);
}

/** A request on its way: where and when it was asked, the stops it carries, and its cancel. */
type Sent = { readonly origin: LatLon; readonly requestedAtS: number; readonly targets: readonly WalkStop[]; readonly controller: AbortController };

/** Asks for every target from the rider's position; the answer settles the run, and a bug reports itself. */
function startRequest(turn: Turn, origin: LatLon, targets: readonly WalkStop[], nowS: number): void {
  invariant(turn.run.inFlight === null, 'one request in flight: the next is asked only once the last has settled');
  const request = buildWalkRequest(origin, targets, appVersion());
  invariant(request.ok, `a walk request from a fix to ${targets.length} stops can always be made`);
  const sent: Sent = { origin, requestedAtS: nowS, targets, controller: new AbortController() };
  turn.run.inFlight = sent.controller;
  // The executor runs fetchWalk at once, and turns a synchronous throw into a rejection: a bug, like any other.
  const answer = new Promise<Result<unknown, LiveError>>((resolve) => resolve(turn.fetchWalk(request.value, sent.controller.signal)));
  detach(answer.then((got) => settle(turn, sent, got)), (message) => bugged(turn, sent, message));
}

/**
 * The answer lands: a list of walks is merged into the cache and resets the backoff; any failure keeps the cache, is
 * kept as the status's lastError, and backs off. The request stays in flight until finish, the last step, so a throw
 * anywhere before it is a bug that bugged() still finishes.
 */
function settle(turn: Turn, sent: Sent, answer: Result<unknown, LiveError>): void {
  invariant(turn.run.inFlight === null || turn.run.inFlight === sent.controller, 'one request in flight: none was started while this one was out');
  invariant(sent.targets.length >= 1 && sent.targets.length <= WALK_MAX_TARGETS, 'a request carried 1 to WALK_MAX_TARGETS stops');
  if (turn.run.inFlight === null) {
    return; // the provider has gone (abandon): nobody reads a late answer
  }
  const read = answer.ok ? walksOf(answer.value, sent) : answer;
  if (read.ok) {
    turn.run.cache = mergeWalks(turn.run.cache, read.value);
  }
  const cache = turn.run.cache;
  const lastError = read.ok ? null : read.error;
  turn.onStatus((prev) => ({ ...prev, cache, lastError }));
  finish(turn, sent, !read.ok);
}

/** A 2xx body as the walks from `sent`'s origin to each of its targets, or a decode failure: it is not a list of walks. */
function walksOf(body: unknown, sent: Sent): Result<WalkAnswer, LiveError> {
  invariant(isLatLon(sent.origin) && Number.isFinite(sent.requestedAtS), 'a request was made from a real fix at an instant');
  const parsed = parseWalkTimes(body, sent.targets.length);
  invariant(!parsed.ok || parsed.value.length === sent.targets.length, 'an answer gives one walk, or none, per target, in order');
  return parsed.ok
    ? ok({ origin: sent.origin, requestedAtS: sent.requestedAtS, stops: sent.targets, paths: parsed.value })
    : err({ kind: 'decode', message: `the walk answer is not a list of walks: ${parsed.error.message}` });
}

/**
 * A bug while handling the answer, or a fetchWalk that rejected: reported first (it must never vanish), then the request
 * ends as a failure when settle did not finish it, so the provider backs off instead of asking again at once.
 */
function bugged(turn: Turn, sent: Sent, message: string): void {
  turn.onStatus((prev) => ({ ...prev, bug: { message: `a walk answer could not be handled: ${message}` } }));
  invariant(turn.run.inFlight === null || turn.run.inFlight === sent.controller, 'one request in flight: none was started while this one was out');
  invariant(sent.targets.length >= 1, 'a request carried at least one stop');
  if (turn.run.inFlight === sent.controller) {
    finish(turn, sent, true);
  }
}

/** The request is over: a success resets the backoff, a failure counts one more in a row and backs off; then look again. */
function finish(turn: Turn, sent: Sent, failed: boolean): void {
  invariant(turn.run.inFlight === sent.controller, 'only the request in flight finishes, and only once');
  invariant(Number.isSafeInteger(turn.run.failures) && turn.run.failures >= 0, 'the run counts failures in a row');
  turn.run.failures = failed ? turn.run.failures + 1 : 0;
  turn.run.backoffUntilS = failed ? Date.now() / 1000 + backoffS(turn.run.failures) : 0;
  turn.run.inFlight = null;
  turn.onWake();
}

/**
 * The walk to each of `stops` from the rider's latest fix: the street-routed walk when the provider knows one, else the
 * straight-line estimate. Registers the stops with the provider while the caller is mounted (the union over every
 * consumer is asked for in one request); pass the same array while the stops are the same (useMemo), since a new array
 * registers again. Without a provider: the estimate (walkFor(null, …)), never a throw. Call the result only while the
 * rider is located, and only for a stop in `stops` (by walkKey: its stop_id at its place).
 */
export function useWalkTo(stops: readonly WalkStop[]): WalkTo {
  const shared = useContext(WalkContext);
  const position = useUserPosition().coordinate;
  const consumer = useId();
  const register = shared === null ? null : shared.register;
  const cache = shared === null ? null : shared.status.cache;
  useEffect(() => (register === null ? undefined : register(consumer, stops)), [register, consumer, stops]);
  const walk = useMemo(() => walker(cache, stops, position), [cache, stops, position]);
  invariant(shared !== null || cache === null, 'only a provider knows routed walks');
  invariant(consumer.length > 0, 'a consumer registers under its React id');
  return walk;
}

/** Each of `stops`' WalkEstimate from `position`, over `cache` (null: the estimate). */
function walker(cache: WalkCache | null, stops: readonly WalkStop[], position: LatLon | null): WalkTo {
  invariant(position === null || isLatLon(position), 'the rider is a real coordinate, or not located');
  invariant(stops.every((stop) => stop.stopId.length > 0), 'every stop is named by its GTFS stop_id');
  const registered = new Set(stops.map(walkKey));
  return (stop) => {
    invariant(position !== null && registered.has(walkKey(stop)), `a walk is asked for a stop given to useWalkTo (${stop.stopId}), while the rider is located`);
    return walkFor(cache, stop, position);
  };
}

/** What the provider holds, for Diagnostics: its walks, the latest request's failure, the latest bug; without a provider, nothing. */
export function useWalkStatus(): WalkStatus {
  const shared = useContext(WalkContext);
  const status = shared === null ? NO_STATUS : shared.status;
  invariant(shared !== null || status === NO_STATUS, 'without a provider nothing was asked, failed or broke');
  invariant(status.cache === null || Number.isFinite(status.cache.lastRequestAtS), 'a cache remembers when it was last asked');
  return status;
}
