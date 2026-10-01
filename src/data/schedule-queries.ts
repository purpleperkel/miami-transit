import type { ServiceCalendarBounds, ServiceDay, TimeWindow } from '../domain/gtfs/service-day';
import type { Mode } from '../domain/network/stations';
import type { StopVisit } from '../domain/schedule/departures';
import type { ScheduledTrip, ShapePath, TripStop } from '../domain/schedule/positions';
import type { RideCandidate } from '../domain/schedule/rides';
import type { LatLon } from '../lib/geo';
import { invariant } from '../lib/invariant';
import type { SqlExecutor, SqlRow, SqlValue } from './sql-executor';

/**
 * Every SQL statement the schedule engine runs (M3.2–M3.5), written against the plan §4 DDL, and
 * the checked readers that turn their rows into domain values.
 *
 * This module imports only the SqlExecutor CONTRACT, through relative paths — never expo-sqlite,
 * never node:sqlite, never the app's `@/` alias — so the phone runs it over expo-sqlite and the
 * node:test suites run it over node:sqlite against the real assets/db/schedule.db.
 *
 * Stop times are service-day seconds (`dep_s` 87240 = 24:14 of its service day). A query for one
 * service day takes the window translated into that day's seconds; the domain modules turn the
 * rows back into absolute instants.
 */

export type StationRef = { readonly stationIdx: number; readonly stationKey: string; readonly name: string; readonly mode: number };

/** A window translated into one service day's seconds: [fromS, toS] = window - base_epoch. */
export type DaySeconds = { readonly fromS: number; readonly toS: number };

const META_SQL = 'SELECT key, value FROM meta ORDER BY key';

const CALENDAR_BOUNDS_SQL = `
  SELECT f.date AS first_date, f.base_epoch AS first_base, l.date AS last_date, l.base_epoch AS last_base,
         (SELECT max(end_s) FROM trip) AS span_s
  FROM service_day AS f, service_day AS l
  WHERE f.date = (SELECT min(date) FROM service_day) AND l.date = (SELECT max(date) FROM service_day)`;

/** A superset of the days running during [from, to]: base <= to and base + span > from (service-day.ts decides). */
const SERVICE_DAYS_SQL = `
  SELECT date, base_epoch FROM service_day
  WHERE base_epoch <= :to_epoch AND base_epoch > :from_epoch - :span_s
  ORDER BY date`;

const STATION_SQL = 'SELECT station_idx, station_key, name, mode FROM station WHERE station_key = :station_key';

/** Every stop time at the station's stops on one service day whose departure falls in [from_s, to_s]. */
const STOP_VISITS_SQL = `
  SELECT st.trip_idx, t.trip_id, st.seq, p.stop_count - 1 AS last_seq, st.dep_s, s.stop_id,
         p.line_id, p.direction_id, d.station_key AS dest_station_key, d.name AS dest_name, t.note
  FROM stop AS s
  JOIN stop_time AS st ON st.stop_idx = s.stop_idx
  JOIN trip AS t ON t.trip_idx = st.trip_idx
  JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
  JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
  JOIN station AS d ON d.station_idx = p.dest_station_idx
  WHERE s.station_idx = :station_idx AND st.dep_s BETWEEN :from_s AND :to_s
  ORDER BY st.dep_s, st.trip_idx`;

/** The columns both ride branches select: the boarding, then where the rider reaches B. */
const RIDE_COLUMNS = `
  b.trip_idx AS board_trip_idx, b.seq AS board_seq, b.last_seq AS board_last_seq, b.dep_s AS board_dep_s,
  b.stop_id AS board_stop_id, b.line_id AS line_id,
  x.trip_idx AS alight_trip_idx, x.seq AS alight_seq, x.arr_s AS alight_arr_s,
  xs.stop_id AS alight_stop_id, xp.line_id AS alight_line_id`;

/**
 * Boardings at station A on one service day (departing in [from_s, to_s], not at the trip's last
 * stop), each joined to every visit to station B later on the same trip (direct) or anywhere on
 * the trip its vehicle runs next (`next_trip_idx`, one block hop). Both branches use the
 * (trip_idx, seq) primary key; rows come boarding by boarding, direct before hop.
 */
