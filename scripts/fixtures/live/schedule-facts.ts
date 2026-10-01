import type { SqlExecutor } from '../../../src/data/sql-executor';
import type { LineId } from '../../../src/domain/lines/line-catalog';
import { invariant } from '../../../src/lib/invariant';

/**
 * The public static GTFS facts the synthetic live fixtures are built from, read from
 * assets/db/schedule.db through the SqlExecutor contract (every query ordered, so every run reads the
 * same rows in the same order).
 */

/** One service day: its YYYYMMDD date, local midnight as an epoch, and New York's UTC offset that day. */
export type FixtureDay = { readonly date: number; readonly baseEpoch: number; readonly offsetS: number };

export function fixtureDay(db: SqlExecutor, date: number): FixtureDay {
  invariant(Number.isSafeInteger(date) && date > 20_000_000, `a service date is YYYYMMDD, got ${date}`);
  const row = db.get<{ base_epoch: number; noon_utc_offset_s: number }>('SELECT base_epoch, noon_utc_offset_s FROM service_day WHERE date = ?', [date]);
  invariant(row !== null, `schedule.db's calendar has no service day ${date} — pick a fixture date inside it`);
  return { date, baseEpoch: row.base_epoch, offsetS: row.noon_utc_offset_s };
}

/** A trip's schedule facts: its route, line, direction, pattern, shape and block, and when it starts. */
export type TripFacts = {
  readonly tripId: string;
  readonly routeId: string;
  readonly lineId: LineId;
  readonly directionId: number;
  readonly patternIdx: number;
  readonly shapeIdx: number;
  readonly shapeId: string;
  readonly blockId: string;
  readonly startS: number;
};

const TRIP_FACTS_SQL = `
  SELECT t.trip_id, p.route_id, p.line_id, p.direction_id, p.pattern_idx, p.shape_idx, sh.shape_id, t.block_id, t.start_s
  FROM trip t JOIN pattern p ON p.pattern_idx = t.pattern_idx JOIN shape sh ON sh.shape_idx = p.shape_idx
  WHERE t.trip_id = ?`;

type TripFactsRow = {
  trip_id: string;
  route_id: string;
  line_id: LineId;
  direction_id: number;
  pattern_idx: number;
  shape_idx: number;
  shape_id: string;
  block_id: string;
  start_s: number;
};

export function tripFacts(db: SqlExecutor, tripId: string): TripFacts {
  invariant(tripId.length > 0, 'a trip id is named');
  const row = db.get<TripFactsRow>(TRIP_FACTS_SQL, [tripId]);
  invariant(row !== null && row.trip_id === tripId, `trip ${tripId} is in schedule.db`);
  return {
    tripId,
    routeId: row.route_id,
    lineId: row.line_id,
    directionId: row.direction_id,
    patternIdx: row.pattern_idx,
    shapeIdx: row.shape_idx,
    shapeId: row.shape_id,
    blockId: row.block_id,
    startS: row.start_s,
  };
}

/** One stop of a pattern: its 0-based position, stop_id and metres along the pattern's shape. */
export type PatternStop = { readonly seq: number; readonly stopId: string; readonly distM: number };

export function patternStops(db: SqlExecutor, patternIdx: number): PatternStop[] {
  invariant(Number.isSafeInteger(patternIdx) && patternIdx >= 0, 'a pattern index is a whole number');
  const rows = db.all<{ seq: number; stop_id: string; dist_m: number }>(
    'SELECT ps.seq, s.stop_id, ps.dist_m FROM pattern_stop ps JOIN stop s ON s.stop_idx = ps.stop_idx WHERE ps.pattern_idx = ? ORDER BY ps.seq',
    [patternIdx],
  );
  invariant(rows.length >= 2, `pattern ${patternIdx} has at least two stops`);
  return rows.map((row) => ({ seq: row.seq, stopId: row.stop_id, distM: row.dist_m }));
}

