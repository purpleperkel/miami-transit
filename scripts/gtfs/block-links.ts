import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { modeOfRoute } from './scope';

/**
 * Plan §4 step 11 (M2.12): link Mover trips through `block_id` into `next_trip_idx`.
 *
 * The county publishes the Inner Loop (14457) as half-trips — Bayfront Park → Government Center,
 * then Government Center → Bayfront Park — chained by block_id, and the Omni/Brickell vehicles
 * (14456) the same way between their legs. A rider stays aboard across those joins, so the ride
 * search (plan §4 "Rides A→B") may follow one `next_trip_idx` hop.
 *
 * A trip links to the next trip of its block (same route, service and block, ordered by start)
 * when that trip starts at the station this one ends at, within MAX_THROUGH_GAP_S. Rail trips are
 * never linked: a Metrorail terminus is where everyone gets off, even when the train runs on.
 * Two trips of one block that overlap in time are a feed error.
 */

/** The longest stand at a join that still counts as one ride (the plan's 10-minute layover window). */
export const MAX_THROUGH_GAP_S = 600;

export type BlockTrip = {
  readonly idx: number;
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly blockId: string;
  readonly startS: number;
  readonly endS: number;
  readonly originKey: string;
  readonly destinationKey: string;
};

/** next_trip_idx for each trip, by trip index (null = the ride ends with the trip). */
export function linkBlocks(trips: readonly BlockTrip[]): Result<(number | null)[], string> {
  invariant(trips.every((trip, i) => trip.idx === i), 'trips are listed by their index');
  const next = new Array<number | null>(trips.length).fill(null);
  for (const [block, members] of moverBlocks(trips)) {
    members.sort((a, b) => a.startS - b.startS || a.idx - b.idx);
    for (let k = 1; k < members.length; k += 1) {
      const before = members[k - 1];
      const after = members[k];
      invariant(before !== undefined && after !== undefined, 'consecutive block members exist');
      if (after.startS < before.endS) {
        return err(`block ${block}: trip ${after.tripId} starts (${after.startS} s) before trip ${before.tripId} ends (${before.endS} s)`);
      }
      if (after.originKey === before.destinationKey && after.startS - before.endS <= MAX_THROUGH_GAP_S) {
        next[before.idx] = after.idx;
      }
    }
  }
  const targets = next.filter((idx) => idx !== null);
  invariant(new Set(targets).size === targets.length, 'no trip continues two trips');
  return ok(next);
}

/** Mover trips grouped by route, service and block (rail and block-less trips are left out). */
function moverBlocks(trips: readonly BlockTrip[]): Map<string, BlockTrip[]> {
  invariant(trips.every((trip) => trip.startS <= trip.endS), 'every trip ends no earlier than it starts');
  const blocks = new Map<string, BlockTrip[]>();
  for (const trip of trips) {
    if (modeOfRoute(trip.routeId) !== 'mover' || trip.blockId === '') {
      continue;
    }
    const key = `${trip.routeId}/${trip.serviceId}/${trip.blockId}`;
    const members = blocks.get(key);
    if (members === undefined) {
      blocks.set(key, [trip]);
    } else {
      members.push(trip);
    }
  }
  invariant([...blocks.values()].every((members) => members.length > 0), 'every block has a trip');
  return blocks;
}
