import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { HURRY_DEFAULTS } from '../hurry/verdict';
import { WALK_MAX_TARGETS, type WalkPath } from './one-to-many';

/**
 * mfix9: the routed-walk POLICY, pure — when the app asks Transitous for walks again, and what a verdict walks.
 *
 *   needsWalkRequest  never while backing off, and never within MIN_REQUEST_GAP_S of the cache's request; then
 *                     when there is no cache, when the rider is STRICTLY more than REFRESH_MOVE_M from where the
 *                     walks were asked from, or when a wanted stop has no entry (an entry holding null WAS asked
 *                     for: no walk reaches it, and asking again would not change that)
 *   walkFor           ROUTED when the stop has a walk and the rider is within STALE_ORIGIN_M of the cache's origin:
 *                     the routed metres scaled by how much nearer (or farther) the rider now is in a straight line,
 *                     with no detour (the streets are already in them); unscaled for a stop within SCALE_MIN_M of
 *                     the origin, where that ratio means nothing. ESTIMATED otherwise: the straight line with m7c's
 *                     default detour (HURRY_DEFAULTS.detour)
 *   requestTargets    the stops one request carries: each stop_id once, the nearest WALK_MAX_TARGETS to the rider
 *   backoffS          the wait after failures in a row: 60, 120, 240, 480, then 600 s
 *   nextWalkCheckS    the instant the gap or the backoff ends, when a request will be due then without a new fix
 */

export const REFRESH_MOVE_M = 150;
export const MIN_REQUEST_GAP_S = 60;
export const BACKOFF_MAX_S = 600;
export const STALE_ORIGIN_M = 300;
/** A stop this close (straight line) to the cache's origin walks its routed metres unscaled: never a ratio over ~0 m. */
export const SCALE_MIN_M = 50;

export type WalkCache = {
  /** Where the rider stood when the walks were asked for. */
  readonly origin: LatLon;
  /** When they were asked for, epoch s (the wall clock). */
  readonly requestedAtS: number;
  /** GTFS stop_id → its walk; a key holding null was asked for, and no walk reaches it. */
  readonly paths: ReadonlyMap<string, WalkPath | null>;
};

/** A platform to walk to, by its GTFS stop_id (a Platform fits). */
export type WalkStop = { readonly stopId: string; readonly latitude: number; readonly longitude: number };

/** What a verdict walks: metres, the detour m7c's engine puts on them, and whether they follow the streets or estimate them. */
export type WalkEstimate = { readonly walkMeters: number; readonly detour: number; readonly source: 'routed' | 'estimated' };

export function needsWalkRequest(cache: WalkCache | null, position: LatLon, nowS: number, wantedStopIds: readonly string[], backoffUntilS: number): boolean {
  invariant(Number.isFinite(nowS) && Number.isFinite(backoffUntilS), 'the policy is asked at an instant, against the instant a backoff ends');
  invariant(isLatLon(position), 'the rider is a real coordinate');
  if (nowS < backoffUntilS || (cache !== null && nowS - cache.requestedAtS < MIN_REQUEST_GAP_S)) {
    return false;
  }
  return cache === null || cacheFallsShort(cache, position, wantedStopIds);
}

/** The cache no longer serves the rider: they are STRICTLY more than REFRESH_MOVE_M from its origin, or a wanted stop has no entry. */
function cacheFallsShort(cache: WalkCache, position: LatLon, wantedStopIds: readonly string[]): boolean {
  invariant(cache.paths.size > 0 && isLatLon(cache.origin), 'a cache holds the answer to a request, asked from a real place for at least one stop');
  invariant(wantedStopIds.every((stopId) => stopId.length > 0), 'a wanted stop is named by its GTFS stop_id');
  return haversineMeters(cache.origin, position) > REFRESH_MOVE_M || wantedStopIds.some((stopId) => !cache.paths.has(stopId));
}

export function walkFor(cache: WalkCache | null, stop: WalkStop, position: LatLon): WalkEstimate {
  invariant(isLatLon(position) && isLatLon(stop), `a walk joins two real coordinates (stop ${stop.stopId})`);
  const straightNow = haversineMeters(position, stop);
  const path = cache === null ? null : (cache.paths.get(stop.stopId) ?? null);
  if (cache === null || path === null || haversineMeters(cache.origin, position) > STALE_ORIGIN_M) {
    return { walkMeters: straightNow, detour: HURRY_DEFAULTS.detour, source: 'estimated' };
  }
  const straightAtOrigin = haversineMeters(cache.origin, stop);
  const walkMeters = straightAtOrigin < SCALE_MIN_M ? path.distanceM : path.distanceM * (straightNow / straightAtOrigin);
  invariant(Number.isFinite(walkMeters) && walkMeters >= 0, `a routed walk to ${stop.stopId} is a real distance, never a ratio over ~0 m`);
  return { walkMeters, detour: 1, source: 'routed' };
}

/** The stops one request carries: each stop_id once (its first registration), nearest the rider first, at most WALK_MAX_TARGETS. */
export function requestTargets(stops: readonly WalkStop[], position: LatLon): WalkStop[] {
  invariant(isLatLon(position), 'targets are ranked from a real position');
  const byId = new Map<string, WalkStop>();
  for (const stop of stops) {
    if (!byId.has(stop.stopId)) {
      byId.set(stop.stopId, stop);
    }
  }
  const ranked = [...byId.values()].map((stop) => ({ stop, metres: haversineMeters(position, stop) })).sort((a, b) => a.metres - b.metres);
  const targets = ranked.slice(0, WALK_MAX_TARGETS).map((entry) => entry.stop);
  const cut = ranked[WALK_MAX_TARGETS];
  invariant(targets.length === Math.min(byId.size, WALK_MAX_TARGETS), 'every distinct stop is asked for, up to the server\'s limit');
  invariant(cut === undefined || ranked.slice(0, WALK_MAX_TARGETS).every((entry) => entry.metres <= cut.metres), 'a stop left out is no nearer than any stop asked for');
  return targets;
}

/** The wait after `failures` failed requests in a row: MIN_REQUEST_GAP_S, doubling, at most BACKOFF_MAX_S. */
export function backoffS(failures: number): number {
  invariant(Number.isSafeInteger(failures) && failures >= 1, `a backoff follows at least one failure, got ${failures}`);
  let wait = MIN_REQUEST_GAP_S;
  for (let i = 1; i < failures && wait < BACKOFF_MAX_S; i += 1) {
    wait *= 2;
  }
  const capped = Math.min(wait, BACKOFF_MAX_S);
  invariant(capped >= MIN_REQUEST_GAP_S && capped <= BACKOFF_MAX_S, 'a backoff waits at least the request gap and at most its cap');
  return capped;
}

/**
 * When to look again without a new trigger: the instant the 60 s gap and the backoff have both ended, when a request
 * will be due then for this rider and these stops; null when only a new fix or a new stop could make one due.
 */
export function nextWalkCheckS(cache: WalkCache | null, position: LatLon, wantedStopIds: readonly string[], backoffUntilS: number): number | null {
  invariant(Number.isFinite(backoffUntilS), 'a backoff ends at an instant');
  invariant(isLatLon(position), 'the rider is a real coordinate');
  const atS = cache === null ? backoffUntilS : Math.max(backoffUntilS, cache.requestedAtS + MIN_REQUEST_GAP_S);
  return cache === null || cacheFallsShort(cache, position, wantedStopIds) ? atS : null;
}
