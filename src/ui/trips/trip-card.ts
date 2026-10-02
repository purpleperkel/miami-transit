import type { SavedTrip } from '../../data/saved-trips-repo';
import type { CalendarGap, RidesQueryOutcome, UnknownStation } from '../../data/schedule-repo';
import type { StationListing } from '../../data/schedule-queries';
import { type ServiceDayResolution, type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import type { Platform } from '../../domain/hurry/platform';
import type { Ride } from '../../domain/schedule/rides';
import { leaveByEpoch, nextLeave } from '../../domain/trips/leave-by';
import type { WalkTo } from '../../domain/walk/walk-cache';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import { formatClockFromServiceSec } from '../format';
import { boardingPlatforms, savedTripWalk, type SavedTripWalk } from './trip-walk';

/**
 * Plan M7.8: the Trips tab's cards, as data. For each saved trip: the walk to its boarding station, the
 * ride it counts down to (M7.1 nextLeave over the schedule's trip rides — loop-arounds a direct ride
 * beats already dropped, m3a's input) and that ride's leave-by; or why there is no ride to count to.
 * The cards come sorted by leave-by, soonest first; cards with nothing to count to follow, in saved order.
 *
 * ONE walking pace (arbiter ruling 2026-10-01): the walk uses Jamie's pace from Data & Settings
 * (readWalkingPace().walkMps, passed in), never m7a's pure default. ONE walk (mfix11): the walk is the trip's
 * own, decided by trip-walk.ts savedTripWalk to the platform its rides board at — the trip's own walk minutes,
 * else the street walk from the rider (mfix9's useWalkTo, passed in as `walk`), else the estimate from the
 * rider or, with no fix, from the saved start; else unknown (the countdown then runs to the platform buffer
 * alone, and the card says the walk is missing). The Now bar's verdict walks the same walk.
 *
 * At night nothing departs the origin, and the card says `no-service` — never "transfer" (m3a's input):
 * `needs-transfer` is only for a pair no single vehicle joins while trains do run.
 */

/** Rides are looked for this far ahead: a trip more than 3 h out says "no trains now" until it nears. */
export const TRIP_HORIZON_S = 3 * 60 * 60;

/** What the cards read from the schedule (ScheduleRepo fits). */
export type TripSource = {
  stations(): readonly StationListing[];
  platforms(): readonly Platform[];
  serviceDays(window: TimeWindow): ServiceDayResolution;
  tripRides(fromKey: string, toKey: string, window: TimeWindow): Result<RidesQueryOutcome, UnknownStation>;
};

export type TripCardInput = {
  readonly nowS: number;
  /** Jamie's walking pace, m/s (readWalkingPace). */
  readonly walkMps: number;
  /** Seconds on the platform before the train (the trip settings' boardBufferS). */
  readonly bufferS: number;
  /** The rider's latest fix, where a walk starts; null without one. */
  readonly position: LatLon | null;
  /** mfix9's useWalkTo over the trips' origin platforms: the street walk from the rider, when one is known. */
  readonly walk?: WalkTo;
};

/** One ride a card can count to, with its times as clocks (the schedule's own service-day bases). */
export type TimedRide = {
  readonly ride: Ride;
  readonly leaveByEpoch: number;
  readonly leaveClock: string;
  readonly departClock: string;
  readonly arriveClock: string;
};

export type TripStatus =
  | { readonly kind: 'leave'; readonly current: TimedRide; readonly next: TimedRide | null }
  | { readonly kind: 'needs-transfer' }
  | { readonly kind: 'no-service' }
  /** Rides run, but with this walk none can still be made within TRIP_HORIZON_S. */
  | { readonly kind: 'out-of-reach' }
  | { readonly kind: 'gap'; readonly gap: CalendarGap }
  | { readonly kind: 'unknown-station'; readonly stationKey: string };

export type TripCardModel = {
  readonly trip: SavedTrip;
  /** The stations' display names (the keys themselves for a station the timetable no longer has). */
  readonly fromName: string;
  readonly toName: string;
  /** The trip's one walk (savedTripWalk); null when nothing tells how far it is. */
  readonly walk: SavedTripWalk | null;
  readonly status: TripStatus;
};

/** Every saved trip's card at `input.nowS`, sorted by leave-by (soonest first), then the rest in saved order. */
export function tripCards(source: TripSource, trips: readonly SavedTrip[], input: TripCardInput): TripCardModel[] {
  invariant(Number.isSafeInteger(input.nowS), 'cards are read at a whole second');
  invariant(input.walkMps > 0 && Number.isSafeInteger(input.bufferS) && input.bufferS >= 0, 'a pace and a whole-second buffer');
  const stations = new Map(source.stations().map((station) => [station.stationKey, station] as const));
  const cards = trips.map((trip) => tripCard(source, stations, trip, input));
  const sorted = sortByLeaveAt(cards);
  invariant(sorted.length === trips.length, 'one card per saved trip');
  return sorted;
}

/** Cards with a ride by leave-by (ties: departure, then name); cards without one after them, in their given order. */
export function sortByLeaveAt(cards: readonly TripCardModel[]): TripCardModel[] {
  invariant(cards.every((card) => card.trip.id.length > 0), 'every card is a saved trip');
  const timed = cards.filter((card) => card.status.kind === 'leave');
  const untimed = cards.filter((card) => card.status.kind !== 'leave');
  timed.sort((a, b) => leaveAt(a) - leaveAt(b) || departAt(a) - departAt(b) || (a.trip.name < b.trip.name ? -1 : a.trip.name > b.trip.name ? 1 : 0));
  const sorted = [...timed, ...untimed];
  invariant(sorted.every((card, i) => i === 0 || card.status.kind !== 'leave' || leaveAt(sorted[i - 1]!) <= leaveAt(card)), 'timed cards are in leave-by order');
  return sorted;
}

/** The leave-by a card counts to (cards without a ride sort after every timed one). */
export function leaveAt(card: TripCardModel): number {
  invariant(typeof card.status.kind === 'string', 'a card has a status');
  const at = card.status.kind === 'leave' ? card.status.current.leaveByEpoch : Number.POSITIVE_INFINITY;
  invariant(at === Number.POSITIVE_INFINITY || Number.isSafeInteger(at), 'a leave-by is a whole epoch second');
  return at;
}

function departAt(card: TripCardModel): number {
  invariant(card.status.kind === 'leave', 'only a timed card has a departure');
  const at = card.status.current.ride.depEpoch;
  invariant(Number.isSafeInteger(at), 'a departure is a whole epoch second');
  return at;
}

/** One trip's card: its rides, its one walk to the platform they board at, then the ride it counts to or why there is none. */
function tripCard(source: TripSource, stations: ReadonlyMap<string, StationListing>, trip: SavedTrip, input: TripCardInput): TripCardModel {
  invariant(trip.fromStationKey !== trip.toStationKey, 'a trip joins two stations');
  const from = stations.get(trip.fromStationKey);
  const to = stations.get(trip.toStationKey);
  const names = { fromName: from?.name ?? trip.fromStationKey, toName: to?.name ?? trip.toStationKey };
  if (from === undefined || to === undefined) {
    return { trip, ...names, walk: null, status: { kind: 'unknown-station', stationKey: from === undefined ? trip.fromStationKey : trip.toStationKey } };
  }
  const window = windowFrom(input.nowS, TRIP_HORIZON_S);
  const outcome = source.tripRides(trip.fromStationKey, trip.toStationKey, window);
  const rides = outcome.ok && outcome.value.kind === 'rides' ? outcome.value.rides : [];
  const platforms = boardingPlatforms(source.platforms(), trip.fromStationKey, rides);
  const walk = savedTripWalk(trip, { platforms, position: input.position, walkMps: input.walkMps, walk: input.walk });
  const status = tripStatus(source, outcome, { walkS: walk?.walkS ?? 0, bufferS: input.bufferS }, window);
  invariant(status.kind !== 'leave' || status.current.leaveByEpoch <= status.current.ride.depEpoch, 'nobody leaves after the train');
  return { trip, ...names, walk, status };
}

type Lead = { readonly walkS: number; readonly bufferS: number };

/** The ride the trip counts to from the start of `window` (and the one after it), or why there is none. */
function tripStatus(source: TripSource, outcome: Result<RidesQueryOutcome, UnknownStation>, lead: Lead, window: TimeWindow): TripStatus {
  invariant(Number.isSafeInteger(lead.walkS + lead.bufferS) && lead.walkS >= 0 && lead.bufferS >= 0, 'the walk and buffer are whole seconds');
  if (!outcome.ok) {
    return { kind: 'unknown-station', stationKey: outcome.error.stationKey };
  }
  const rides = outcome.value;
  if (rides.kind === 'needs-transfer' || rides.kind === 'no-service') {
    return { kind: rides.kind };
  }
  if (rides.kind !== 'rides') {
    return { kind: 'gap', gap: rides };
  }
  invariant(rides.rides.every((ride) => ride.depEpoch >= window.fromEpoch && ride.depEpoch <= window.toEpoch), 'the trip rides are the window\'s');
  const plan = nextLeave(rides.rides, window.fromEpoch, lead.walkS, lead.bufferS);
  if (plan === null) {
    return { kind: 'out-of-reach' };
  }
  const bases = runningBases(source, window);
  const after = rides.rides[rides.rides.indexOf(plan.ride) + 1];
  invariant(rides.rides.includes(plan.ride), 'the ride counted to is one of the trip rides');
  const next = after === undefined ? null : timed(after, leaveByEpoch(after.depEpoch, lead.walkS, lead.bufferS), bases);
  return { kind: 'leave', current: timed(plan.ride, plan.leaveByEpoch, bases), next };
}

/** service date → base epoch for the days running in the window (a clock time counts from its day's base). */
function runningBases(source: TripSource, window: TimeWindow): ReadonlyMap<number, number> {
  const days = source.serviceDays(window);
  invariant(days.kind === 'active', 'a window with rides has running service days');
  const bases = new Map(days.days.map((day) => [day.date, day.baseEpoch] as const));
  invariant(bases.size > 0, 'some service day runs');
  return bases;
}

function timed(ride: Ride, leaveBy: number, bases: ReadonlyMap<number, number>): TimedRide {
  const base = bases.get(ride.serviceDate);
  invariant(base !== undefined, `service day ${ride.serviceDate} of the ride is running`);
  invariant(leaveBy <= ride.depEpoch, 'the leave-by comes before the train');
  return {
    ride,
    leaveByEpoch: leaveBy,
    leaveClock: formatClockFromServiceSec(leaveBy - base),
    departClock: formatClockFromServiceSec(ride.depEpoch - base),
    arriveClock: formatClockFromServiceSec(ride.arrEpoch - base),
  };
}
