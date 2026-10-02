import type { CalendarGap, DeparturesOutcome, UnknownStation } from '../../data/schedule-repo';
import type { StationListing } from '../../data/schedule-queries';
import { type ServiceDayResolution, type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import { hurryDepartures } from '../../domain/hurry/board';
import { nearestPlatform, type Platform } from '../../domain/hurry/platform';
import { hurryVerdict, type HurryVerdict } from '../../domain/hurry/verdict';
import { providerConfig } from '../../domain/live/constants';
import { mergeDepartures } from '../../domain/live/merge-departures';
import type { LiveBatch, LivePrediction } from '../../domain/live/types';
import type { Departure } from '../../domain/schedule/departures';
import { walkFor, type WalkTo } from '../../domain/walk/walk-cache';
import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import { liveFreshness, predictionsForDirection } from '../departures/direction-board';
import { formatShortClockFromServiceSec } from '../format';
import type { Freshness } from '../primitives/FreshnessIndicator';
import type { WalkingPace } from '../settings/walking-pace';
import { directionTitle, SHEET_HORIZON_S, SHEET_LEAD_S } from '../stations/station-sheet';
import { actionableVerdict, type HurryCopyContext } from './copy';

/**
 * Plan M7c.3, the wiring's pure half: from the schedule, the rider's position, the station's live
 * predictions and Jamie's paces to one hurry-or-chill verdict PER DIRECTION of a station. (A verdict
 * never mixes directions: "not worth it, another leaves in 2 min" must mean a train the same way.)
 *
 *   stationTimetable  the station, its platforms and its departures over the station sheet's own window,
 *                     read once a minute (the same trains the sheet lists)
 *   hurryReading      per direction: the nearest platform serving it (walkMeters), the timetable with the
 *                     live predictions merged in (m4a's merge, as the sheet's DirectionGroup does), the
 *                     boardable departures (board.ts) and the verdict (verdict.ts); or why there is none.
 *                     mfix9: the verdict walks to that platform by the reading's `walk` (the sheet's useWalkTo):
 *                     the street-routed walk when the app knows one, else the straight line with m7c's detour
 *   soonestBoard      the direction whose recommended train leaves first (the Now strip's pick until mfix8;
 *                     kept for the mfix8 verify oracle, see its doc)
 *
 * Live data is stale past its provider's fresh limit (providerConfig(provider).freshS, mfix3's relative
 * rule): its departures carry `stale`, so the verdict's confidence is low and the badge says how old.
 * Clock times come from the schedule's own service-day bases (no time-zone math on the phone).
 */

/** Beyond this straight-line distance to the nearest platform there is no train to hurry for. */
export const HURRY_RANGE_M = 2_000;

/** What the reading needs from the schedule repo (ScheduleRepo fits). */
export type HurrySource = {
  stations(): readonly StationListing[];
  platforms(): readonly Platform[];
  serviceDays(window: TimeWindow): ServiceDayResolution;
  departures(stationKey: string, window: TimeWindow): Result<DeparturesOutcome, UnknownStation>;
};

type StationPart = { readonly station: StationListing; readonly platforms: readonly Platform[] };
export type StationTimetable =
  | (StationPart & {
      readonly kind: 'timetable';
      readonly window: TimeWindow;
      readonly departures: readonly Departure[];
      /** The running service days' base epochs: what a clock time counts from. */
      readonly bases: readonly number[];
    })
  | (StationPart & { readonly kind: 'gap'; readonly gap: CalendarGap })
  | { readonly kind: 'unknown-station'; readonly stationKey: string };

/** The station's departures over the station sheet's window starting `minuteS`, or why there are none. */
export function stationTimetable(source: HurrySource, stationKey: string, minuteS: number): StationTimetable {
  invariant(stationKey.includes(':') && Number.isSafeInteger(minuteS) && minuteS % 60 === 0, 'a station timetable is read for a station, on the minute');
  const station = source.stations().find((candidate) => candidate.stationKey === stationKey);
  const window = windowFrom(minuteS - SHEET_LEAD_S, SHEET_LEAD_S + SHEET_HORIZON_S);
  const read = station === undefined ? null : source.departures(stationKey, window);
  if (station === undefined || read === null || !read.ok) {
    return { kind: 'unknown-station', stationKey };
  }
  const platforms = source.platforms().filter((platform) => platform.stationKey === stationKey);
  invariant(platforms.length > 0, `${stationKey} has platforms`);
  if (read.value.kind !== 'departures') {
    return { kind: 'gap', station, platforms, gap: read.value };
  }
  const days = source.serviceDays(window);
  invariant(days.kind === 'active', 'a window with departures has running service days');
  return { kind: 'timetable', station, platforms, window, departures: read.value.departures, bases: days.days.map((day) => day.baseEpoch) };
}

/** One direction's verdict at the station (directionId null: no train runs either way in the window). */
export type HurryBoard = {
  readonly directionId: number | null;
  /** "To Dadeland South", or null with no train to name. */
  readonly title: string | null;
  /** Straight-line metres to the nearest platform serving the direction; the verdict walks the routed walk there when one is known. */
  readonly walkMeters: number;
  readonly verdict: HurryVerdict;
  /** Where the verdict's train time comes from: live, live but old, or scheduled. */
  readonly freshness: Freshness;
};

export type HurryReading =
  | { readonly kind: 'opening' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'locating' }
  | { readonly kind: 'no-location'; readonly note: string }
  | { readonly kind: 'far'; readonly stationKey: string; readonly stationName: string; readonly walkMeters: number }
  | { readonly kind: 'gap'; readonly stationKey: string; readonly stationName: string; readonly gap: CalendarGap }
  | { readonly kind: 'boards'; readonly stationKey: string; readonly stationName: string; readonly boards: readonly HurryBoard[]; readonly ctx: HurryCopyContext };

export type ReadingInput = {
  readonly db: { readonly kind: 'opening' } | { readonly kind: 'ready' } | { readonly kind: 'failed'; readonly message: string };
  readonly position: { readonly coordinate: LatLon | null; readonly note: string | null };
  /** The chosen station's timetable; null only while no station can be chosen (no DB or no fix). */
  readonly timetable: StationTimetable | null;
  readonly batch: LiveBatch<LivePrediction> | null;
  readonly nowS: number;
  readonly pace: WalkingPace;
  /** mfix9: the walk to a platform (the sheet's useWalkTo); absent, the straight line with m7c's detour. */
  readonly walk?: WalkTo;
};

const OPENING: HurryReading = Object.freeze({ kind: 'opening' });
const LOCATING: HurryReading = Object.freeze({ kind: 'locating' });
const SCHEDULED: Freshness = Object.freeze({ kind: 'scheduled' });

export function hurryReading(input: ReadingInput): HurryReading {
  invariant(Number.isSafeInteger(input.nowS), 'a reading is taken at a whole second');
  if (input.db.kind !== 'ready') {
    return input.db.kind === 'opening' ? OPENING : { kind: 'failed', message: input.db.message };
  }
  const coordinate = input.position.coordinate;
  if (coordinate === null) {
    return input.position.note === null ? LOCATING : { kind: 'no-location', note: input.position.note };
  }
  const timetable = input.timetable;
  invariant(timetable !== null, 'with the schedule open and a fix, a station is chosen');
  if (timetable.kind === 'unknown-station') {
    return { kind: 'failed', message: `the schedule has no station ${timetable.stationKey}` };
  }
  const named = { stationKey: timetable.station.stationKey, stationName: timetable.station.name };
  const nearest = nearestPlatform(coordinate, timetable.platforms, null);
  invariant(nearest !== null, 'a station has a platform');
  if (nearest.walkMeters > HURRY_RANGE_M) {
    return { kind: 'far', ...named, walkMeters: nearest.walkMeters };
  }
  if (timetable.kind === 'gap') {
    return { kind: 'gap', ...named, gap: timetable.gap };
  }
  const boards = hurryBoards(timetable, coordinate, input);
  return { kind: 'boards', ...named, boards, ctx: { now: input.nowS, clock: clockFor(timetable.bases) } };
}

type Timetable = Extract<StationTimetable, { readonly kind: 'timetable' }>;
type BoardInputs = Pick<ReadingInput, 'batch' | 'nowS' | 'pace' | 'walk'>;

/** One board per direction with a departure in the window, in direction order; a NO_SERVICE board when none. */
function hurryBoards(timetable: Timetable, position: LatLon, inputs: BoardInputs): HurryBoard[] {
  const directions = [...new Set(timetable.departures.map((d) => d.directionId))].sort((a, b) => a - b);
  if (directions.length === 0) {
    const nearest = nearestPlatform(position, timetable.platforms, null);
    invariant(nearest !== null, 'a station has a platform');
    const verdict = hurryVerdict({ now: inputs.nowS, departures: [], ...inputs.pace, ...walkTo(nearest.platform, position, inputs) });
    return [{ directionId: null, title: null, walkMeters: nearest.walkMeters, verdict, freshness: SCHEDULED }];
  }
  const boards = directions.map((directionId) => directionBoard(timetable, directionId, position, inputs));
  invariant(boards.length === directions.length, 'every direction has its board');
  return boards;
}

/** The verdict for one direction: walk to its nearest platform, weigh its merged departures there. */
function directionBoard(timetable: Timetable, directionId: number, position: LatLon, inputs: BoardInputs): HurryBoard {
  const scheduled = timetable.departures.filter((d) => d.directionId === directionId);
  const nearest = nearestPlatform(position, timetable.platforms, directionId);
  invariant(nearest !== null && scheduled.length > 0, `direction ${directionId} departs from a platform of the station`);
  const stopIds = timetable.platforms.filter((p) => p.directionIds.includes(directionId)).map((p) => p.stopId);
  const predictions = predictionsForDirection(scheduled, inputs.batch?.items ?? []);
  const rows = mergeDepartures(scheduled, predictions, timetable.window).rows;
  const departures = hurryDepartures(rows, { stopIds, now: inputs.nowS, liveStale: liveIsStale(inputs.batch, inputs.nowS) });
  const verdict = hurryVerdict({ now: inputs.nowS, departures, ...inputs.pace, ...walkTo(nearest.platform, position, inputs) });
  const freshness = actionableVerdict(verdict).live ? liveFreshness(inputs.batch, inputs.nowS) : SCHEDULED;
  invariant((freshness.kind === 'scheduled') === !actionableVerdict(verdict).live, 'the badge follows the train the verdict is about');
  return { directionId, title: directionTitle(scheduled), walkMeters: nearest.walkMeters, verdict, freshness };
}

/** What a verdict walks to `platform`: the reading's walk (routed, or its estimate), else the straight line with m7c's detour. */
function walkTo(platform: Platform, position: LatLon, inputs: BoardInputs): { readonly walkMeters: number; readonly detour: number } {
  invariant(isLatLon(position) && platform.stopId.length > 0, 'a walk runs from a real fix to a platform named by its GTFS stop_id');
  const walk = inputs.walk === undefined ? walkFor(null, platform, position) : inputs.walk(platform);
  invariant(Number.isFinite(walk.walkMeters) && walk.walkMeters >= 0 && walk.detour >= 1, `the walk to ${platform.stopId} is a real distance with a detour of at least 1`);
  return { walkMeters: walk.walkMeters, detour: walk.detour };
}

/** The live predictions are older than their provider's fresh limit (mfix3's relative rule). */
export function liveIsStale(batch: LiveBatch<LivePrediction> | null, nowS: number): boolean {
  invariant(Number.isFinite(nowS), 'staleness is judged at an instant');
  const stale = batch !== null && nowS - batch.fetchedAt > providerConfig(batch.provider).freshS;
  invariant(!stale || batch !== null, 'only a batch can be stale');
  return stale;
}

/** An epoch as the short clock, counted from the latest running service day's base at or before it. */
export function clockFor(bases: readonly number[]): (epoch: number) => string {
  invariant(bases.length > 0 && bases.every((base) => Number.isSafeInteger(base)), 'a clock counts from service-day bases');
  const sorted = [...bases].sort((a, b) => a - b);
  invariant(sorted[0] !== undefined, 'there is a first base');
  const first = sorted[0];
  return (epoch) => formatShortClockFromServiceSec(epoch - sorted.reduce((base, candidate) => (candidate <= epoch ? candidate : base), first));
}

/**
 * The station's board whose recommended train leaves first, in EITHER direction (a CHILL or JOG train, a
 * NOT_WORTH_IT verdict's next train, a MISSED verdict's nested one); a tie keeps direction order. It was the
 * Now strip's verdict until mfix8, when the bar began judging a saved trip's own rides instead (trip-verdict.ts):
 * a station's soonest train is often going the wrong way for the rider.
 *
 * No app code calls it any more. It is KEPT because the mfix8 verify oracle (scripts/ratchet/verify-mfix8_trip_bar.sh,
 * its trip_verdict case) loads it by name, to prove the bar no longer judges the nearest station's soonest
 * direction: at 08:04 the soonest Brickell City Centre train either way is not a Bayfront Park ride, and the bar
 * must still judge only the Bayfront Park rides.
 */
export function soonestBoard(boards: readonly HurryBoard[]): HurryBoard {
  invariant(boards.length > 0, 'a station reading has at least one board');
  let best = boards[0] as HurryBoard;
  for (const board of boards) {
    if (takeAt(board.verdict) < takeAt(best.verdict)) {
      best = board;
    }
  }
  invariant(boards.includes(best), 'the board shown is one of the station\'s');
  return best;
}

/** When the train a verdict recommends leaves (epoch s); Infinity when it recommends none. */
function takeAt(verdict: HurryVerdict): number {
  const acted = actionableVerdict(verdict);
  const train = acted.kind === 'CHILL' || acted.kind === 'JOG' ? acted.departure : acted.kind === 'NOT_WORTH_IT' ? acted.next : null;
  invariant(train === null || Number.isFinite(train.epoch), 'a recommended train leaves at an instant');
  invariant(acted.kind === 'MISSED' || acted.kind === 'NO_SERVICE' || train !== null, `a ${acted.kind} verdict recommends a train`);
  return train === null ? Number.POSITIVE_INFINITY : train.epoch;
}
