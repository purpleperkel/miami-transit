import type { TimeWindow } from '../../domain/gtfs/service-day';
import { providerConfig } from '../../domain/live/constants';
import { type DepartureRow as MergedRow, mergeDepartures } from '../../domain/live/merge-departures';
import type { LiveBatch, LivePrediction } from '../../domain/live/types';
import type { Departure } from '../../domain/schedule/departures';
import { invariant } from '../../lib/invariant';
import type { Freshness } from '../primitives/FreshnessIndicator';

/**
 * What one direction of a station's departure board shows (plan M6.3): the timetable's departures
 * with the station's live predictions merged in by m4a's merge (src/domain/live/merge-departures.ts,
 * §4 rule 6 — predictions override scheduled times, cancellations stay listed and are struck through),
 * then only what is still to leave, capped at `maxRows`.
 *
 * A station's predictions cover every direction, so the group first keeps its own:
 *  - a prediction for one of this direction's trips, at one of its platforms or trip-wide (a whole
 *    trip canceled) — the merge applies it to that departure;
 *  - a prediction for a train the timetable does not know (no line from the schedule) at one of this
 *    direction's platforms — an added train, which the merge lists as its own row.
 * A timetable trip this direction does not list belongs to another direction and is left to that group.
 * Where both directions share one platform (Metromover), an unknown train cannot be placed and shows in
 * each group of that platform.
 */

/** A row stays this long past its time (reading "Now"), then leaves the board. */
export const DEPARTED_AFTER_S = 30;

export type BoardInput = {
  /** This direction's scheduled departures (M3.3), earliest first. */
  readonly departures: readonly Departure[];
  /** The station's latest predictions batch, or null when there is none. */
  readonly predictions: LiveBatch<LivePrediction> | null;
  /** The window the departures were fetched for. Starting it before now lets a late train still match its scheduled departure. */
  readonly window: TimeWindow;
  /** Now (epoch s). */
  readonly nowS: number;
  readonly maxRows: number;
};

export type BoardRow = {
  readonly row: MergedRow;
  /** The row's instant as a service-day second: what its clock time reads beyond the hour. */
  readonly depS: number;
};

export type DirectionBoard = {
  /** At most `maxRows` rows still to leave, earliest first; canceled rows included. */
  readonly rows: readonly BoardRow[];
  /** The rows mix live and scheduled times, so each row carries its own source icon. */
  readonly mixed: boolean;
  /** One freshness per source the rows use, live first: what the group header shows. */
  readonly sources: readonly Freshness[];
};

const SCHEDULED: Freshness = Object.freeze({ kind: 'scheduled' });

export function directionBoard(input: BoardInput): DirectionBoard {
  invariant(Number.isSafeInteger(input.maxRows) && input.maxRows > 0, `a board shows a positive whole number of rows, got ${input.maxRows}`);
  invariant(Number.isFinite(input.nowS), 'a board is drawn at an instant');
  const mine = predictionsForDirection(input.departures, input.predictions?.items ?? []);
  const merged = mergeDepartures(input.departures, mine, input.window);
  const rows = merged.rows
    .filter((row) => row.epoch + DEPARTED_AFTER_S > input.nowS)
    .slice(0, input.maxRows)
    .map((row) => ({ row, depS: serviceSecond(row, input.departures) }));
  const live = rows.some(({ row }) => row.live);
  const scheduled = rows.some(({ row }) => !row.live);
  const sources = [...(live ? [liveFreshness(input.predictions, input.nowS)] : []), ...(scheduled ? [SCHEDULED] : [])];
  invariant(rows.length <= input.maxRows && rows.length <= merged.rows.length, 'the board never shows more than it may, or than the merge gave');
  return { rows, mixed: live && scheduled, sources };
}

/** The station's predictions that belong to this direction (see the module comment). */
export function predictionsForDirection(departures: readonly Departure[], predictions: readonly LivePrediction[]): LivePrediction[] {
  const trips = new Set(departures.map((departure) => departure.tripId));
  const platforms = new Set(departures.map((departure) => departure.stopId));
  invariant(platforms.size <= departures.length, 'every platform comes from a departure');
  const mine = predictions.filter((prediction) => {
    const atPlatform = prediction.stopId !== null && platforms.has(prediction.stopId);
    const ownTrip = prediction.tripId !== null && trips.has(prediction.tripId) && (atPlatform || prediction.stopId === null);
    return ownTrip || (prediction.lineId === null && atPlatform);
  });
  invariant(mine.length <= predictions.length, 'the direction keeps a subset of the predictions');
  return mine;
}

/**
 * A row's instant as a service-day second: its departure's depS moved by any live delay, or — for a
 * live-only row — counted from the service day of the timetable departure nearest in time.
 */
export function serviceSecond(row: MergedRow, departures: readonly Departure[]): number {
  invariant(Number.isFinite(row.epoch), 'a row has a time');
  if (row.departure !== null) {
    return row.departure.depS + (row.epoch - row.departure.epoch);
  }
  let nearest: Departure | null = null;
  for (const departure of departures) {
    if (nearest === null || Math.abs(departure.epoch - row.epoch) < Math.abs(nearest.epoch - row.epoch)) {
      nearest = departure;
    }
  }
  invariant(nearest !== null, 'a live-only row is merged beside the departures of this direction');
  return row.epoch - (nearest.epoch - nearest.depS);
}

/** Live predictions are fresh until older than their provider's fresh threshold (§3), then stale. */
export function liveFreshness(batch: LiveBatch<LivePrediction> | null, nowS: number): Freshness {
  invariant(batch !== null, 'live rows come from a predictions batch');
  const ageS = Math.max(0, Math.floor(nowS - batch.fetchedAt));
  const freshness: Freshness = ageS > providerConfig(batch.provider).freshS ? { kind: 'stale', ageS } : { kind: 'live' };
  invariant(freshness.kind === 'live' || freshness.ageS > 0, 'only an aged batch is stale');
  return freshness;
}
