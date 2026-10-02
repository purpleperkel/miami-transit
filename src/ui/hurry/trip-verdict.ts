import type { DeparturesOutcome, RidesQueryOutcome, UnknownStation } from '../../data/schedule-repo';
import { type ServiceDayResolution, type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import { hurryDepartures } from '../../domain/hurry/board';
import { nearestPlatform, type Platform } from '../../domain/hurry/platform';
import { type HurryDeparture, hurryVerdict, type HurryVerdict } from '../../domain/hurry/verdict';
import { mergeDepartures } from '../../domain/live/merge-departures';
import type { LiveBatch, LivePrediction } from '../../domain/live/types';
import type { Departure } from '../../domain/schedule/departures';
import type { Ride } from '../../domain/schedule/rides';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import type { WalkingPace } from '../settings/walking-pace';
import { TRIP_HORIZON_S } from '../trips/trip-card';
import type { HurryCopyContext } from './copy';
import { clockFor, liveIsStale } from './hurry-reading';

/**
 * mfix8 (decision.miami_transit_bar_uses_saved_trips; Jamie, 2026-10-02: "By biggest gripe is how it says 'not
 * worth it next in 10 min fifth street' without me even entering where I wanna go"): hurry or chill for a
 * SAVED TRIP — the pure half of the Now bar's verdict. Only trains that take the rider where the trip goes count:
 *
 *   rides    the schedule's tripRides(from, to) over the trip card's own horizon (TRIP_HORIZON_S), departing
 *            from now on — never the other direction, never a train that does not reach the destination
 *   live     m4a's merge over those rides' boarding departures, fed ONLY the predictions for those very GTFS
 *            trips (a prediction for another trip — the other direction, another station — never moves a
 *            ride); a canceled ride drops out (board.ts); live data past its provider's fresh limit is stale
 *   walk     the straight line from the rider to the nearest of the rides' boarding platforms, which m7c's
 *            engine turns into a walk with its 1.3 detour at Jamie's paces: an ESTIMATE, and the bar says so
 *   verdict  m7c's hurryVerdict over those departures
 *
 * Null when the schedule cannot judge the trip now — a station it does not know, a pair that needs a transfer,
 * or no timetable. When nothing leaves the origin (night) the verdict is NO_SERVICE.
 */

export type TripVerdict = {
  readonly verdict: HurryVerdict;
  readonly ctx: HurryCopyContext;
  /** Straight-line metres to the boarding platform; the verdict's walk is this with the engine's detour. */
  readonly walkMeters: number;
};

/** What the trip verdict reads from the schedule (ScheduleRepo fits). */
export type TripVerdictSource = {
  platforms(): readonly Platform[];
  serviceDays(window: TimeWindow): ServiceDayResolution;
  departures(stationKey: string, window: TimeWindow): Result<DeparturesOutcome, UnknownStation>;
  tripRides(fromKey: string, toKey: string, window: TimeWindow): Result<RidesQueryOutcome, UnknownStation>;
};

export type TripVerdictInput = {
  /** The trip's origin and destination stations. */
  readonly from: string;
  readonly to: string;
  readonly position: LatLon;
  readonly nowS: number;
  readonly pace: WalkingPace;
  /** The origin station's latest live predictions, or null. */
  readonly batch: LiveBatch<LivePrediction> | null;
};

export function tripVerdict(source: TripVerdictSource, input: TripVerdictInput): TripVerdict | null {
  invariant(input.from !== input.to && input.from.includes(':') && input.to.includes(':'), 'a trip joins two stations keyed mode:name');
  invariant(Number.isSafeInteger(input.nowS), 'a trip is judged at a whole second');
  const window = windowFrom(input.nowS, TRIP_HORIZON_S);
  const outcome = source.tripRides(input.from, input.to, window);
  if (!outcome.ok || (outcome.value.kind !== 'rides' && outcome.value.kind !== 'no-service')) {
    return null;
  }
  const rides = outcome.value.kind === 'rides' ? outcome.value.rides.filter((ride) => ride.depEpoch >= input.nowS) : [];
  const boards = new Set(rides.map((ride) => ride.boardStopId));
  const platforms = source.platforms().filter((platform) => (boards.size > 0 ? boards.has(platform.stopId) : platform.stationKey === input.from));
  const nearest = nearestPlatform(input.position, platforms, null);
  invariant(nearest !== null, `${input.from} has a platform to walk to`);
  const days = source.serviceDays(window);
  invariant(days.kind === 'active', 'a window the schedule has rides for, or nothing leaving in, has running service days');
  const departures = rideDepartures(source, rides, input, window);
  const verdict = hurryVerdict({ now: input.nowS, walkMeters: nearest.walkMeters, departures, ...input.pace });
  return { verdict, ctx: { now: input.nowS, clock: clockFor(days.days.map((day) => day.baseEpoch)) }, walkMeters: nearest.walkMeters };
}

/** The rides' boarding departures, each moved by its OWN trip's live prediction (m4a's merge): boardable, still to come, earliest first. */
function rideDepartures(source: TripVerdictSource, rides: readonly Ride[], input: TripVerdictInput, window: TimeWindow): HurryDeparture[] {
  invariant(rides.every((ride) => ride.depEpoch >= window.fromEpoch && ride.depEpoch <= window.toEpoch), 'every ride boards inside the window');
  if (rides.length === 0) {
    return [];
  }
  const scheduled = boardingDepartures(source, rides, input.from, window);
  const trips = new Set(scheduled.map((departure) => departure.tripId));
  const own = (input.batch?.items ?? []).filter((prediction) => prediction.tripId !== null && trips.has(prediction.tripId));
  const rows = mergeDepartures(scheduled, own, window).rows;
  const stopIds = [...new Set(rides.map((ride) => ride.boardStopId))];
  const departures = hurryDepartures(rows, { stopIds, now: input.nowS, liveStale: liveIsStale(input.batch, input.nowS) });
  invariant(departures.length <= rides.length + own.length, 'live news adds no train the trip does not ride');
  return departures;
}

/** The origin's timetable departures that ARE the rides' boardings (the same trip, stop and second on the same service day). */
function boardingDepartures(source: TripVerdictSource, rides: readonly Ride[], from: string, window: TimeWindow): Departure[] {
  const read = source.departures(from, window);
  invariant(read.ok && read.value.kind === 'departures', `${from}, which has rides in the window, has departures in it`);
  const boardings = new Set(rides.map((ride) => `${ride.serviceDate}:${ride.boardTripIdx}:${ride.boardStopId}:${ride.depEpoch}`));
  const scheduled = read.value.departures.filter((d) => boardings.has(`${d.serviceDate}:${d.tripIdx}:${d.stopId}:${d.epoch}`));
  invariant(scheduled.length === rides.length, 'every ride boards one of its station\'s departures, each once');
  return scheduled;
}
