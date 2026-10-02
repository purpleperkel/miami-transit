import { invariant } from '../../lib/invariant';
import type { VehicleState } from './positions';

/**
 * Plan M6.6: the vehicle sheet's next stops — where a vehicle stops next, by the timetable, at most
 * MAX_NEXT_STOPS of them, in time order. Pure: the schedule repo finds the vehicle's trip (its block
 * placement, M3.5) and reads that trip's stops and the trip its car runs next; this module picks them.
 *
 *  - The stops listed are the ones AHEAD of the vehicle: past the last stop it has reached. A vehicle
 *    standing at a stop is there already, so that stop is not "next"; a car parked for its next trip
 *    (a layover) stands at that trip's first stop.
 *  - A trip near its end continues onto the trip its car runs next (`trip.next_trip_idx`): the
 *    Metromover's half-trips and line changes are block-linked; Metrorail trips are not, so a train
 *    ends its list at its terminal. The junction (the last stop of one trip, the first of the next,
 *    the same platform) is listed once, never twice.
 */

/** The vehicle sheet lists at most this many stops. */
export const MAX_NEXT_STOPS = 3;

/** One stop of a trip as the schedule DB lists it (service-day seconds). */
export type RunStop = {
  readonly seq: number;
  readonly stationKey: string;
  readonly name: string;
  readonly arrS: number;
  readonly depS: number;
};

/** A trip's stops in order, and the trip its car runs next (next_trip_idx), if the feed links one. */
export type TripRun = { readonly tripIdx: number; readonly stops: readonly RunStop[]; readonly nextTripIdx: number | null };

export type NextStop = {
  /** The trip the vehicle makes this stop on (the next trip's, once the list has crossed the junction). */
  readonly tripIdx: number;
  readonly stationKey: string;
  readonly name: string;
  /** When the vehicle arrives (epoch s). */
  readonly epoch: number;
  /** The same instant as a service-day second, for its clock time. */
  readonly arrS: number;
};

export type NextStopsInput = {
  /** The service day's base epoch both trips count from. */
  readonly baseEpoch: number;
  /** Now, as a second of that service day. */
  readonly s: number;
  /** The vehicle's state on `current` at `s` (positions.ts blockPlacementAt). */
  readonly state: VehicleState;
  readonly current: TripRun;
  /** The trip `current.nextTripIdx` names, or null when it names none. */
  readonly following: TripRun | null;
};

export function nextStops(input: NextStopsInput): NextStop[] {
  const { current, following } = input;
  invariant(following === null || following.tripIdx === current.nextTripIdx, 'the following trip is the one the current trip links to');
  invariant(isRun(current) && (following === null || isRun(following)), 'each trip lists >= 2 stops in time order');
  const ahead = current.stops.slice(reachedIndex(current, input.s, input.state) + 1).map((stop) => toNextStop(input.baseEpoch, current.tripIdx, stop));
  if (ahead.length < MAX_NEXT_STOPS && following !== null) {
    const junction = current.stops[current.stops.length - 1]?.stationKey;
    const onward = following.stops.filter((stop, i) => i > 0 || stop.stationKey !== junction);
    ahead.push(...onward.map((stop) => toNextStop(input.baseEpoch, following.tripIdx, stop)));
  }
  const stops = ahead.slice(0, MAX_NEXT_STOPS);
  invariant(stops.every((stop, i) => stop.epoch > input.baseEpoch + input.s && (i === 0 || stop.epoch > (stops[i - 1] as NextStop).epoch)), 'next stops lie ahead, in time order');
  return stops;
}

/** The last stop the vehicle has reached at `s`: a parked car stands at its trip's first stop. */
function reachedIndex(run: TripRun, s: number, state: VehicleState): number {
  invariant(Number.isFinite(s), 'now is a service-day second');
  let reached = state === 'layover' ? 0 : -1;
  for (let i = 0; i < run.stops.length; i += 1) {
    if ((run.stops[i] as RunStop).arrS <= s) {
      reached = i;
    }
  }
  invariant(state === 'layover' || reached >= 0, `a running vehicle has reached the first stop of trip ${run.tripIdx}`);
  return reached;
}

/** A trip has at least two stops, numbered 0, 1, 2… and timed strictly forward. */
function isRun(run: TripRun): boolean {
  invariant(Number.isSafeInteger(run.tripIdx) && run.tripIdx >= 0, 'a trip is indexed');
  invariant(run.nextTripIdx === null || run.nextTripIdx !== run.tripIdx, 'a trip never continues onto itself');
  return run.stops.length >= 2 && run.stops.every((stop, i) => stop.seq === i && (i === 0 || stop.arrS > (run.stops[i - 1] as RunStop).depS));
}

function toNextStop(baseEpoch: number, tripIdx: number, stop: RunStop): NextStop {
  invariant(Number.isSafeInteger(baseEpoch), 'a service day has a whole base epoch');
  invariant(stop.stationKey.length > 0 && stop.name.length > 0, 'a stop is at a named station');
  return { tripIdx, stationKey: stop.stationKey, name: stop.name, epoch: baseEpoch + stop.arrS, arrS: stop.arrS };
}