/** A trip's call at one stop: its position in the trip, arrival and departure (service-day seconds), and metres along the shape. */
export type StopCall = { readonly seq: number; readonly arrS: number; readonly depS: number; readonly distM: number };

const STOP_CALL_SQL = `
  SELECT st.seq, st.arr_s, st.dep_s, ps.dist_m
  FROM stop_time st
  JOIN trip t ON t.trip_idx = st.trip_idx
  JOIN stop s ON s.stop_idx = st.stop_idx
  JOIN pattern_stop ps ON ps.pattern_idx = t.pattern_idx AND ps.seq = st.seq
  WHERE t.trip_id = ? AND s.stop_id = ?
  ORDER BY st.seq`;

export function stopCall(db: SqlExecutor, tripId: string, stopId: string): StopCall {
  invariant(tripId.length > 0 && stopId.length > 0, 'a call is a trip at a stop');
  const rows = db.all<{ seq: number; arr_s: number; dep_s: number; dist_m: number }>(STOP_CALL_SQL, [tripId, stopId]);
  invariant(rows.length === 1 && rows[0] !== undefined, `trip ${tripId} calls once at stop ${stopId}`);
  const row = rows[0];
  return { seq: row.seq, arrS: row.arr_s, depS: row.dep_s, distM: row.dist_m };
}

/** A stop as the departures response describes it. */
export type StopFacts = {
  readonly stopId: string;
  readonly code: string;
  readonly bound: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly stationName: string;
};

export function stopFacts(db: SqlExecutor, stopId: string): StopFacts {
  invariant(stopId.length > 0, 'a stop id is named');
  const row = db.get<{ code: string; bound: string | null; lat: number; lon: number; name: string }>(
    'SELECT s.code, s.bound, s.lat, s.lon, st.name FROM stop s JOIN station st ON st.station_idx = s.station_idx WHERE s.stop_id = ?',
    [stopId],
  );
  invariant(row !== null, `stop ${stopId} is in schedule.db`);
  return { stopId, code: row.code, bound: row.bound, latitude: row.lat, longitude: row.lon, stationName: row.name };
}

/** A shape's points with their cumulative metres, in order. */
export type ShapePoint = { readonly latitude: number; readonly longitude: number; readonly distM: number };

export function shapePoints(db: SqlExecutor, shapeIdx: number): ShapePoint[] {
  invariant(Number.isSafeInteger(shapeIdx) && shapeIdx >= 0, 'a shape index is a whole number');
  const rows = db.all<{ lat: number; lon: number; dist_m: number }>('SELECT lat, lon, dist_m FROM shape_point WHERE shape_idx = ? ORDER BY seq', [shapeIdx]);
  invariant(rows.length >= 2, `shape ${shapeIdx} has at least two points`);
  return rows.map((row) => ({ latitude: row.lat, longitude: row.lon, distM: row.dist_m }));
}

/** Every stop's coordinate (rail and Mover platforms), in stop order: anchors for the synthetic buses. */
export function stopCoordinates(db: SqlExecutor): { readonly latitude: number; readonly longitude: number }[] {
  invariant(typeof db.all === 'function', 'read through the executor');
  const rows = db.all<{ lat: number; lon: number }>('SELECT lat, lon FROM stop ORDER BY stop_idx');
  invariant(rows.length > 0, 'schedule.db has stops');
  return rows.map((row) => ({ latitude: row.lat, longitude: row.lon }));
}

/** The names of a route's lines, in catalog order ("Green Line / Orange Line"). */
export function routeLineNames(db: SqlExecutor, routeId: string): string {
  invariant(routeId.length > 0, 'a route id is named');
  const rows = db.all<{ name: string }>(
    'SELECT DISTINCT l.name, l.sort FROM pattern p JOIN line l ON l.line_id = p.line_id WHERE p.route_id = ? ORDER BY l.sort',
    [routeId],
  );
  invariant(rows.length > 0, `route ${routeId} has lines`);
  return rows.map((row) => row.name).join(' / ');
}