const RIDE_CANDIDATES_SQL = `
  WITH b AS (
    SELECT st.trip_idx, st.seq, p.stop_count - 1 AS last_seq, st.dep_s, s.stop_id, p.line_id, t.next_trip_idx
    FROM stop AS s
    JOIN stop_time AS st ON st.stop_idx = s.stop_idx
    JOIN trip AS t ON t.trip_idx = st.trip_idx
    JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
    JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
    WHERE s.station_idx = :from_station_idx AND st.dep_s BETWEEN :from_s AND :to_s AND st.seq < p.stop_count - 1
  )
  SELECT ${RIDE_COLUMNS}, 0 AS via_block_link
  FROM b
  JOIN stop_time AS x ON x.trip_idx = b.trip_idx AND x.seq > b.seq
  JOIN stop AS xs ON xs.stop_idx = x.stop_idx
  JOIN trip AS xt ON xt.trip_idx = x.trip_idx
  JOIN pattern AS xp ON xp.pattern_idx = xt.pattern_idx
  WHERE xs.station_idx = :to_station_idx
  UNION ALL
  SELECT ${RIDE_COLUMNS}, 1 AS via_block_link
  FROM b
  JOIN stop_time AS x ON x.trip_idx = b.next_trip_idx
  JOIN stop AS xs ON xs.stop_idx = x.stop_idx
  JOIN trip AS xt ON xt.trip_idx = x.trip_idx
  JOIN pattern AS xp ON xp.pattern_idx = xt.pattern_idx
  WHERE xs.station_idx = :to_station_idx
  ORDER BY board_dep_s, board_trip_idx, via_block_link, alight_arr_s`;

/**
 * Every trip of one service day running at some point in [from_s, to_s] (start_s <= to_s and
 * end_s >= from_s), with its stops in order: times, and each stop's distance along the trip's
 * shape (pattern_stop.dist_m, matched on the pattern and the stop's position).
 */
const TRIPS_AROUND_SQL = `
  SELECT t.trip_idx, t.trip_id, t.block_id, p.line_id, l.mode, p.direction_id, p.shape_idx,
         st.seq, st.arr_s, st.dep_s, ps.dist_m
  FROM trip AS t
  JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
  JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
  JOIN line AS l ON l.line_id = p.line_id
  JOIN stop_time AS st ON st.trip_idx = t.trip_idx
  JOIN pattern_stop AS ps ON ps.pattern_idx = t.pattern_idx AND ps.seq = st.seq
  WHERE t.start_s <= :to_s AND t.end_s >= :from_s
  ORDER BY t.trip_idx, st.seq`;

/** Every shape's points in order, with their cumulative distance (the M2.11 geometry, extensions included). */
const SHAPE_POINTS_SQL = 'SELECT shape_idx, seq, lat, lon, dist_m FROM shape_point ORDER BY shape_idx, seq';

/** line.mode as the schema stores it (scripts/gtfs/schema.ts MODE_CODES: rail 0, mover 1). */
const MODES_BY_CODE: ReadonlyMap<number, Mode> = new Map<number, Mode>([
  [0, 'rail'],
  [1, 'mover'],
]);

/** The meta table as a key → value map (schema_version, builder_version, feed_sha256, time_zone). */
export function readMeta(db: SqlExecutor): ReadonlyMap<string, string> {
  const rows = db.all(META_SQL);
  invariant(rows.length > 0, 'the schedule DB has a meta table with rows');
  const meta = new Map(rows.map((row) => [text(row, 'key'), text(row, 'value')] as const));
  invariant(meta.size === rows.length, 'meta keys are unique');
  return meta;
}

/** The calendar's first and last service days and the latest trip end (max end_s). */
export function readCalendarBounds(db: SqlExecutor): ServiceCalendarBounds {
  const row = db.get(CALENDAR_BOUNDS_SQL);
  invariant(row !== null, 'the schedule DB has service days');
  const bounds = {
    first: { date: int(row, 'first_date'), baseEpoch: int(row, 'first_base') },
    last: { date: int(row, 'last_date'), baseEpoch: int(row, 'last_base') },
    spanS: int(row, 'span_s'),
  };
  invariant(bounds.spanS > 0 && bounds.first.date <= bounds.last.date, 'the calendar spans at least one day with trips');
  return bounds;
}

