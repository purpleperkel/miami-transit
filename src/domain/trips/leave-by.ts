import { invariant } from '../../lib/invariant';

/**
 * Plan M7.1 "leave-by": when to leave to make a ride, and which ride a trip card is counting down to.
 *
 *   leaveBy = departure − walk − buffer
 *
 * `buffer` is the margin for being on the platform before the train (the board-buffer setting,
 * src/data/settings-repo.ts). A ride stays the card's ride for LEAVE_GRACE_S after its leave-by —
 * long enough to show "missed" (src/ui/trips/countdown.ts) rather than silently jumping — and then
 * the card rolls to the next ride.
 */

/** How long after its leave-by a ride is still the one shown (then the next ride takes over). */
export const LEAVE_GRACE_S = 30;

/** Anything with a departure instant (epoch seconds): a schedule Ride, a Departure, a test row. */
export type Departing = { readonly depEpoch: number };

export type LeavePlan<R extends Departing> = {
  readonly ride: R;
  /** Epoch second to leave by: ride.depEpoch − walkS − bufferS. */
  readonly leaveByEpoch: number;
};

/** The epoch second to leave by to make a departure: departure − walk − buffer. */
export function leaveByEpoch(departureEpoch: number, walkS: number, bufferS: number): number {
  invariant(Number.isSafeInteger(departureEpoch), `a departure is a whole epoch second, got ${departureEpoch}`);
  invariant(Number.isSafeInteger(walkS) && walkS >= 0 && Number.isSafeInteger(bufferS) && bufferS >= 0, 'walk and buffer are whole, non-negative seconds');
  const leaveBy = departureEpoch - walkS - bufferS;
  invariant(leaveBy <= departureEpoch, 'nobody leaves after the train does');
  return leaveBy;
}

/**
 * The ride a trip counts down to at `now`: the first, in departure order, whose leave-by is not more
 * than LEAVE_GRACE_S in the past. Null when every ride's grace has run out.
 */
export function nextLeave<R extends Departing>(rides: readonly R[], now: number, walkS: number, bufferS: number): LeavePlan<R> | null {
  invariant(Number.isSafeInteger(now), `now is a whole epoch second, got ${now}`);
  invariant(rides.every((r, i) => i === 0 || rides[i - 1]!.depEpoch <= r.depEpoch), 'rides come in departure order');
  for (const ride of rides) {
    const leaveBy = leaveByEpoch(ride.depEpoch, walkS, bufferS);
    if (now - leaveBy <= LEAVE_GRACE_S) {
      return { ride, leaveByEpoch: leaveBy };
    }
  }
  return null;
}
