import { invariant } from '../../lib/invariant';

/**
 * Plan M7.9 "Add-trip flow": which destinations a saved trip may have from its boarding station. A saved
 * trip counts down to ONE ride (src/domain/trips/leave-by.ts), so its destination must be reachable
 * without changing vehicles somewhere in the timetable; every other station is excluded with the reason
 * `needs-transfer` — that journey belongs to route options (M10), not to a single-ride countdown.
 *
 * Pure: the schedule repo reads which station keys the origin reaches directly
 * (schedule-queries.ts readDirectStationKeys); this module splits the station list by that set,
 * keeping the list's own order in both halves.
 */

/** Why a station cannot be a saved trip's destination from this origin. */
export type ExclusionReason = 'needs-transfer';

export type Excluded<S> = { readonly station: S; readonly reason: ExclusionReason };

export type DirectReach<S> = {
  readonly fromKey: string;
  /** Destinations one vehicle reaches from the origin, in the station list's order. */
  readonly direct: readonly S[];
  /** Every other station (the origin itself left out), with why it is excluded. */
  readonly excluded: readonly Excluded<S>[];
};

/** Splits `stations` (the origin left out) into the ones in `directKeys` and the excluded rest. */
export function partitionReachable<S extends { readonly stationKey: string }>(fromKey: string, stations: readonly S[], directKeys: ReadonlySet<string>): DirectReach<S> {
  invariant(stations.some((s) => s.stationKey === fromKey), `the origin ${fromKey} is one of the stations`);
  invariant(!directKeys.has(fromKey), 'the origin is never its own destination');
  const direct: S[] = [];
  const excluded: Excluded<S>[] = [];
  for (const station of stations) {
    if (station.stationKey === fromKey) {
      continue;
    }
    if (directKeys.has(station.stationKey)) {
      direct.push(station);
    } else {
      excluded.push({ station, reason: 'needs-transfer' });
    }
  }
  invariant(direct.length + excluded.length === stations.length - 1, 'every station but the origin lands in exactly one half');
  return { fromKey, direct, excluded };
}
