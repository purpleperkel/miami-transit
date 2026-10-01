import { invariant } from '../../lib/invariant';
import { isTimeWindow, type TimeWindow } from '../gtfs/service-day';
import type { Departure } from '../schedule/departures';
import type { LivePrediction } from './types';

/**
 * Plan M4.7 / §4 merge rule 6: a station's departure board, from the timetable's departures (M3.3)
 * and the live predictions for the station (Swiftly trip updates or Transitland departures).
 *
 *  - SAME-TRIP OVERRIDE: a realtime prediction for the departure's trip at the same stop (or a
 *    trip-wide one) sets its time — the predicted epoch, else the scheduled time plus the delay.
 *    A scheduled-only prediction (Transitland STATIC, no estimate) changes nothing.
 *  - CANCELED: a canceled trip, or a skipped stop, is STRUCK THROUGH at its scheduled time — the row
 *    stays, so the rider sees the train they expected is not coming.
 *  - UNMATCHED: a prediction that matches no scheduled departure becomes its own row when it carries
 *    live news (realtime or canceled) and a time inside the board's window — e.g. an added train.
 *    Unmatched scheduled-only predictions are not rows: the schedule DB is the timetable, and it
 *    deliberately leaves out, e.g., trains that terminate at this station (M3.3). Every prediction
 *    that made no row is counted in `unused`.
 * Rows are ordered by when they leave, so an override can reorder the board.
 */

export type DepartureRow = {
  readonly key: string;
  readonly tripId: string | null;
  readonly stopId: string | null;
  readonly lineId: string | null;
  /** The timetable's destination name, else the prediction's headsign. */
  readonly destName: string | null;
  /** When it leaves (epoch s): predicted when a realtime prediction applies, else the timetable's. */
  readonly epoch: number;
  readonly scheduledEpoch: number | null;
  /** Seconds late (negative = early) when a realtime prediction applies. */
  readonly delayS: number | null;
  /** Live news set this row (a realtime time or a cancellation). */
  readonly live: boolean;
  /** Struck through; never removed. */
  readonly canceled: boolean;
  readonly departure: Departure | null;
  readonly prediction: LivePrediction | null;
};

export type DeparturesMerge = {
  readonly rows: readonly DepartureRow[];
  /** Predictions that made no row (unmatched without live news, without a time, or outside the window). */
  readonly unused: number;
};

export function mergeDepartures(scheduled: readonly Departure[], predictions: readonly LivePrediction[], window: TimeWindow): DeparturesMerge {
  invariant(isTimeWindow(window), 'the board covers a valid window');
  invariant(new Set(scheduled.map(departureKey)).size === scheduled.length, 'each scheduled departure is listed once');
  const used = new Set<LivePrediction>();
  const rows: DepartureRow[] = [];
  for (const departure of scheduled) {
    const prediction = predictionFor(departure, predictions);
    if (prediction !== null) {
      used.add(prediction);
    }
    rows.push(scheduledRow(departure, prediction));
  }
  let unused = 0;
  for (const prediction of predictions.filter((p) => !used.has(p))) {
    const epoch = prediction.epoch ?? prediction.scheduledEpoch;
    if ((prediction.realtime || prediction.canceled) && epoch !== null && epoch >= window.fromEpoch && epoch <= window.toEpoch) {
      rows.push(predictionRow(prediction, epoch, rows.length));
    } else {
      unused += 1;
    }
  }
  rows.sort((a, b) => a.epoch - b.epoch || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  invariant(rows.length === scheduled.length + predictions.length - used.size - unused, 'every departure is a row; every prediction is a match, a row or counted unused');
  return { rows, unused };
}

/** The prediction for this departure: same trip at the same stop, else a trip-wide one (stopId null). */
function predictionFor(departure: Departure, predictions: readonly LivePrediction[]): LivePrediction | null {
  invariant(departure.tripId.length > 0 && departure.stopId.length > 0, 'a scheduled departure names its trip and stop');
  const sameTrip = predictions.filter((p) => p.tripId === departure.tripId);
  const found = sameTrip.find((p) => p.stopId === departure.stopId) ?? sameTrip.find((p) => p.stopId === null) ?? null;
  invariant(found === null || found.tripId === departure.tripId, 'only a same-trip prediction overrides');
  return found;
}

/** A timetable departure, overridden (rule 6) when a realtime or canceling prediction applies. */
function scheduledRow(departure: Departure, prediction: LivePrediction | null): DepartureRow {
  invariant(Number.isSafeInteger(departure.epoch), 'a scheduled departure has a whole epoch');
  const canceled = prediction?.canceled ?? false;
  const realtime = prediction !== null && prediction.realtime && !canceled;
  const predictedEpoch = realtime ? (prediction.epoch ?? departure.epoch + (prediction.delayS ?? 0)) : null;
  invariant(!realtime || prediction.epoch !== null || prediction.delayS !== null, 'a realtime prediction says when');
  return {
    key: departureKey(departure),
    tripId: departure.tripId,
    stopId: departure.stopId,
    lineId: departure.lineId,
    destName: departure.destName,
    epoch: predictedEpoch ?? departure.epoch,
    scheduledEpoch: departure.epoch,
    delayS: predictedEpoch === null ? null : predictedEpoch - departure.epoch,
    live: realtime || canceled,
    canceled,
    departure,
    prediction,
  };
}

/** An unmatched prediction with live news, as its own row at `epoch`. */
function predictionRow(prediction: LivePrediction, epoch: number, index: number): DepartureRow {
  invariant(prediction.realtime || prediction.canceled, 'only live news becomes its own row');
  invariant(Number.isSafeInteger(epoch), 'a row has a whole epoch');
  return {
    key: `live:${prediction.tripId ?? `#${index}`}:${prediction.stopId ?? '*'}`,
    tripId: prediction.tripId,
    stopId: prediction.stopId,
    lineId: prediction.lineId,
    destName: prediction.headsign,
    epoch,
    scheduledEpoch: prediction.scheduledEpoch,
    delayS: prediction.delayS,
    live: true,
    canceled: prediction.canceled,
    departure: null,
    prediction,
  };
}

function departureKey(departure: Departure): string {
  invariant(Number.isInteger(departure.serviceDate), 'a departure belongs to a service date');
  const key = `${departure.serviceDate}:${departure.tripId}:${departure.stopId}`;
  invariant(key.split(':').length >= 3, 'the key names date, trip and stop');
  return key;
}
