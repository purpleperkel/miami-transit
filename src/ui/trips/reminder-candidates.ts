import type { SavedTrip } from '../../data/saved-trips-repo';
import { windowFrom } from '../../domain/gtfs/service-day';
import type { Ride } from '../../domain/schedule/rides';
import { leaveByEpoch } from '../../domain/trips/leave-by';
import { REMINDER_HORIZON_S, type ReminderCandidate } from '../../domain/trips/notification-plan';
import { invariant } from '../../lib/invariant';
import type { TripSource } from './trip-card';
import { boardingPlatforms, savedTripWalk } from './trip-walk';

/**
 * Plan M7.4 → M7.5: the rides that earn "leave now" reminders. A saved trip with a reminder schedule
 * (weekdays + its usual departure time, saved-trips-repo.ts) gets one candidate per matching service day
 * within the 7-day horizon: the first trip ride departing at or after the usual time on that day (within
 * REMINDER_SEARCH_S), with its leave-by from the trip's walk at Jamie's pace and the platform buffer.
 * planReminders (notification-plan.ts) then keeps the future ones, soonest first, and the notification
 * service (notifications.ts) schedules them.
 *
 * Only a trip whose walk is FIXED — its own walk minutes, or a saved start — has a leave-by days ahead;
 * a trip that starts "wherever the phone is" does not, so it gets no reminder (the add-trip flow offers
 * reminders only once the walk is fixed). The usual time counts from each service day's own base (local
 * midnight but on the two daylight-saving days, as every clock in the app): no time-zone math.
 *
 * mfix11: the walk is the trip's ONE walk (trip-walk.ts savedTripWalk) with NO position: the trip's own minutes,
 * else the estimate from its saved start to the platform its reminded rides board at, at Jamie's pace. The phone's
 * current or last fix is never used — a reminder days ahead must not walk from wherever the phone last was.
 */

/** A reminder looks this far past the usual time for the trip's first ride. */
export const REMINDER_SEARCH_S = 2 * 60 * 60;

export type ReminderInput = {
  readonly nowS: number;
  /** Jamie's walking pace, m/s (readWalkingPace). */
  readonly walkMps: number;
  /** Seconds on the platform before the train (boardBufferS). */
  readonly bufferS: number;
};

/** Every reminder candidate of the saved trips over the next REMINDER_HORIZON_S. */
export function reminderCandidates(source: TripSource, trips: readonly SavedTrip[], input: ReminderInput): ReminderCandidate[] {
  invariant(Number.isSafeInteger(input.nowS) && input.walkMps > 0, 'candidates are read at a whole second, at a real pace');
  const days = source.serviceDays(windowFrom(input.nowS, REMINDER_HORIZON_S));
  const running = days.kind === 'active' ? days.days : [];
  const candidates: ReminderCandidate[] = [];
  for (const trip of trips) {
    const rides = trip.reminder === null ? [] : remindedRides(source, trip, { running, nowS: input.nowS });
    const walk = rides.length === 0 ? null : savedTripWalk(trip, { platforms: boardingPlatforms(source.platforms(), trip.fromStationKey, rides), position: null, walkMps: input.walkMps });
    if (walk === null) {
      continue;
    }
    for (const ride of rides) {
      candidates.push({ tripId: trip.id, tripName: trip.name, departureEpoch: ride.depEpoch, leaveByEpoch: leaveByEpoch(ride.depEpoch, walk.walkS, input.bufferS) });
    }
  }
  invariant(candidates.every((c) => c.leaveByEpoch <= c.departureEpoch), 'every candidate leaves before its train');
  return candidates;
}

/** Each running service day: its date (YYYYMMDD) and the epoch its clock times count from. */
type RunningDay = { readonly date: number; readonly baseEpoch: number };

/** The ride each reminded day targets: the first at or after the usual time, on every running day the reminder covers. */
function remindedRides(source: TripSource, trip: SavedTrip, at: { readonly running: readonly RunningDay[]; readonly nowS: number }): Ride[] {
  const reminder = trip.reminder;
  invariant(reminder !== null, 'only a trip with a reminder schedule is reminded');
  const rides: Ride[] = [];
  for (const day of at.running.filter((d) => remindsOn(reminder.days, d.date))) {
    const target = day.baseEpoch + reminder.atMin * 60;
    const ride = target + REMINDER_SEARCH_S < at.nowS ? null : firstRide(source, trip, target);
    if (ride !== null) {
      rides.push(ride);
    }
  }
  invariant(new Set(rides.map((ride) => ride.depEpoch)).size === rides.length, 'each reminded day targets its own ride');
  return rides;
}

/** The trip's first ride at or after `target` (within REMINDER_SEARCH_S), or null. */
function firstRide(source: TripSource, trip: SavedTrip, target: number): Ride | null {
  invariant(Number.isSafeInteger(target), 'a target is a whole epoch second');
  const outcome = source.tripRides(trip.fromStationKey, trip.toStationKey, windowFrom(target, REMINDER_SEARCH_S));
  const first = outcome.ok && outcome.value.kind === 'rides' ? (outcome.value.rides[0] ?? null) : null;
  invariant(first === null || first.depEpoch >= target, 'the ride leaves at or after the usual time');
  return first;
}

/** True when the weekday mask (bit 0 Monday … bit 6 Sunday) includes service date `date` (YYYYMMDD). */
export function remindsOn(daysMask: number, date: number): boolean {
  invariant(Number.isSafeInteger(daysMask) && daysMask >= 0 && daysMask <= 0b1111111, `a weekday mask has seven bits, got ${daysMask}`);
  invariant(Number.isSafeInteger(date) && date >= 19700101 && date <= 99991231, `a service date is YYYYMMDD, got ${date}`);
  const weekday = new Date(Date.UTC(Math.floor(date / 10000), (Math.floor(date / 100) % 100) - 1, date % 100)).getUTCDay();
  const mondayFirst = (weekday + 6) % 7;
  return (daysMask & (1 << mondayFirst)) !== 0;
}