/** service_day rows that may run during `window`, in date order (a superset; service-day.ts filters). */
export function readServiceDays(db: SqlExecutor, window: TimeWindow, spanS: number): ServiceDay[] {
  invariant(window.fromEpoch <= window.toEpoch, 'the window is ordered');
  invariant(spanS > 0, 'a service day spans > 0 s');
  const params = { from_epoch: window.fromEpoch, to_epoch: window.toEpoch, span_s: spanS };
  return db.all(SERVICE_DAYS_SQL, params).map((row) => ({ date: int(row, 'date'), baseEpoch: int(row, 'base_epoch') }));
}

export function findStation(db: SqlExecutor, stationKey: string): StationRef | null {
  invariant(stationKey.length > 0, 'a station key is non-empty');
  const row = db.get(STATION_SQL, { station_key: stationKey });
  invariant(row === null || text(row, 'station_key') === stationKey, 'the station found is the one asked for');
  return row === null ? null : { stationIdx: int(row, 'station_idx'), stationKey, name: text(row, 'name'), mode: int(row, 'mode') };
}

/** The window as seconds of the service day that counts from `day.baseEpoch`. */
export function daySeconds(day: ServiceDay, window: TimeWindow): DaySeconds {
  invariant(Number.isSafeInteger(day.baseEpoch), 'a service day has a whole base epoch');
  invariant(window.fromEpoch <= window.toEpoch, 'the window is ordered');
  return { fromS: window.fromEpoch - day.baseEpoch, toS: window.toEpoch - day.baseEpoch };
}

/** The station's stop visits on one service day departing inside `seconds` (terminating visits included; the domain drops them). */
export function readStopVisits(db: SqlExecutor, station: StationRef, day: ServiceDay, seconds: DaySeconds): StopVisit[] {
  invariant(seconds.fromS <= seconds.toS, 'the day window is ordered');
  const params = { date: day.date, station_idx: station.stationIdx, from_s: seconds.fromS, to_s: seconds.toS };
  const visits = db.all(STOP_VISITS_SQL, params).map(toStopVisit);
  invariant(visits.every((v) => v.depS >= seconds.fromS && v.depS <= seconds.toS), 'every visit departs inside the day window');
  return visits;
}

/** Ride candidates from station A to station B on one service day, boarding inside `seconds`. */
export function readRideCandidates(
  db: SqlExecutor,
  stations: { readonly from: StationRef; readonly to: StationRef },
  day: ServiceDay,
  seconds: DaySeconds,
): RideCandidate[] {
  invariant(stations.from.stationIdx !== stations.to.stationIdx, 'a ride joins two different stations');
  invariant(seconds.fromS <= seconds.toS, 'the day window is ordered');
  const params = {
    date: day.date,
    from_station_idx: stations.from.stationIdx,
    to_station_idx: stations.to.stationIdx,
    from_s: seconds.fromS,
    to_s: seconds.toS,
  };
  return db.all(RIDE_CANDIDATES_SQL, params).map(toRideCandidate);
}

/** The trips of one service day running at some point inside `seconds`, each with its stops in order. */
export function readTripsAround(db: SqlExecutor, day: ServiceDay, seconds: DaySeconds): ScheduledTrip[] {
  invariant(seconds.fromS <= seconds.toS, 'the day window is ordered');
  const rows = db.all(TRIPS_AROUND_SQL, { date: day.date, from_s: seconds.fromS, to_s: seconds.toS });
  const rowsByTrip = new Map<number, SqlRow[]>();
  for (const row of rows) {
    const tripIdx = int(row, 'trip_idx');
    const tripRows = rowsByTrip.get(tripIdx);
    if (tripRows === undefined) {
      rowsByTrip.set(tripIdx, [row]);
    } else {
      tripRows.push(row);
    }
  }
  const trips = [...rowsByTrip.values()].map(toScheduledTrip);
  invariant(trips.reduce((n, trip) => n + trip.stops.length, 0) === rows.length, 'every row is one stop of one trip');
  return trips;
}

/** One trip from its rows (one per stop, in stop order): the trip's fields, then each stop's times and distance. */
function toScheduledTrip(rows: readonly SqlRow[]): ScheduledTrip {
  const first = rows[0];
  invariant(first !== undefined && rows.length >= 2, 'a trip has at least two stop rows');
  invariant(rows.every((row, i) => int(row, 'seq') === i), `trip ${String(first.trip_id)} lists its stops 0, 1, 2…`);
  const mode = MODES_BY_CODE.get(int(first, 'mode'));
  invariant(mode !== undefined, `line.mode ${String(first.mode)} is rail (0) or mover (1)`);
  return {
    tripIdx: int(first, 'trip_idx'),
    tripId: text(first, 'trip_id'),
    blockId: text(first, 'block_id'),
    lineId: text(first, 'line_id'),
    mode,
    directionId: int(first, 'direction_id'),
    shapeIdx: int(first, 'shape_idx'),
    stops: rows.map((row): TripStop => ({ arrS: int(row, 'arr_s'), depS: int(row, 'dep_s'), distM: real(row, 'dist_m') })),
  };
}

