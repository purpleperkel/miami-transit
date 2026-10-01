import { haversineMeters, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { linesOfRoute } from '../lines/line-catalog';
import type { Mode } from '../network/stations';
import type { ScheduledVehicle } from '../schedule/positions';
import { MATCH_RADIUS_M, MIAMI_BOUNDS, providerConfig } from './constants';
import { type LiveBatch, type LiveVehicle, TRUNK_LINE_IDS } from './types';

/**
 * Plan M4.6 / §4 merge rules 1–5: the vehicles the map shows, from the timetable's scheduled
 * vehicles (M3.5) and the live provider's batch. Pure; thresholds are per provider (§3).
 *   1. Drop live vehicles older than the provider's maximum age (Swiftly 150 s, Transitland 210 s)
 *      or outside the Miami bounding box.
 *   2. Match live to scheduled by trip_id; otherwise greedily by line and distance — the closest
 *      remaining same-line pair first, at most 800 m apart. A trunk vehicle (RAIL_TRUNK / MM_TRUNK,
 *      line unknown) may pair with a scheduled vehicle of either line on its route.
 *   3. A matched vehicle is drawn at its LIVE position, under the scheduled vehicle's key (so a
 *      ghost turning live keeps its marker).
 *   4. An unmatched live vehicle is still shown (key `live:<vehicle id>`).
 *   5. Unmatched scheduled vehicles ("ghosts") of a mode whose live feed is fresh are hidden. A mode's
 *      feed is fresh when its newest kept live vehicle is at most the provider's fresh age (Swiftly
 *      75 s, Transitland 150 s) — judged per mode, because the county's Mover positions are
 *      intermittent while rail is live (§1), and a rail-only feed must not erase the Mover.
 * Rule 6 (predictions) is merge-departures.ts.
 */

export type MergedVehicle = {
  readonly key: string;
  /** live = drawn solid at a live fix; scheduled = a hollow timetable ghost. */
  readonly source: 'live' | 'scheduled';
  readonly mode: Mode;
  readonly lineId: string;
  readonly position: LatLon;
  readonly bearing: number | null;
  /** The live vehicle's trip — or, matched by position, its ghost's — or the ghost's own trip. */
  readonly tripId: string | null;
  /** How a live vehicle found its scheduled counterpart (rule 2), or null. */
  readonly matchedBy: 'trip' | 'position' | null;
  /** Seconds since the live fix (null for a ghost). */
  readonly ageS: number | null;
  readonly live: LiveVehicle | null;
  readonly scheduled: ScheduledVehicle | null;
};

export type VehicleMerge = {
  /** Sorted by key. */
  readonly vehicles: readonly MergedVehicle[];
  /** Modes whose live feed is fresh (rule 5), in mode order. */
  readonly freshModes: readonly Mode[];
  /** Live vehicles rule 1 dropped. */
  readonly dropped: { readonly tooOld: number; readonly outOfBounds: number };
  /** Ghosts rule 5 hid. */
  readonly hiddenGhosts: number;
};

type Match = { readonly live: LiveVehicle; readonly scheduled: ScheduledVehicle; readonly by: 'trip' | 'position' };

const MODES: readonly Mode[] = ['rail', 'mover'];

export function mergeVehicles(scheduled: readonly ScheduledVehicle[], live: LiveBatch<LiveVehicle> | null, nowS: number): VehicleMerge {
  invariant(Number.isFinite(nowS), 'a merge happens at an instant');
  invariant(new Set(scheduled.map((s) => s.vehicleKey)).size === scheduled.length, 'scheduled vehicle keys are unique');
  const kept = keepLive(live, nowS);
  const matches = matchVehicles(scheduled, kept.vehicles);
  const freshModes = live === null ? [] : MODES.filter((mode) => kept.vehicles.some((v) => v.mode === mode && nowS - v.timestamp <= providerConfig(live.provider).freshS));
  const matchedLive = new Map(matches.map((m) => [m.live.vehicleId, m]));
  const matchedGhosts = new Set(matches.map((m) => m.scheduled.vehicleKey));
  const vehicles: MergedVehicle[] = kept.vehicles.map((v) => liveVehicle(v, matchedLive.get(v.vehicleId) ?? null, nowS));
  let hiddenGhosts = 0;
  for (const ghost of scheduled) {
    if (matchedGhosts.has(ghost.vehicleKey)) {
      continue; // replaced by its live vehicle (rule 3)
    }
    if (freshModes.includes(ghost.mode)) {
      hiddenGhosts += 1; // rule 5
    } else {
      vehicles.push(ghostVehicle(ghost));
    }
  }
  vehicles.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  invariant(vehicles.every((v, i) => i === 0 || (vehicles[i - 1]?.key ?? '') < v.key), 'one merged vehicle per key');
  return { vehicles, freshModes, dropped: { tooOld: kept.tooOld, outOfBounds: kept.outOfBounds }, hiddenGhosts };
}

/** Rule 1: the batch's vehicles no older than the provider's max age and inside the Miami box. */
function keepLive(live: LiveBatch<LiveVehicle> | null, nowS: number): { vehicles: LiveVehicle[]; tooOld: number; outOfBounds: number } {
  invariant(Number.isFinite(nowS), 'ages are measured at an instant');
  if (live === null) {
    return { vehicles: [], tooOld: 0, outOfBounds: 0 };
  }
  const { maxAgeS } = providerConfig(live.provider);
  const tooOld = live.items.filter((v) => nowS - v.timestamp > maxAgeS);
  const outOfBounds = live.items.filter((v) => nowS - v.timestamp <= maxAgeS && !inMiami(v.position));
  const vehicles = live.items.filter((v) => nowS - v.timestamp <= maxAgeS && inMiami(v.position));
  invariant(vehicles.length + tooOld.length + outOfBounds.length === live.items.length, 'every live vehicle is kept or counted');
  return { vehicles, tooOld: tooOld.length, outOfBounds: outOfBounds.length };
}

function inMiami(point: LatLon): boolean {
  invariant(Number.isFinite(point.latitude) && Number.isFinite(point.longitude), 'a fix is a coordinate');
  const inside = point.latitude >= MIAMI_BOUNDS.south && point.latitude <= MIAMI_BOUNDS.north && point.longitude >= MIAMI_BOUNDS.west && point.longitude <= MIAMI_BOUNDS.east;
  invariant(!inside || (point.latitude !== 0 && point.longitude !== 0), 'a 0,0 fix is never inside the Miami box');
  return inside;
}

/** Rule 2: by trip_id first, then greedily by line and distance (closest pair first, ≤ 800 m). */
function matchVehicles(scheduled: readonly ScheduledVehicle[], live: readonly LiveVehicle[]): Match[] {
  invariant(new Set(live.map((v) => v.vehicleId)).size === live.length, 'live vehicle ids are unique');
  const byTrip = new Map<string, ScheduledVehicle>();
  for (const ghost of scheduled) {
    if (!byTrip.has(ghost.tripId)) {
      byTrip.set(ghost.tripId, ghost);
    }
  }
  const matches: Match[] = [];
  const [takenGhosts, takenLive] = [new Set<string>(), new Set<string>()];
  const take = (match: Match): void => {
    invariant(!takenGhosts.has(match.scheduled.vehicleKey), 'a ghost is matched at most once');
    invariant(!takenLive.has(match.live.vehicleId), 'a live vehicle is matched at most once');
    matches.push(match);
    takenGhosts.add(match.scheduled.vehicleKey);
    takenLive.add(match.live.vehicleId);
  };
  for (const vehicle of live) {
    const ghost = vehicle.tripId === null ? undefined : byTrip.get(vehicle.tripId);
    if (ghost !== undefined && !takenGhosts.has(ghost.vehicleKey)) {
      take({ live: vehicle, scheduled: ghost, by: 'trip' });
    }
  }
  const pairs = nearbyPairs(live.filter((v) => !takenLive.has(v.vehicleId)), scheduled.filter((g) => !takenGhosts.has(g.vehicleKey)));
  for (const pair of pairs) {
    if (!takenGhosts.has(pair.scheduled.vehicleKey) && !takenLive.has(pair.live.vehicleId)) {
      take({ live: pair.live, scheduled: pair.scheduled, by: 'position' });
    }
  }
  invariant(new Set(matches.map((m) => m.scheduled.vehicleKey)).size === matches.length, 'each ghost matches at most one live vehicle');
  return matches;
}

/** Every same-line (live, scheduled) pair at most MATCH_RADIUS_M apart, closest first (ties by id, then key). */
function nearbyPairs(live: readonly LiveVehicle[], ghosts: readonly ScheduledVehicle[]): { live: LiveVehicle; scheduled: ScheduledVehicle; metres: number }[] {
  invariant(live.every((v) => v.vehicleId.length > 0), 'live vehicles have ids');
  const pairs: { live: LiveVehicle; scheduled: ScheduledVehicle; metres: number }[] = [];
  for (const vehicle of live) {
    for (const ghost of ghosts) {
      const metres = sameLine(vehicle, ghost) ? haversineMeters(vehicle.position, ghost.position) : Infinity;
      if (metres <= MATCH_RADIUS_M) {
        pairs.push({ live: vehicle, scheduled: ghost, metres });
      }
    }
  }
  pairs.sort((a, b) => a.metres - b.metres || cmp(a.live.vehicleId, b.live.vehicleId) || cmp(a.scheduled.vehicleKey, b.scheduled.vehicleKey));
  invariant(pairs.every((p) => p.metres <= MATCH_RADIUS_M), `every candidate pair lies within ${MATCH_RADIUS_M} m`);
  return pairs;
}

/** The same line — or a trunk vehicle (line unknown) and any line of its route. */
function sameLine(vehicle: LiveVehicle, ghost: ScheduledVehicle): boolean {
  invariant(vehicle.lineId.length > 0 && ghost.lineId.length > 0, 'both vehicles carry a line');
  const trunk = (TRUNK_LINE_IDS as readonly string[]).includes(vehicle.lineId);
  const same = vehicle.lineId === ghost.lineId || (trunk && linesOfRoute(vehicle.routeId).some((line) => line.id === ghost.lineId));
  invariant(!same || vehicle.mode === ghost.mode, 'matching lines share a mode');
  return same;
}

/** Rules 3 and 4: a live vehicle at its live fix, under its ghost's key when matched. */
function liveVehicle(vehicle: LiveVehicle, match: Match | null, nowS: number): MergedVehicle {
  invariant(match === null || match.live === vehicle, 'a match belongs to this vehicle');
  const merged: MergedVehicle = {
    key: match === null ? `live:${vehicle.vehicleId}` : match.scheduled.vehicleKey,
    source: 'live',
    mode: vehicle.mode,
    lineId: vehicle.lineId,
    position: vehicle.position,
    bearing: vehicle.bearing,
    tripId: vehicle.tripId ?? match?.scheduled.tripId ?? null,
    matchedBy: match?.by ?? null,
    ageS: Math.max(0, nowS - vehicle.timestamp),
    live: vehicle,
    scheduled: match?.scheduled ?? null,
  };
  invariant(merged.position === vehicle.position, 'live position wins (rule 3)');
  return merged;
}

function ghostVehicle(ghost: ScheduledVehicle): MergedVehicle {
  invariant(ghost.vehicleKey.length > 0, 'a ghost has a key');
  const merged: MergedVehicle = {
    key: ghost.vehicleKey,
    source: 'scheduled',
    mode: ghost.mode,
    lineId: ghost.lineId,
    position: ghost.position,
    bearing: null,
    tripId: ghost.tripId,
    matchedBy: null,
    ageS: null,
    live: null,
    scheduled: ghost,
  };
  invariant(merged.source === 'scheduled' && merged.live === null, 'a ghost has no live data');
  return merged;
}

function cmp(a: string, b: string): number {
  invariant(typeof a === 'string' && typeof b === 'string', 'string comparison');
  const order = a < b ? -1 : a > b ? 1 : 0;
  invariant(order !== 0 || a === b, 'only equal strings compare equal');
  return order;
}
