import { createContext, type Dispatch, type ReactNode, type SetStateAction, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { LiveError } from '@/domain/live/types';
import { buildWalkRequest, parseWalkTimes, WALK_MAX_TARGETS, WALK_ROUTER_URL } from '@/domain/walk/one-to-many';
import {
  backoffS,
  dropStaleWalks,
  mergeWalks,
  needsWalkRequest,
  MIN_REQUEST_GAP_S,
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
 * at least one wanted stop; one request in flight (see ABANDON); every consumer's stops in ONE request — the nearest
 * WALK_MAX_TARGETS, and only those count as wanted, so farther stops never re-trigger it; needsWalkRequest decides
 * (a wanted stop with no entry, or one asked from more than REFRESH_MOVE_M away), and when the 60 s gap or a backoff
 * ends the provider looks again on its own (a timer, never a poll). An answer is MERGED into the cache (mergeWalks: its
 * stops' entries replaced, every other entry kept), so consumers that want different stops cost one request each and
 * then none while the rider stands still; entries asked more than STALE_ORIGIN_M from the rider are dropped. ANY
 * failure (429, 5xx, another status, network, timeout, an answer that is not a list of walks) keeps the cache, backs
 * off 60 → 120 → 240 → 480 → 600 s, and is kept quietly as the status's lastError for Diagnostics (useWalkStatus); a
 * success resets both. The clock is the wall clock (Date.now).
 *
 * ABANDON: a request lives only while the provider is mounted and the app is in the foreground. Leaving either —
 * unmounting, going to the background, Fast Refresh, an <Activity> hidden (and shown again) — cancels it and frees the
 * way for the next. An answer is applied only by the request that is currently in flight, so an abandoned request's
 * late answer is dropped unread: no state change, no bug, no backoff.
 *
 * BUGS (src/live/detach.ts's contract): a request is detached work, and every expected failure is a Result, so a throw
 * while handling an answer — or a fetchWalk that rejects instead of answering a Result — is a BUG. It never vanishes:
 * it goes to the live runtime's bug channel (LiveRuntime.reportBug, its state's internalError, which Diagnostics
 * shows) through the reporter captured when the request STARTED, so a bug that surfaces after the provider has gone
 * still arrives; it also stays in the status. The request it broke, when still in flight, counts as a failure, so the
 * provider backs off rather than asking again at once. With no live runtime yet (the schedule DB still opening), the
 * status — Diagnostics' "Routed walks" row — is its only channel.
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
/** `sinceS`: when the request in flight was asked (epoch s), 0 with none in flight. */
type WalkRun = { inFlight: AbortController | null; sinceS: number; failures: number; backoffUntilS: number; cache: WalkCache | null };

/** Where a walk bug goes: the live runtime's bug channel (LiveRuntime.reportBug), which outlives this provider. */
type BugReporter = (message: string) => void;

export function RoutedWalkProvider({ children, fetchWalk = expoWalkFetch }: RoutedWalkProviderProps) {
  const position = useUserPosition().coordinate;
  const active = useAppActive();
  const runtime = useLive().runtime;
  const [wanted, setWanted] = useState<Wanted>(NO_CONSUMERS);
  const [status, setStatus] = useState<WalkStatus>(NO_STATUS);
  const [wake, setWake] = useState(0);
  const run = useRef<WalkRun>({ inFlight: null, sinceS: 0, failures: 0, backoffUntilS: 0, cache: null });
  const reporter = useRef<BugReporter | null>(null);
  const onWake = useCallback(() => setWake((n) => n + 1), []);
  useEffect(() => {
    reporter.current = runtime === null ? null : (message) => runtime.reportBug(message);
  }, [runtime]);
  useEffect(() => requestLifetime(run.current, active), [active]);
  useEffect(() => dropBehind(run.current, position, setStatus), [position]);
  useEffect(
    () => walkTurn({ position, active, stops: [...wanted.values()].flat(), fetchWalk, run: run.current, report: reporter.current, onStatus: setStatus, onWake }),
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

/**
 * A request lives while the app is in the foreground and the provider mounted (ABANDON): in the foreground the effect's
 * teardown is abandon, which runs on going to the background, on unmount, on Fast Refresh and on an <Activity> hidden.
 */
function requestLifetime(run: WalkRun, active: boolean): (() => void) | undefined {
  invariant(active || run.inFlight === null, 'in the background nothing is in flight: leaving the foreground abandoned it');
  invariant(run.inFlight === null || !run.inFlight.signal.aborted, 'the request in flight was never cancelled: abandon clears what it aborts');
  return active ? () => abandon(run) : undefined;
}

/** Cancels the request in flight, if any, and frees the way for the next: settle drops its late answer unread. */
function abandon(run: WalkRun): void {
  invariant(run.inFlight === null || !run.inFlight.signal.aborted, 'a request in flight is cancelled here, and only here');
  invariant(run.failures === 0 || run.backoffUntilS > 0, 'abandoning keeps the backoff: a failure always set when it ends');
  // An abandoned request was still ASKED (it almost surely reached Transitous): the 60 s gap runs from its start, so
  // flipping the app while a request is out never bursts requests. Not a failure: the failure count is untouched.
  if (run.inFlight !== null) {
    run.backoffUntilS = Math.max(run.backoffUntilS, run.sinceS + MIN_REQUEST_GAP_S);
  }
  run.inFlight?.abort();
  run.inFlight = null;
  run.sinceS = 0;
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
  /** The live runtime's bug channel as it is now (null: no runtime yet); a request keeps the one it started with. */
  readonly report: BugReporter | null;
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

/**
 * A request on its way: where and when it was asked, the stops it carries, its cancel, and the bug channel it was
 * started with (kept by the request itself, so a bug after the provider has gone still arrives).
 */
type Sent = {
  readonly origin: LatLon;
  readonly requestedAtS: number;
  readonly targets: readonly WalkStop[];
  readonly controller: AbortController;
  readonly report: BugReporter | null;
};

/** Asks for every target from the rider's position; the answer settles the run, and a bug reports itself. */
function startRequest(turn: Turn, origin: LatLon, targets: readonly WalkStop[], nowS: number): void {
  invariant(turn.run.inFlight === null, 'one request in flight: the next is asked only once the last has finished or been abandoned');
  const request = buildWalkRequest(origin, targets, appVersion());
  invariant(request.ok, `a walk request from a fix to ${targets.length} stops can always be made`);
  const sent: Sent = { origin, requestedAtS: nowS, targets, controller: new AbortController(), report: turn.report };
  turn.run.inFlight = sent.controller;
  turn.run.sinceS = nowS;
  // The executor runs fetchWalk at once, and turns a synchronous throw into a rejection: a bug, like any other.
  const answer = new Promise<Result<unknown, LiveError>>((resolve) => resolve(turn.fetchWalk(request.value, sent.controller.signal)));
  detach(answer.then((got) => settle(turn, sent, got)), (message) => bugged(turn, sent, message));
}

/**
 * The answer lands. Only the request in flight applies it: an abandoned one's is dropped unread. A list of walks is
 * merged into the cache and resets the backoff; any failure keeps the cache, is kept as the status's lastError, and
 * backs off. The request stays in flight until finish, the last step, so a throw anywhere before it is a bug that
 * bugged() still finishes.
 */
function settle(turn: Turn, sent: Sent, answer: Result<unknown, LiveError>): void {
  invariant(turn.run.inFlight === sent.controller || sent.controller.signal.aborted, 'a request leaves flight only by finishing after its own answer, or by abandon, which cancels it');
  invariant(sent.targets.length >= 1 && sent.targets.length <= WALK_MAX_TARGETS, 'a request carried 1 to WALK_MAX_TARGETS stops');
  if (turn.run.inFlight !== sent.controller) {
    return; // abandoned: an answer is applied only by the request in flight
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
 * A bug while handling the answer, or a fetchWalk that rejected. It runs in detach's catch, where a throw would be an
 * unhandled rejection that vanishes in a release build, so it holds in every state the run can be in: the provider
 * mounted or gone, this request in flight, abandoned, or followed by another. It is reported first, through the
 * reporter the request started with (never through the provider's state, which dies with it); then kept in the
 * status; then, when this request is still the one in flight, it ends as a failure, so the provider backs off.
 */
function bugged(turn: Turn, sent: Sent, message: string): void {
  invariant(sent.targets.length >= 1 && sent.targets.length <= WALK_MAX_TARGETS, 'a request carried 1 to WALK_MAX_TARGETS stops');
  invariant(turn.run.inFlight !== sent.controller || !sent.controller.signal.aborted, 'the request in flight was never cancelled: abandon clears what it aborts');
  const bug: WalkBug = { message: `a walk answer could not be handled: ${message}` };
  sent.report?.(`Routed walks: ${bug.message}`);
  turn.onStatus((prev) => ({ ...prev, bug }));
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
  turn.run.sinceS = 0;
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
  invariant(stops.every((stop) => stop.stopId.length > 0 && isLatLon(stop)), 'every stop is a GTFS stop_id at a real coordinate (walkKey keys it by both)');
  const shared = useContext(WalkContext);
  const position = useUserPosition().coordinate;
  const consumer = useId();
  const register = shared === null ? null : shared.register;
  const cache = shared === null ? null : shared.status.cache;
  useEffect(() => (register === null ? undefined : register(consumer, stops)), [register, consumer, stops]);
  const walk = useMemo(() => walker(cache, stops, position), [cache, stops, position]);
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
  invariant(status.cache === null || status.cache.lastRequestAtS > 0, 'a cache remembers the real instant its latest answer was asked at');
  invariant(status.bug === null || status.bug.message.length > 0, 'a bug says what broke');
  return status;
}
