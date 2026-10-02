import { invariant } from '../../lib/invariant';
import type { Ride } from '../schedule/rides';

/**
 * m3a's input to M7 (checked on the real DB 2026-10-01): a ride list includes Metromover
 * loop-arounds — Knight Center → College North, Wed 08:00, lists a 17-min Omni block-hop loop
 * leaving the same minute as a 4-min direct Brickell ride. Nobody takes the loop, so the trip card
 * drops it.
 *
 * The rule: drop a ride only when a DIRECT ride that departs NO EARLIER arrives strictly earlier —
 * waiting for (or boarding) that ride is never worse. A direct ride that departs EARLIER does not
 * count: it may already be gone when the rider reaches the platform, so the later ride still
 * matters (that is why the 5.5-min Inner Loop block-link rides stay).
 */

/** The rides worth offering, in their original order: every ride no later-or-equal-departing direct ride beats on arrival. */
export function dropBeatenRides(rides: readonly Ride[]): Ride[] {
  invariant(rides.every((r, i) => i === 0 || rides[i - 1]!.depEpoch <= r.depEpoch), 'rides come in departure order');
  // Scanning from the last departure back, `bestArrival` is the earliest arrival of any direct ride
  // departing at or after the ride in hand — one bounded pass, no pairwise search.
  const kept: Ride[] = [];
  let bestArrival = Number.POSITIVE_INFINITY;
  let i = rides.length - 1;
  while (i >= 0) {
    const sameDeparture = departureGroup(rides, i);
    for (const ride of sameDeparture) {
      if (!ride.viaBlockLink) {
        bestArrival = Math.min(bestArrival, ride.arrEpoch);
      }
    }
    kept.push(...sameDeparture.filter((ride) => ride.arrEpoch <= bestArrival).reverse());
    i -= sameDeparture.length;
  }
  kept.reverse();
  invariant(kept.length > 0 || rides.length === 0, 'the earliest-arriving ride is never beaten');
  return kept;
}

/** The rides ending at index `last` that share its departure instant, in list order. */
function departureGroup(rides: readonly Ride[], last: number): Ride[] {
  invariant(last >= 0 && last < rides.length, 'the group ends inside the list');
  const depEpoch = rides[last]!.depEpoch;
  let first = last;
  while (first > 0 && rides[first - 1]!.depEpoch === depEpoch) {
    first -= 1;
  }
  const group = rides.slice(first, last + 1);
  invariant(group.length > 0 && group.every((r) => r.depEpoch === depEpoch), 'a group shares one departure');
  return group;
}
