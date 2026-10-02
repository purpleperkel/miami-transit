import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { HURRY_DEFAULTS } from '../hurry/verdict';
import { WALK_MAX_TARGETS, type WalkPath } from './one-to-many';

/**
 * mfix9: the routed-walk POLICY, pure — when the app asks Transitous for walks again, and what a verdict walks.
 *
 * THE CACHE holds one ENTRY per stop, under walkKey: the stop's GTFS stop_id AND its place (5 decimals), so two feeds'
 * stops that share a raw stop_id but stand in different places never share a walk. Each entry keeps the place and the
 * instant it was answered from. A new answer is MERGED in (mergeWalks): its stops' entries are replaced and every other
 * entry stays, so two consumers that want different stops (the Now bar and an open station sheet) cost one request
 * each, then none while the rider stands still. An entry is DROPPED once the rider is more than STALE_ORIGIN_M from its
 * own origin (dropStaleWalks; mergeWalks drops from the answer's origin, where the rider stood).
 *
 *   needsWalkRequest  never while backing off, and never within MIN_REQUEST_GAP_S of the last answered request; then
 *                     when a wanted stop has no entry, or its entry was asked from STRICTLY more than REFRESH_MOVE_M
 *                     from the rider (an entry holding null WAS asked for: no walk reaches it, and asking again from
 *                     the same place would not change that)
 *   walkFor           ROUTED when the stop's entry has a walk and the rider is within STALE_ORIGIN_M of THAT entry's
 *                     origin: its routed metres scaled by how much nearer (or farther) the rider now is in a straight
 *                     line than the entry's origin was, with no detour (the streets are already in them); unscaled for
 *                     a stop within SCALE_MIN_M of that origin, where the ratio means nothing. ESTIMATED otherwise: the
 *                     straight line with m7c's default detour (HURRY_DEFAULTS.detour)
 *   requestTargets    the stops one request carries: each walkKey once, the nearest WALK_MAX_TARGETS to the rider
 *   backoffS          the wait after failures in a row: 60, 120, 240, 480, then 600 s
 *   nextWalkCheckS    the instant the gap or the backoff ends, when a request will be due then without a new fix
 */

export const REFRESH_MOVE_M = 150;
export const MIN_REQUEST_GAP_S = 60;
export const BACKOFF_MAX_S = 600;
export const STALE_ORIGIN_M = 300;
/** A stop this close (straight line) to its entry's origin walks its routed metres unscaled: never a ratio over ~0 m. */
export const SCALE_MIN_M = 50;
/** A walkKey's coordinate decimals: 5 is ~1 m, so one stop always keys the same and two places never do. */
export const WALK_KEY_DECIMALS = 5;

/** A platform to walk to, by its GTFS stop_id at its place (a Platform fits). */
export type WalkStop = { readonly stopId: string; readonly latitude: number; readonly longitude: number };

/** One stop's answer, and where and when it was asked. */
export type WalkEntry = {
  /** The street walk Transitous answered, or null: no walk reaches the stop. */
  readonly path: WalkPath | null;
  /** Where the rider stood when it was asked for. */
  readonly origin: LatLon;
  /** Straight-line metres from `origin` to the stop: what walkFor scales the routed metres by. */
  readonly straightAtOrigin: number;
  /** When it was asked for, epoch s (the wall clock). */
  readonly requestedAtS: number;
};

export type WalkCache = {
  /** When the latest answer merged in was asked for, epoch s: the request gap runs from it, even once its entries drop. */
  readonly lastRequestAtS: number;
  /** walkKey(stop) → the stop's entry. */
  readonly entries: ReadonlyMap<string, WalkEntry>;
};

/** One request's answer, as it is merged: from where and when it was asked, its targets in order, and their walks. */
export type WalkAnswer = {
  readonly origin: LatLon;
  readonly requestedAtS: number;
  readonly stops: readonly WalkStop[];
  readonly paths: readonly (WalkPath | null)[];
};

