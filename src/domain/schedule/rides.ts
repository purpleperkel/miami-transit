import { invariant } from '../../lib/invariant';
import { isTimeWindow, type ServiceDay, type TimeWindow } from '../gtfs/service-day';

/**
 * Plan §4 "On-device engine — Rides A→B" (M3.4): the scheduled rides from one station to another
 * without changing vehicles. Pure: the schedule repo fetches each running service day's candidate
 * (boarding, alighting) pairs, this module picks and orders them.
 *
 * A ride boards a trip at A and alights at B either later on the SAME trip, or on the trip its
 * vehicle runs next (one hop along `trip.next_trip_idx`). The hop is how the Metromover's loops
 * work: the county publishes each loop as half-trips (the Inner Loop's two halves meet at
 * Government Center and Bayfront Park; Omni and Brickell legs chain through each other), and a
 * rider stays aboard across the seam. Rail termini never link, so rail rides are always direct.
 *
 * When nothing boards in the window, the outcome is `needs-transfer`: the app hands the trip to
 * Apple Maps until the M10 planner can route transfers itself.
 */

/** A (boarding at A, alighting at B) pair for one trip boarding, as the schedule DB yields it (service-day seconds). */
export type RideCandidate = {
  readonly boardTripIdx: number;
  readonly boardSeq: number;
  /** The boarding trip's final position: boarding there is never a ride (the trip ends). */
  readonly boardLastSeq: number;
  readonly boardDepS: number;
  readonly boardStopId: string;
  readonly lineId: string;
  /** The trip the rider is on when reaching B: the boarding trip, or its next_trip_idx. */
  readonly alightTripIdx: number;
  readonly alightSeq: number;
  readonly alightArrS: number;
  readonly alightStopId: string;
  readonly alightLineId: string;
  /** True when B is reached on the vehicle's NEXT trip (one next_trip_idx hop). */
  readonly viaBlockLink: boolean;
};

/** The candidates fetched for one running service day. */
export type ServiceDayRideCandidates = { readonly day: ServiceDay; readonly candidates: readonly RideCandidate[] };

export type Ride = {
  /** The service day (YYYYMMDD) both legs belong to. */
  readonly serviceDate: number;
  readonly boardTripIdx: number;
  readonly alightTripIdx: number;
  readonly viaBlockLink: boolean;
  readonly lineId: string;
  readonly alightLineId: string;
  readonly boardStopId: string;
  readonly alightStopId: string;
  /** Absolute epoch seconds (the service day's base_epoch + service-day seconds). */
  readonly depEpoch: number;
  readonly arrEpoch: number;
};

export type RidesOutcome =
  | { readonly kind: 'rides'; readonly rides: readonly Ride[] }
  /** No ride boards in the window without changing vehicles: hand the trip to Apple Maps (M10 plans it on device). */
  | { readonly kind: 'needs-transfer' };

/**
 * The rides boarding at A inside `window`, earliest departure first (ties: earliest arrival).
 * Each trip boarding yields one ride: the direct alighting if the trip itself reaches B, else the
 * earliest alighting after the block hop.
 */
export function assembleRides(window: TimeWindow, days: readonly ServiceDayRideCandidates[]): Ride[] {
  invariant(isTimeWindow(window), 'assembleRides needs a valid window');
  invariant(days.every((d, i) => i === 0 || days[i - 1]!.day.date < d.day.date), 'service days come in date order, each once');
  const rides: Ride[] = [];
  for (const { day, candidates } of days) {
    for (const candidate of bestPerBoarding(candidates)) {
      const ride = toRide(day, candidate);
      if (ride.depEpoch >= window.fromEpoch && ride.depEpoch <= window.toEpoch) {
        rides.push(ride);
      }
    }
  }
  rides.sort((a, b) => a.depEpoch - b.depEpoch || a.arrEpoch - b.arrEpoch || a.boardTripIdx - b.boardTripIdx);
  invariant(rides.every((r, i) => i === 0 || rides[i - 1]!.depEpoch <= r.depEpoch), 'rides are in departure order');
  return rides;
}

/** Rides if any board in the window; otherwise the trip needs a transfer. */
export function judgeRides(rides: readonly Ride[]): RidesOutcome {
  invariant(Array.isArray(rides), 'judgeRides takes the assembled ride list');
  invariant(rides.every((r) => r.arrEpoch >= r.depEpoch), 'no ride arrives before it departs');
  return rides.length > 0 ? { kind: 'rides', rides } : { kind: 'needs-transfer' };
}

/** One candidate per boarding (trip + position): direct beats a block hop; then the earliest arrival. */
function bestPerBoarding(candidates: readonly RideCandidate[]): RideCandidate[] {
  invariant(candidates.every(isRideCandidate), 'every candidate boards before it alights');
  const best = new Map<string, RideCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.boardTripIdx}:${candidate.boardSeq}`;
    const held = best.get(key);
    if (held === undefined || betterCandidate(candidate, held)) {
      best.set(key, candidate);
    }
  }
  invariant(best.size <= candidates.length, 'picking never invents candidates');
  return [...best.values()];
}

function betterCandidate(a: RideCandidate, b: RideCandidate): boolean {
  invariant(a.boardTripIdx === b.boardTripIdx && a.boardSeq === b.boardSeq, 'only candidates of one boarding compete');
  invariant(a.boardDepS === b.boardDepS, 'one boarding has one departure time');
  if (a.viaBlockLink !== b.viaBlockLink) {
    return !a.viaBlockLink;
  }
  return a.alightArrS < b.alightArrS;
}

/** A candidate's shape is a ride: it boards before the trip ends, and the alighting is downstream. */
function isRideCandidate(c: RideCandidate): boolean {
  invariant(Number.isInteger(c.boardSeq) && Number.isInteger(c.alightSeq), 'stop positions are integers');
  invariant(Number.isInteger(c.boardDepS) && Number.isInteger(c.alightArrS), 'times are whole service-day seconds');
  const boardsBeforeTheEnd = c.boardSeq < c.boardLastSeq;
  const downstream = c.viaBlockLink ? c.alightTripIdx !== c.boardTripIdx : c.alightTripIdx === c.boardTripIdx && c.alightSeq > c.boardSeq;
  // Times never decrease along a trip (verify-db "times are monotone"; equal minutes are allowed),
  // and a vehicle's next trip starts no earlier than its last one ends (the M2.12 block linker,
  // scripts/gtfs/block-links.ts, refuses to build otherwise).
  return boardsBeforeTheEnd && downstream && c.alightArrS >= c.boardDepS;
}

function toRide(day: ServiceDay, c: RideCandidate): Ride {
  invariant(Number.isSafeInteger(day.baseEpoch), `service day ${day.date} has a whole base epoch`);
  invariant(c.alightArrS >= c.boardDepS, `the ride on trip ${c.boardTripIdx} does not arrive before it departs`);
  return {
    serviceDate: day.date,
    boardTripIdx: c.boardTripIdx,
    alightTripIdx: c.alightTripIdx,
    viaBlockLink: c.viaBlockLink,
    lineId: c.lineId,
    alightLineId: c.alightLineId,
    boardStopId: c.boardStopId,
    alightStopId: c.alightStopId,
    depEpoch: day.baseEpoch + c.boardDepS,
    arrEpoch: day.baseEpoch + c.alightArrS,
  };
}
