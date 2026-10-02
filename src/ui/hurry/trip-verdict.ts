import type { DeparturesOutcome, RidesQueryOutcome, UnknownStation } from '../../data/schedule-repo';
import { type ServiceDayResolution, type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import { hurryDepartures } from '../../domain/hurry/board';
import { nearestPlatform, type Platform } from '../../domain/hurry/platform';
import { type HurryDeparture, hurryVerdict, type HurryVerdict } from '../../domain/hurry/verdict';
import { mergeDepartures } from '../../domain/live/merge-departures';
import type { LiveBatch, LivePrediction } from '../../domain/live/types';
import type { Departure } from '../../domain/schedule/departures';
import type { Ride } from '../../domain/schedule/rides';
import { type WalkEstimate, walkFor, type WalkTo } from '../../domain/walk/walk-cache';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import type { WalkingPace } from '../settings/walking-pace';
import { SHEET_LEAD_S } from '../stations/station-sheet';
import { TRIP_HORIZON_S } from '../trips/trip-card';
import type { HurryCopyContext } from './copy';
import { clockFor, liveIsStale } from './hurry-reading';

/**
 * mfix8 (decision.miami_transit_bar_uses_saved_trips; Jamie, 2026-10-02: "By biggest gripe is how it says 'not
 * worth it next in 10 min fifth street' without me even entering where I wanna go"): hurry or chill for a
 * SAVED TRIP — the pure half of the Now bar's verdict. Only trains that take the rider where the trip goes count:
 *
 *   rides    the schedule's tripRides(from, to) over verdictWindow(now): from SHEET_LEAD_S before now (the
 *            station sheet's rule, m6a) to the trip card's horizon (TRIP_HORIZON_S) — never the other
 *            direction, never a train that does not reach the destination
 *   live     m4a's merge over those rides' boarding departures, fed ONLY the predictions for those very GTFS
 *            trips (a prediction for another trip — the other direction, another station — never moves a ride)
 *   coming   ONLY THEN are trains that have gone dropped (board.ts): a ride counts when its MERGED time is now
 *            or later, so a train scheduled 7:59:40 and predicted for 8:02 is still caught at 8:00:00, while one
 *            scheduled before now with no prediction is gone. A canceled ride drops out; live data past its
 *            provider's fresh limit is stale
 *   walk     to the nearest (straight line) boarding platform of the rides still to come (the origin's nearest
 *            platform when none is), at Jamie's paces: the street-routed walk when the caller's `walk` (mfix9, the
 *            Now bar's useWalkTo) knows one, else the straight line with m7c's 1.3 detour — an ESTIMATE, and the
 *            bar says so
 *   verdict  m7c's hurryVerdict over those departures
 *
 * Two halves, so the Now bar reads the schedule once a minute (as the station sheet's stationTimetable does) yet
 * judges every tick with the latest live batch, position and instant (useNearTripVerdict):
 *
 *   tripTimetable  the schedule reads: the rides over a window, their boarding departures, the origin's
 *                  platforms and the clock's service-day bases
 *   judgeTrip      the verdict at one instant, over a timetable whose window holds that instant's verdictWindow
 *   tripVerdict    both, read over exactly verdictWindow(now)
 *
 * Null when the schedule cannot judge the trip — a station it does not know, a pair that needs a transfer, or no
 * timetable. When nothing leaves the origin (night) the verdict is NO_SERVICE.
 */

export type TripVerdict = {
  readonly verdict: HurryVerdict;
  readonly ctx: HurryCopyContext;
  /** Straight-line metres to the boarding platform (the verdict walks `walkSource`'s distance there). */
  readonly walkMeters: number;
  /** mfix9: what the verdict walked — Transitous's street-routed walk ('routed') or the straight line with m7c's detour ('estimated'). */
  readonly walkSource: WalkEstimate['source'];
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
  /** mfix9: the walk to an origin platform (the Now bar's useWalkTo); absent, the straight line with m7c's detour. */
  readonly walk?: WalkTo;
};

/** The schedule's half of a trip's verdict, read once over `window` and judged at any instant whose verdictWindow it holds. */
export type TripTimetable = {
  readonly from: string;
  readonly to: string;
  readonly window: TimeWindow;
  /** Each ride's boarding: the origin's timetable departure that IS the ride (its trip, stop and second, on its service day). */
  readonly boardings: readonly Departure[];
  /** The origin station's platforms. */
  readonly platforms: readonly Platform[];
  /** The running service days' base epochs: what a clock time counts from. */
  readonly bases: readonly number[];
};

/** The window whose rides the verdict at `nowS` weighs: the station sheet's lead before now, the trip card's horizon after. */
export function verdictWindow(nowS: number): TimeWindow {
  invariant(Number.isSafeInteger(nowS), 'a trip is judged at a whole second');
  const window = windowFrom(nowS - SHEET_LEAD_S, SHEET_LEAD_S + TRIP_HORIZON_S);
  invariant(window.fromEpoch < nowS && nowS < window.toEpoch, 'the window holds now');
  return window;
}

/** The window read once for the minute starting `minuteS`: it holds the verdictWindow of every second of that minute. */
export function tripMinuteWindow(minuteS: number): TimeWindow {
  invariant(Number.isSafeInteger(minuteS) && minuteS % 60 === 0, 'a minute starts on the minute');
  const window = windowFrom(minuteS - SHEET_LEAD_S, SHEET_LEAD_S + TRIP_HORIZON_S + 59);
  invariant(holds(window, verdictWindow(minuteS)) && holds(window, verdictWindow(minuteS + 59)), 'every second of the minute is judged inside the read');
  return window;
}

/** The trip's verdict at `input.nowS`, its rides read over exactly verdictWindow(now); null when the schedule cannot judge it. */
export function tripVerdict(source: TripVerdictSource, input: TripVerdictInput): TripVerdict | null {
  invariant(input.from !== input.to && input.from.includes(':') && input.to.includes(':'), 'a trip joins two stations keyed mode:name');
  const timetable = tripTimetable(source, input.from, input.to, verdictWindow(input.nowS));
  const judged = timetable === null ? null : judgeTrip(timetable, input);
  invariant(judged === null || judged.ctx.now === input.nowS, 'the trip is judged at the instant asked');
  return judged;
}

/** The trip's rides over `window` and what judging them needs; null when the schedule cannot judge the trip. */
export function tripTimetable(source: TripVerdictSource, from: string, to: string, window: TimeWindow): TripTimetable | null {
  invariant(from !== to && from.includes(':') && to.includes(':'), 'a trip joins two stations keyed mode:name');
  const outcome = source.tripRides(from, to, window);
  if (!outcome.ok || (outcome.value.kind !== 'rides' && outcome.value.kind !== 'no-service')) {
    return null;
  }
  const rides = outcome.value.kind === 'rides' ? outcome.value.rides : [];
  const days = source.serviceDays(window);
  invariant(days.kind === 'active', 'a window the schedule has rides for, or nothing leaving in, has running service days');
  const platforms = source.platforms().filter((platform) => platform.stationKey === from);
  invariant(platforms.length > 0, `${from} has a platform to walk to`);
  return { from, to, window, boardings: boardingDepartures(source, rides, from, window), platforms, bases: days.days.map((day) => day.baseEpoch) };
}

/** The trip's verdict at `input.nowS`, over a timetable read for a window that holds that instant's verdictWindow. */
export function judgeTrip(timetable: TripTimetable, input: TripVerdictInput): TripVerdict {
  invariant(timetable.from === input.from && timetable.to === input.to, 'the timetable is the trip judged');
  const window = verdictWindow(input.nowS);
  invariant(holds(timetable.window, window), 'the timetable holds every ride the instant weighs');
  const coming = comingDepartures(timetable, window, input);
  const platforms = coming.stopIds.size > 0 ? timetable.platforms.filter((platform) => coming.stopIds.has(platform.stopId)) : timetable.platforms;
  const nearest = nearestPlatform(input.position, platforms, null);
  invariant(nearest !== null, `${input.from} has a platform to walk to`);
  const walk = input.walk === undefined ? walkFor(null, nearest.platform, input.position) : input.walk(nearest.platform);
  const verdict = hurryVerdict({ now: input.nowS, departures: coming.departures, ...input.pace, walkMeters: walk.walkMeters, detour: walk.detour });
  return { verdict, ctx: { now: input.nowS, clock: clockFor(timetable.bases) }, walkMeters: nearest.walkMeters, walkSource: walk.source };
}

/** The departures still to come, and the platforms they board at. */
type Coming = { readonly departures: readonly HurryDeparture[]; readonly stopIds: ReadonlySet<string> };

/**
 * The rides scheduled inside `window`, each moved by its OWN trip's live prediction (m4a's merge), and only then
 * the ones still to come (board.ts): boardable, merged time now or later, earliest first.
 */
function comingDepartures(timetable: TripTimetable, window: TimeWindow, input: TripVerdictInput): Coming {
  const scheduled = timetable.boardings.filter((departure) => departure.epoch >= window.fromEpoch && departure.epoch <= window.toEpoch);
  const trips = new Set(scheduled.map((departure) => departure.tripId));
  const own = (input.batch?.items ?? []).filter((prediction) => prediction.tripId !== null && trips.has(prediction.tripId));
  const rows = mergeDepartures(scheduled, own, window).rows;
  const boards = [...new Set(scheduled.map((departure) => departure.stopId))];
  const departures = hurryDepartures(rows, { stopIds: boards, now: input.nowS, liveStale: liveIsStale(input.batch, input.nowS) });
  const kept = new Set(departures.map((departure) => departure.key));
  const stopIds = new Set(rows.filter((row) => kept.has(row.key)).flatMap((row) => (row.stopId === null ? [] : [row.stopId])));
  invariant(departures.length <= scheduled.length + own.length, 'live news adds no train the trip does not ride');
  invariant(departures.every((departure) => departure.key !== undefined), 'every departure keeps its board row\'s key, so its platform is known');
  invariant(departures.every((departure) => departure.epoch >= input.nowS), 'only trains still to come are weighed');
  return { departures, stopIds };
}

/** The origin's timetable departures that ARE the rides' boardings (the same trip, stop and second on the same service day). */
function boardingDepartures(source: TripVerdictSource, rides: readonly Ride[], from: string, window: TimeWindow): Departure[] {
  invariant(rides.every((ride) => ride.depEpoch >= window.fromEpoch && ride.depEpoch <= window.toEpoch), 'every ride boards inside the window');
  if (rides.length === 0) {
    return [];
  }
  const read = source.departures(from, window);
  invariant(read.ok && read.value.kind === 'departures', `${from}, which has rides in the window, has departures in it`);
  const boardings = new Set(rides.map((ride) => `${ride.serviceDate}:${ride.boardTripIdx}:${ride.boardStopId}:${ride.depEpoch}`));
  const scheduled = read.value.departures.filter((d) => boardings.has(`${d.serviceDate}:${d.tripIdx}:${d.stopId}:${d.epoch}`));
  invariant(scheduled.length === rides.length, 'every ride boards one of its station\'s departures, each once');
  return scheduled;
}

/** `outer` holds every second of `inner`. */
function holds(outer: TimeWindow, inner: TimeWindow): boolean {
  invariant(outer.fromEpoch <= outer.toEpoch && inner.fromEpoch <= inner.toEpoch, 'both windows are ordered');
  const held = outer.fromEpoch <= inner.fromEpoch && inner.toEpoch <= outer.toEpoch;
  invariant(!held || outer.toEpoch - outer.fromEpoch >= inner.toEpoch - inner.fromEpoch, 'a held window is no longer than its holder');
  return held;
}