/** What a verdict walks: metres, the detour m7c's engine puts on them, and whether they follow the streets or estimate them. */
export type WalkEstimate = { readonly walkMeters: number; readonly detour: number; readonly source: 'routed' | 'estimated' };

/** A verdict's walk to one of its stops, from the rider's latest fix (what useWalkTo gives: walkFor over the app's cache). */
export type WalkTo = (stop: WalkStop) => WalkEstimate;

/** A stop's cache key: its GTFS stop_id AND its place, so two feeds' stops sharing a raw stop_id never share a walk. */
export function walkKey(stop: WalkStop): string {
  invariant(stop.stopId.length > 0, 'a walk goes to a stop named by its GTFS stop_id');
  invariant(isLatLon(stop), `a walk goes to a real place (stop ${stop.stopId})`);
  return `${stop.stopId}@${stop.latitude.toFixed(WALK_KEY_DECIMALS)},${stop.longitude.toFixed(WALK_KEY_DECIMALS)}`;
}

export function needsWalkRequest(cache: WalkCache | null, position: LatLon, nowS: number, wanted: readonly WalkStop[], backoffUntilS: number): boolean {
  invariant(Number.isFinite(nowS) && Number.isFinite(backoffUntilS), 'the policy is asked at an instant, against the instant a backoff ends');
  invariant(isLatLon(position), 'the rider is a real coordinate');
  if (nowS < backoffUntilS || (cache !== null && nowS - cache.lastRequestAtS < MIN_REQUEST_GAP_S)) {
    return false;
  }
  return dueStops(cache, position, wanted).length > 0;
}

/** The wanted stops a request would refresh: no entry, or an entry asked from STRICTLY more than REFRESH_MOVE_M away. */
function dueStops(cache: WalkCache | null, position: LatLon, wanted: readonly WalkStop[]): WalkStop[] {
  invariant(isLatLon(position), 'the rider is a real coordinate');
  invariant(cache === null || [...cache.entries.values()].every((entry) => isLatLon(entry.origin) && entry.straightAtOrigin >= 0), 'every entry was asked from a real place');
  return wanted.filter((stop) => {
    const entry = cache?.entries.get(walkKey(stop));
    return entry === undefined || haversineMeters(entry.origin, position) > REFRESH_MOVE_M;
  });
}

export function walkFor(cache: WalkCache | null, stop: WalkStop, position: LatLon): WalkEstimate {
  invariant(isLatLon(position) && isLatLon(stop), `a walk joins two real coordinates (stop ${stop.stopId})`);
  const straightNow = haversineMeters(position, stop);
  const entry = cache?.entries.get(walkKey(stop));
  if (entry === undefined || entry.path === null || haversineMeters(entry.origin, position) > STALE_ORIGIN_M) {
    return { walkMeters: straightNow, detour: HURRY_DEFAULTS.detour, source: 'estimated' };
  }
  invariant(Math.abs(entry.straightAtOrigin - haversineMeters(entry.origin, stop)) < 2, `the walk to ${stop.stopId} is scaled from its own entry's origin (the key pins the stop's place)`);
  const walkMeters = entry.straightAtOrigin < SCALE_MIN_M ? entry.path.distanceM : entry.path.distanceM * (straightNow / entry.straightAtOrigin);
  invariant(Number.isFinite(walkMeters) && walkMeters >= 0, `a routed walk to ${stop.stopId} is a real distance, never a ratio over ~0 m`);
  return { walkMeters, detour: 1, source: 'routed' };
}

/**
 * The cache with `answer` merged in: each of its stops gets a new entry from the answer's origin; every other entry
 * stays, unless it was asked more than STALE_ORIGIN_M from that origin (where the rider stood), and is dropped.
 */
