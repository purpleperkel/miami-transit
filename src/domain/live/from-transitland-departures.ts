import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { linesOfRoute } from '../lines/line-catalog';
import { countDrop, type Drops } from './drops';
import { tripLineOnRoute } from './line-from-position';
import type { LiveError, LiveNetwork, LivePrediction, MappedFeed } from './types';

/**
 * Plan M4.3b: Transitland's per-station departures (JSON) → LivePrediction — the primary predictions
 * path, because Transitland's whole-agency trip-updates download is 1 MB per poll (§3, 2026-10-01).
 * The response is `{ stops: [{ stop_id, departures: [row…] }] }`; each row carries its trip
 * (trip_id, trip_headsign, schedule_relationship, route.route_id) and a departure (or arrival) event
 * (scheduled_local, estimated_utc).
 *
 *  - A row is REALTIME iff trip.schedule_relationship ≠ 'STATIC' AND estimated_utc is set. Anything
 *    else is flagged scheduled-only (`realtime: false`, no predicted epoch).
 *  - A 'CANCELED' trip is flagged `canceled` (struck through by merge-departures, never removed).
 *  - The response's stop_id maps to our station key through the injected schedule lookup.
 *  - A malformed row is an Err value, never a throw; the batch counts it under `dropped.malformed`
 *    and keeps the station's other rows. A malformed ENVELOPE fails the whole batch (decode error).
 *  - Times are ISO-8601 with an explicit offset or Z, parsed as instants: no time-zone math.
 */

type JsonObject = Readonly<Record<string, unknown>>;
type DepartureNetwork = Pick<LiveNetwork, 'lineOfTrip' | 'stationOfStop'>;

/** The stop a departures response is for: its stop_id and our station key for it. */
export type DepartureStop = { readonly stopId: string; readonly stationKey: string };

/** ISO-8601 date-time with seconds and an explicit offset (or Z): the only shape trusted as an instant. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Every in-scope prediction in one departures response, in response order. */
export function predictionsFromDepartures(json: unknown, network: DepartureNetwork): Result<MappedFeed<LivePrediction>, LiveError> {
  invariant(typeof network.stationOfStop === 'function', 'the stop → station lookup is injected');
  const stops = asObject(json)?.stops;
  if (!Array.isArray(stops)) {
    return malformed('the departures response has no stops array');
  }
  const dropped: Drops = {};
  const items: LivePrediction[] = [];
  for (const entry of stops) {
    const stop = asObject(entry);
    const stopId = stop === null ? null : textOf(stop.stop_id);
    const rows = stop?.departures;
    if (stopId === null || !Array.isArray(rows)) {
      return malformed('a stop in the departures response needs a stop_id and a departures array');
    }
    const stationKey = network.stationOfStop(stopId);
    if (stationKey === null) {
      countDropIfAny(dropped, 'unknown-stop', rows.length);
      continue;
    }
    for (const row of rows) {
      const mapped = predictionFromDepartureRow(row, { stopId, stationKey }, network);
      if (!mapped.ok) {
        countDrop(dropped, 'malformed');
      } else if (linesOfRoute(mapped.value.routeId).length === 0) {
        countDrop(dropped, 'out-of-scope');
      } else {
        items.push(mapped.value);
      }
    }
  }
  invariant(items.every((p) => p.realtime === (p.epoch !== null)), 'a realtime row has a predicted time, a scheduled-only row none');
  return ok({ items, feedTimestamp: null, dropped });
}

/** One departure row as a LivePrediction at `stop`, or an Err naming what is malformed. Never throws on bad input. */
export function predictionFromDepartureRow(row: unknown, stop: DepartureStop, network: Pick<LiveNetwork, 'lineOfTrip'>): Result<LivePrediction, LiveError> {
  invariant(stop.stopId.length > 0, 'a departure row belongs to a stop');
  invariant(stop.stationKey.includes(':'), 'a station key is mode:name');
  const trip = readTrip(row);
  if (!trip.ok) {
    return trip;
  }
  const times = readTimes(row);
  if (!times.ok) {
    return times;
  }
  const { tripId, routeId, relationship, headsign } = trip.value;
  const { scheduledEpoch, estimatedEpoch } = times.value;
  const realtime = relationship !== 'STATIC' && estimatedEpoch !== null;
  const epoch = realtime ? estimatedEpoch : null;
  return ok({
    tripId,
    routeId,
    lineId: tripLineOnRoute(tripId, routeId, network.lineOfTrip),
    stopId: stop.stopId,
    stationKey: stop.stationKey,
    epoch,
    scheduledEpoch,
    delayS: epoch !== null && scheduledEpoch !== null ? epoch - scheduledEpoch : null,
    realtime,
    canceled: relationship === 'CANCELED',
    headsign,
  });
}

