import type { SavedTrip } from '../../data/saved-trips-repo';
import type { CalendarGap, RidesQueryOutcome, UnknownStation } from '../../data/schedule-repo';
import type { StationListing } from '../../data/schedule-queries';
import { type ServiceDayResolution, type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import type { Ride } from '../../domain/schedule/rides';
import { leaveByEpoch, nextLeave } from '../../domain/trips/leave-by';
import { estimateWalk } from '../../domain/trips/walk-estimate';
import { haversineMeters, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import { formatClockFromServiceSec } from '../format';

/**
 * Plan M7.8: the Trips tab's cards, as data. For each saved trip: the walk to its boarding station, the
 * ride it counts down to (M7.1 nextLeave over the schedule's trip rides — loop-arounds a direct ride
 * beats already dropped, m3a's input) and that ride's leave-by; or why there is no ride to count to.
 * The cards come sorted by leave-by, soonest first; cards with nothing to count to follow, in saved order.
 *
 * ONE walking pace (arbiter ruling 2026-10-01): the walk uses Jamie's pace from Data & Settings
 * (readWalkingPace().walkMps, passed in), never m7a's pure default. The walk is, in order: the trip's
 * own walk minutes; the distance from its saved start; the distance from where the phone is now; else
 * unknown (the countdown then runs to the platform buffer alone, and the card says the walk is missing).
 *
 * At night nothing departs the origin, and the card says `no-service` — never "transfer" (m3a's input):
 * `needs-transfer` is only for a pair no single vehicle joins while trains do run.
 */

/** Rides are looked for this far ahead: a trip more than 3 h out says "no trains now" until it nears. */
export const TRIP_HORIZON_S = 3 * 60 * 60;

/** What the cards read from the schedule (ScheduleRepo fits). */
export type TripSource = {
  stations(): readonly StationListing[];
  serviceDays(window: TimeWindow): ServiceDayResolution;
  tripRides(fromKey: string, toKey: string, window: TimeWindow): Result<RidesQueryOutcome, UnknownStation>;
};

export type TripCardInput = {
  readonly nowS: number;
  /** Jamie's walking pace, m/s (readWalkingPace). */
  readonly walkMps: number;
  /** Seconds on the platform before the train (the trip settings' boardBufferS). */
  readonly bufferS: number;
  /** Where the phone is, for trips that start wherever the rider is; null without a fix. */
  readonly position: LatLon | null;
};

/** Where the walk figure comes from: the trip's own minutes, its saved start, the phone's position now. */
export type TripWalk = { readonly walkS: number; readonly source: 'override' | 'start' | 'here' };

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
  /** The walk to the boarding station; null when nothing tells how far it is. */
  readonly walk: TripWalk | null;
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

/** One trip's card: its walk, then the ride it counts to or why there is none. */
function tripCard(source: TripSource, stations: ReadonlyMap<string, StationListing>, trip: SavedTrip, input: TripCardInput): TripCardModel {
  invariant(trip.fromStationKey !== trip.toStationKey, 'a trip joins two stations');
  const from = stations.get(trip.fromStationKey);
  const to = stations.get(trip.toStationKey);
  const names = { fromName: from?.name ?? trip.fromStationKey, toName: to?.name ?? trip.toStationKey };
  if (from === undefined || to === undefined) {
    return { trip, ...names, walk: null, status: { kind: 'unknown-station', stationKey: from === undefined ? trip.fromStationKey : trip.toStationKey } };
  }
  const walk = tripWalk(trip, from.coordinate, input);
  const status = tripStatus(source, trip, { walkS: walk?.walkS ?? 0, bufferS: input.bufferS }, input.nowS);
  invariant(status.kind !== 'leave' || status.current.leaveByEpoch <= status.current.ride.depEpoch, 'nobody leaves after the train');
  return { trip, ...names, walk, status };
}

/** The walk to the boarding station: the trip's minutes, else from its start, else from here; null when unknown. */
export function tripWalk(trip: SavedTrip, station: LatLon, input: Pick<TripCardInput, 'walkMps' | 'position'>): TripWalk | null {
  invariant(input.walkMps > 0, 'a walking pace moves');
  const from = trip.start ?? input.position;
  const estimate = estimateWalk({ straightMeters: from === null ? null : haversineMeters(from, station), overrideMin: trip.walkOverrideMin, paceMps: input.walkMps });
  if (estimate === null) {
    return null;
  }
  const source = estimate.source === 'override' ? 'override' : trip.start !== null ? 'start' : 'here';
  invariant(Number.isSafeInteger(estimate.walkS) && estimate.walkS >= 0, 'a walk is whole seconds');
  return { walkS: estimate.walkS, source };
}

type Lead = { readonly walkS: number; readonly bufferS: number };

/** The ride the trip counts to now (and the one after it), or why there is none. */
function tripStatus(source: TripSource, trip: SavedTrip, lead: Lead, nowS: number): TripStatus {
  invariant(Number.isSafeInteger(lead.walkS + lead.bufferS) && lead.walkS >= 0 && lead.bufferS >= 0, 'the walk and buffer are whole seconds');
  const window = windowFrom(nowS, TRIP_HORIZON_S);
  const outcome = source.tripRides(trip.fromStationKey, trip.toStationKey, window);
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
  const plan = nextLeave(rides.rides, nowS, lead.walkS, lead.bufferS);
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