export function mergeWalks(cache: WalkCache | null, answer: WalkAnswer): WalkCache {
  invariant(answer.stops.length >= 1 && answer.stops.length === answer.paths.length, 'an answer gives one walk, or none, per stop asked for');
  invariant(cache === null || answer.requestedAtS >= cache.lastRequestAtS, 'answers merge in the order they were asked (only the request in flight, always the latest asked, merges its answer)');
  const entries = new Map<string, WalkEntry>();
  for (const [key, entry] of cache?.entries ?? []) {
    if (haversineMeters(entry.origin, answer.origin) <= STALE_ORIGIN_M) {
      entries.set(key, entry);
    }
  }
  for (const [i, stop] of answer.stops.entries()) {
    entries.set(walkKey(stop), { path: answer.paths[i] ?? null, origin: answer.origin, straightAtOrigin: haversineMeters(answer.origin, stop), requestedAtS: answer.requestedAtS });
  }
  invariant([...entries.values()].every((entry) => haversineMeters(entry.origin, answer.origin) <= STALE_ORIGIN_M), 'after a merge every entry was asked within STALE_ORIGIN_M of where the rider last asked');
  return { lastRequestAtS: answer.requestedAtS, entries };
}

/** The cache without the entries asked more than STALE_ORIGIN_M from `position`: the very same cache when none is. */
export function dropStaleWalks(cache: WalkCache, position: LatLon): WalkCache {
  invariant(isLatLon(position), 'the rider is a real coordinate');
  invariant(Number.isFinite(cache.lastRequestAtS), 'a cache remembers when it was last asked, whatever it holds');
  const kept = [...cache.entries].filter(([, entry]) => haversineMeters(entry.origin, position) <= STALE_ORIGIN_M);
  return kept.length === cache.entries.size ? cache : { lastRequestAtS: cache.lastRequestAtS, entries: new Map(kept) };
}

/** The stops one request carries: each walkKey once (its first registration), nearest the rider first, at most WALK_MAX_TARGETS. */
export function requestTargets(stops: readonly WalkStop[], position: LatLon): WalkStop[] {
  invariant(isLatLon(position), 'targets are ranked from a real position');
  const byKey = new Map<string, WalkStop>();
  for (const stop of stops) {
    const key = walkKey(stop);
    if (!byKey.has(key)) {
      byKey.set(key, stop);
    }
  }
  const ranked = [...byKey.values()].map((stop) => ({ stop, metres: haversineMeters(position, stop) })).sort((a, b) => a.metres - b.metres);
  const cut = ranked[WALK_MAX_TARGETS];
  invariant(cut === undefined || ranked.slice(0, WALK_MAX_TARGETS).every((entry) => entry.metres <= cut.metres), 'a stop left out is no nearer than any stop asked for');
  return ranked.slice(0, WALK_MAX_TARGETS).map((entry) => entry.stop);
}

/** The wait after `failures` failed requests in a row: MIN_REQUEST_GAP_S, doubling, at most BACKOFF_MAX_S. */
export function backoffS(failures: number): number {
  invariant(Number.isSafeInteger(failures) && failures >= 1, `a backoff follows at least one failure, got ${failures}`);
  let wait = MIN_REQUEST_GAP_S;
  for (let i = 1; i < failures && wait < BACKOFF_MAX_S; i += 1) {
    wait *= 2;
  }
  const capped = Math.min(wait, BACKOFF_MAX_S);
  invariant(capped === BACKOFF_MAX_S || capped === MIN_REQUEST_GAP_S * 2 ** (failures - 1), 'the wait doubles with each failure in a row until its cap');
  return capped;
}

/**
 * When to look again without a new trigger: the instant the request gap and the backoff have both ended, when a
 * request will be due then for this rider and these stops; null when only a new fix or a new stop could make one due.
 */
export function nextWalkCheckS(cache: WalkCache | null, position: LatLon, wanted: readonly WalkStop[], backoffUntilS: number): number | null {
  invariant(Number.isFinite(backoffUntilS), 'a backoff ends at an instant');
  invariant(cache === null || Number.isFinite(cache.lastRequestAtS), 'the request gap runs from an instant');
  const atS = cache === null ? backoffUntilS : Math.max(backoffUntilS, cache.lastRequestAtS + MIN_REQUEST_GAP_S);
  return dueStops(cache, position, wanted).length > 0 ? atS : null;
}