type RowTrip = { readonly tripId: string; readonly routeId: string; readonly relationship: string; readonly headsign: string | null };

function readTrip(row: unknown): Result<RowTrip, LiveError> {
  const trip = asObject(asObject(row)?.trip);
  invariant(trip === null || typeof trip === 'object', 'a trip is an object or missing');
  if (trip === null) {
    return malformed('a departure row has no trip object');
  }
  const tripId = textOf(trip.trip_id);
  const relationship = textOf(trip.schedule_relationship);
  const routeId = textOf(asObject(trip.route)?.route_id);
  if (tripId === null || relationship === null || routeId === null) {
    return malformed('a departure row\'s trip needs trip_id, schedule_relationship and route.route_id');
  }
  const headsign = trip.trip_headsign;
  if (headsign !== undefined && headsign !== null && typeof headsign !== 'string') {
    return malformed('trip.trip_headsign is not text');
  }
  invariant(tripId.length > 0 && routeId.length > 0, 'the trip and route ids are present');
  return ok({ tripId, routeId, relationship, headsign: textOf(headsign) });
}

type RowTimes = { readonly scheduledEpoch: number | null; readonly estimatedEpoch: number | null };

function readTimes(row: unknown): Result<RowTimes, LiveError> {
  const object = asObject(row);
  invariant(object === null || typeof object === 'object', 'a row is an object or malformed');
  const event = asObject(object?.departure) ?? asObject(object?.arrival);
  if (event === null) {
    return malformed('a departure row has neither a departure nor an arrival');
  }
  const scheduled = optionalInstant(event.scheduled_local, 'scheduled_local');
  const estimated = optionalInstant(event.estimated_utc, 'estimated_utc');
  if (!scheduled.ok) {
    return scheduled;
  }
  if (!estimated.ok) {
    return estimated;
  }
  if (scheduled.value === null && estimated.value === null) {
    return malformed('a departure row has neither scheduled_local nor estimated_utc');
  }
  invariant(scheduled.value !== null || estimated.value !== null, 'a row says when');
  return ok({ scheduledEpoch: scheduled.value, estimatedEpoch: estimated.value });
}

/** An ISO-8601 instant as epoch seconds; null when absent (null, undefined or ''). */
function optionalInstant(value: unknown, field: string): Result<number | null, LiveError> {
  invariant(field.length > 0, 'the field is named for the error message');
  if (value === null || value === undefined || value === '') {
    return ok(null);
  }
  const ms = typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return malformed(`${field} is not an ISO-8601 instant with an offset: ${JSON.stringify(value)}`);
  }
  const epoch = Math.round(ms / 1000);
  invariant(Number.isSafeInteger(epoch), 'an instant is a whole epoch second');
  return ok(epoch);
}

/** A plain JSON object, or null for anything else (arrays, primitives, null). */
function asObject(value: unknown): JsonObject | null {
  const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  invariant(object === null || typeof object === 'object', 'an object or null');
  invariant(object === null || !Array.isArray(object), 'an array is not a JSON object');
  return object;
}

/** A non-empty string, or null for anything else. */
function textOf(value: unknown): string | null {
  const text = typeof value === 'string' && value.length > 0 ? value : null;
  invariant(text === null || typeof text === 'string', 'text or null');
  invariant(text === null || text.length > 0, 'present text is non-empty');
  return text;
}

function countDropIfAny(dropped: Drops, reason: 'unknown-stop', n: number): void {
  invariant(Number.isSafeInteger(n) && n >= 0, 'a row count is a whole number');
  if (n > 0) {
    countDrop(dropped, reason, n);
  }
  invariant(n === 0 || (dropped[reason] ?? 0) >= n, 'every row of an unknown stop was counted');
}

function malformed<T>(message: string): Result<T, LiveError> {
  invariant(message.length > 0, 'a decode error explains itself');
  const result = err<LiveError>({ kind: 'decode', message: `transitland departures: ${message}` });
  invariant(!result.ok, 'malformed() is always an Err');
  return result;
}
