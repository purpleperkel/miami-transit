import type { Station } from '../../src/domain/network/stations';
import { haversineMeters } from '../../src/lib/geo';
import { invariant } from '../../src/lib/invariant';

/**
 * Plan §4 step 12 (M2.13): the station-to-station transfer table.
 *  - Every station transfers to itself in 60 s (changing platforms or direction: Government Center
 *    rail northbound ↔ southbound is one station, so one 60 s change).
 *  - A rail station and a Mover station transfer both ways when their centroids are within 400 m:
 *    the 60 s change plus the walk, rounded up to a whole second. The walk uses the plan's one walk
 *    model (risk R13, M7.1 "1000 m → 1000 s"): haversine × 1.3 for the street detour, at 1.3 m/s.
 *  - Nothing else: no rail↔rail or Mover↔Mover walks between different stations.
 * The table is symmetric by construction, and asserted so.
 */

export const SAME_STATION_TRANSFER_S = 60;
export const MAX_RAIL_MOVER_TRANSFER_M = 400;
/** Streets are longer than the straight line (plan R13). */
export const WALK_DETOUR_FACTOR = 1.3;
export const WALK_SPEED_M_PER_S = 1.3;

export type Transfer = {
  readonly fromKey: string;
  readonly toKey: string;
  readonly seconds: number;
  /** Centroid to centroid, whole metres (0 within a station). */
  readonly distanceM: number;
};

/** The transfer table, sorted by (fromKey, toKey). */
export function buildTransfers(stations: readonly Station[]): Transfer[] {
  invariant(new Set(stations.map((station) => station.key)).size === stations.length, 'station keys are unique');
  const transfers: Transfer[] = stations.map(({ key }) => ({ fromKey: key, toKey: key, seconds: SAME_STATION_TRANSFER_S, distanceM: 0 }));
  const movers = stations.filter((station) => station.mode === 'mover');
  for (const rail of stations.filter((station) => station.mode === 'rail')) {
    for (const mover of movers) {
      const metres = haversineMeters(rail, mover);
      if (metres <= MAX_RAIL_MOVER_TRANSFER_M) {
        const seconds = SAME_STATION_TRANSFER_S + Math.ceil((metres * WALK_DETOUR_FACTOR) / WALK_SPEED_M_PER_S);
        const distanceM = Math.round(metres);
        transfers.push({ fromKey: rail.key, toKey: mover.key, seconds, distanceM }, { fromKey: mover.key, toKey: rail.key, seconds, distanceM });
      }
    }
  }
  transfers.sort((a, b) => compareText(a.fromKey, b.fromKey) || compareText(a.toKey, b.toKey));
  invariant(isSymmetric(transfers), 'every transfer has its reverse, with the same time');
  return transfers;
}

/** True when every (a → b, s) has a matching (b → a, s). */
export function isSymmetric(transfers: readonly Transfer[]): boolean {
  invariant(Array.isArray(transfers), 'a transfer table is a list');
  const seconds = new Map(transfers.map((t) => [`${t.fromKey} ${t.toKey}`, t.seconds]));
  invariant(seconds.size === transfers.length, 'each ordered station pair appears once');
  return transfers.every((t) => seconds.get(`${t.toKey} ${t.fromKey}`) === t.seconds);
}

function compareText(a: string, b: string): number {
  invariant(typeof a === 'string', 'compares text');
  invariant(typeof b === 'string', 'compares text');
  return a < b ? -1 : a > b ? 1 : 0;
}