/** Every shape's path (points and cumulative distances), by shape_idx. */
export function readShapePaths(db: SqlExecutor): ReadonlyMap<number, ShapePath> {
  const rows = db.all(SHAPE_POINTS_SQL);
  invariant(rows.length >= 2, 'the schedule DB has shape points');
  const paths = new Map<number, { points: LatLon[]; distM: number[] }>();
  for (const row of rows) {
    const shapeIdx = int(row, 'shape_idx');
    let path = paths.get(shapeIdx);
    if (path === undefined) {
      path = { points: [], distM: [] };
      paths.set(shapeIdx, path);
    }
    invariant(int(row, 'seq') === path.points.length, `shape ${shapeIdx} lists its points 0, 1, 2…`);
    path.points.push({ latitude: real(row, 'lat'), longitude: real(row, 'lon') });
    path.distM.push(real(row, 'dist_m'));
  }
  invariant([...paths.values()].every((p) => p.points.length >= 2 && p.distM[0] === 0), 'every shape has >= 2 points, measured from 0');
  return paths;
}

function toStopVisit(row: SqlRow): StopVisit {
  invariant(typeof row === 'object' && row !== null, 'a stop-visit row is an object');
  const note = row.note ?? null;
  invariant(note === null || typeof note === 'string', 'trip.note is text or null');
  return {
    tripIdx: int(row, 'trip_idx'),
    tripId: text(row, 'trip_id'),
    seq: int(row, 'seq'),
    lastSeq: int(row, 'last_seq'),
    depS: int(row, 'dep_s'),
    stopId: text(row, 'stop_id'),
    lineId: text(row, 'line_id'),
    directionId: int(row, 'direction_id'),
    destStationKey: text(row, 'dest_station_key'),
    destName: text(row, 'dest_name'),
    note,
  };
}

function toRideCandidate(row: SqlRow): RideCandidate {
  const viaBlockLink = int(row, 'via_block_link');
  invariant(viaBlockLink === 0 || viaBlockLink === 1, 'via_block_link is a 0/1 flag');
  const candidate = {
    boardTripIdx: int(row, 'board_trip_idx'),
    boardSeq: int(row, 'board_seq'),
    boardLastSeq: int(row, 'board_last_seq'),
    boardDepS: int(row, 'board_dep_s'),
    boardStopId: text(row, 'board_stop_id'),
    lineId: text(row, 'line_id'),
    alightTripIdx: int(row, 'alight_trip_idx'),
    alightSeq: int(row, 'alight_seq'),
    alightArrS: int(row, 'alight_arr_s'),
    alightStopId: text(row, 'alight_stop_id'),
    alightLineId: text(row, 'alight_line_id'),
    viaBlockLink: viaBlockLink === 1,
  };
  invariant(candidate.viaBlockLink === (candidate.alightTripIdx !== candidate.boardTripIdx), 'only a block hop changes trips');
  return candidate;
}

/** A column that must hold an integer. */
function int(row: SqlRow, column: string): number {
  const value: SqlValue | undefined = row[column];
  invariant(column in row, `the row has column ${column}`);
  invariant(typeof value === 'number' && Number.isSafeInteger(value), `${column} is an integer, got ${String(value)}`);
  return value;
}

/** A column that must hold a finite number (coordinates, metres). */
function real(row: SqlRow, column: string): number {
  const value: SqlValue | undefined = row[column];
  invariant(column in row, `the row has column ${column}`);
  invariant(typeof value === 'number' && Number.isFinite(value), `${column} is a finite number, got ${String(value)}`);
  return value;
}

/** A column that must hold text. */
function text(row: SqlRow, column: string): string {
  const value: SqlValue | undefined = row[column];
  invariant(column in row, `the row has column ${column}`);
  invariant(typeof value === 'string', `${column} is text, got ${String(value)}`);
  return value;
}
