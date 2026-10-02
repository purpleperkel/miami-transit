import type { ServiceCalendarBounds, ServiceDay, TimeWindow } from '../domain/gtfs/service-day';
import type { Platform } from '../domain/hurry/platform';
import { LINE_IDS, type LineId } from '../domain/lines/line-catalog';
import type { LineTrack } from '../domain/live/types';
import type { Mode } from '../domain/network/stations';
import type { StopVisit } from '../domain/schedule/departures';
import type { ModeCalendar, ModeStart, ModeTrip } from '../domain/schedule/mode-status';
import type { RunStop, TripRun } from '../domain/schedule/next-stops';
import type { ScheduledTrip, ShapePath, TripStop } from '../domain/schedule/positions';
import type { RideCandidate } from '../domain/schedule/rides';
import { isLatLon, type LatLon } from '../lib/geo';
import { invariant } from '../lib/invariant';
import type { SqlExecutor, SqlRow, SqlValue } from './sql-executor';

/**
 * Every SQL statement the schedule engine runs (M3.2–M3.5, plus the live runtime's network lookups,
 * M4.9), written against the plan §4 DDL, and the checked readers that turn their rows into domain
 * values.
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

/** One station as the app lists and draws it (the Stations tab, M5.5; the map's station markers, M5.8). */
export type StationListing = {
  readonly stationKey: string;
  /** The display name (M2.9: Title Case, at most 28 characters). */
  readonly name: string;
  readonly mode: Mode;
  /** The centroid of the station's platform stops. */
  readonly coordinate: LatLon;
};

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

/** Every trip's line, through its stop pattern (the M2.10 derivation): what a live trip_id means (M4.9). */
const TRIP_LINES_SQL = 'SELECT t.trip_id, p.line_id FROM trip AS t JOIN pattern AS p ON p.pattern_idx = t.pattern_idx ORDER BY t.trip_id';

/** Every trip's destination: the station of its pattern's last stop (pattern.dest_station_idx) — what a vehicle tap names (mfix3 §5). */
const TRIP_DESTINATIONS_SQL = `
  SELECT t.trip_id, st.station_key
  FROM trip AS t
  JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
  JOIN station AS st ON st.station_idx = p.dest_station_idx
  ORDER BY t.trip_id`;

/** Every stop with its station: a live stop_id's station, and a station's stops (per-stop departures). */
const STOP_STATIONS_SQL = `
  SELECT s.stop_id, st.station_key
  FROM stop AS s JOIN station AS st ON st.station_idx = s.station_idx
  ORDER BY st.station_key, s.stop_id`;

/**
 * Every stop with its station, coordinates and each direction whose trains stop there (any pattern,
 * terminating or not): the platforms hurry-or-chill walks the rider to (M7c.3). Mover stop 813 at
 * Government Center lists both directions.
 */
const PLATFORMS_SQL = `
  SELECT DISTINCT s.stop_id, st.station_key, s.lat, s.lon, p.direction_id
  FROM stop AS s
  JOIN station AS st ON st.station_idx = s.station_idx
  JOIN pattern_stop AS ps ON ps.stop_idx = s.stop_idx
  JOIN pattern AS p ON p.pattern_idx = ps.pattern_idx
  ORDER BY st.station_key, s.stop_id, p.direction_id`;

/** Each line's track points (line_shape: rail = its longest direction-0 shape, Mover = all its shapes), in order. */
const LINE_TRACKS_SQL = `
  SELECT ls.line_id, ls.shape_idx, sp.seq, sp.lat, sp.lon
  FROM line_shape AS ls JOIN shape_point AS sp ON sp.shape_idx = ls.shape_idx
  ORDER BY ls.line_id, ls.shape_idx, sp.seq`;

/** Every station: rail before the Mover, each mode in name order (station_key breaks a tie). */
const STATIONS_SQL = 'SELECT station_key, name, mode, lat, lon FROM station ORDER BY mode, name, station_key';

/** Every line stopping at each station (any pattern, terminating or not), in the catalog's line order. */
const STATION_LINES_SQL = `
  SELECT DISTINCT x.station_key, p.line_id, l.sort
  FROM pattern_stop AS ps
  JOIN pattern AS p ON p.pattern_idx = ps.pattern_idx
  JOIN line AS l ON l.line_id = p.line_id
  JOIN stop AS s ON s.stop_idx = ps.stop_idx
  JOIN station AS x ON x.station_idx = s.station_idx
  ORDER BY x.station_key, l.sort`;

/**
 * Every station's FIRST departure in each direction on one service day, departing in [from_s, to_s]
 * (R7: the Stations list's inline next departures, one statement for the whole list). Trips are
 * narrowed by the trip_by_service_start index (start_s <= to_s, end_s >= from_s); a trip's last stop is
 * not a departure. Ties on dep_s go to the lower trip_idx, so the pick is the same on every run.
 */
const NEXT_DEPARTURES_SQL = `
  SELECT station_key, trip_idx, trip_id, seq, last_seq, dep_s, stop_id, line_id, direction_id, dest_station_key, dest_name, note
  FROM (
    SELECT x.station_key, t.trip_idx, t.trip_id, st.seq, p.stop_count - 1 AS last_seq, st.dep_s, s.stop_id, p.line_id,
           p.direction_id, d.station_key AS dest_station_key, d.name AS dest_name, t.note,
           ROW_NUMBER() OVER (PARTITION BY x.station_idx, p.direction_id ORDER BY st.dep_s, t.trip_idx) AS pick
    FROM trip AS t
    JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
    JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
    JOIN station AS d ON d.station_idx = p.dest_station_idx
    JOIN stop_time AS st ON st.trip_idx = t.trip_idx
    JOIN stop AS s ON s.stop_idx = st.stop_idx
    JOIN station AS x ON x.station_idx = s.station_idx
    WHERE t.start_s <= :to_s AND t.end_s >= :from_s AND st.dep_s BETWEEN :from_s AND :to_s AND st.seq < p.stop_count - 1
  )
  WHERE pick = 1
  ORDER BY station_key, direction_id`;

/** One trip's stops in order, each at its station, and the trip its car runs next (next_trip_idx). */
const TRIP_RUN_SQL = `
  SELECT st.seq, x.station_key, x.name, st.arr_s, st.dep_s, t.next_trip_idx
  FROM trip AS t
  JOIN stop_time AS st ON st.trip_idx = t.trip_idx
  JOIN stop AS s ON s.stop_idx = st.stop_idx
  JOIN station AS x ON x.station_idx = s.station_idx
  WHERE t.trip_idx = :trip_idx
  ORDER BY st.seq`;

/**
 * Every trip of one service day running at some point in [from_s, to_s], with its mode (mfix4: is a
 * mode running, or starting soon?). Narrowed by trip_by_service_start (start_s <= to_s).
 */
const MODE_TRIPS_AROUND_SQL = `
  SELECT l.mode, t.start_s, t.end_s
  FROM trip AS t
  JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
  JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
  JOIN line AS l ON l.line_id = p.line_id
  WHERE t.start_s <= :to_s AND t.end_s >= :from_s
  ORDER BY l.mode, t.start_s, t.trip_idx`;

/** Each mode's first trip on one service day starting after :after_s (trip_by_service_start: start_s > after_s). */
const MODE_STARTS_AFTER_SQL = `
  SELECT l.mode, min(t.start_s) AS start_s
  FROM trip AS t
  JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
  JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
  JOIN line AS l ON l.line_id = p.line_id
  WHERE t.start_s > :after_s
  GROUP BY l.mode
  ORDER BY l.mode`;

/**
 * Each mode's FIRST trip start on every service day of the calendar (mfix4: when a closed mode opens
 * again), in mode then date order: each service's first start per mode, then each date's earliest over
 * its active services. One scan of the trips, read once per DB (~1,260 rows on the 2026 feed).
 */
const MODE_CALENDAR_SQL = `
  WITH service_mode AS (
    SELECT t.service_idx, l.mode, min(t.start_s) AS first_s
    FROM trip AS t
    JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
    JOIN line AS l ON l.line_id = p.line_id
    GROUP BY t.service_idx, l.mode
  )
  SELECT sm.mode, a.date, sd.base_epoch, min(sm.first_s) AS start_s
  FROM service_day_active AS a
  JOIN service_mode AS sm ON sm.service_idx = a.service_idx
  JOIN service_day AS sd ON sd.date = a.date
  GROUP BY sm.mode, a.date
  ORDER BY sm.mode, a.date`;

/**
 * Every station a rider reaches from station A without changing vehicles, on ANY day of the bundled
 * timetable (M7.9, the add-trip flow's destinations): a later stop of a stop pattern that boards at A
 * (A not its last stop), or any stop of the pattern its vehicle runs next (`trip.next_trip_idx`, one
 * block hop) — the same two ride shapes RIDE_CANDIDATES_SQL joins, read per pattern rather than per
 * trip boarding, so no service day or window is involved. A itself is never a destination.
 */
const DIRECT_STATIONS_SQL = `
  WITH origin AS (
    SELECT ps.pattern_idx, ps.seq
    FROM stop AS s
    JOIN pattern_stop AS ps ON ps.stop_idx = s.stop_idx
    JOIN pattern AS p ON p.pattern_idx = ps.pattern_idx
    WHERE s.station_idx = :from_station_idx AND ps.seq < p.stop_count - 1
  ),
  hop AS (
    SELECT DISTINCT n.pattern_idx
    FROM trip AS t
    JOIN trip AS n ON n.trip_idx = t.next_trip_idx
    WHERE t.pattern_idx IN (SELECT pattern_idx FROM origin)
  ),
  reach AS (
    SELECT ps.stop_idx FROM origin AS o JOIN pattern_stop AS ps ON ps.pattern_idx = o.pattern_idx AND ps.seq > o.seq
    UNION
    SELECT ps.stop_idx FROM hop AS h JOIN pattern_stop AS ps ON ps.pattern_idx = h.pattern_idx
  )
  SELECT DISTINCT x.station_key
  FROM reach AS r
  JOIN stop AS s ON s.stop_idx = r.stop_idx
  JOIN station AS x ON x.station_idx = s.station_idx
  WHERE x.station_idx <> :from_station_idx
  ORDER BY x.station_key`;

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

/** trip_id → its pattern's line, for every trip in the schedule. */
export function readTripLines(db: SqlExecutor): ReadonlyMap<string, LineId> {
  const rows = db.all(TRIP_LINES_SQL);
  const lines = new Map(rows.map((row) => [text(row, 'trip_id'), lineId(row)] as const));
  invariant(lines.size === rows.length, 'trip ids are unique');
  invariant(lines.size > 0, 'the schedule DB has trips');
  return lines;
}

/** trip_id → the station key of the trip's last stop, for every trip in the schedule. */
export function readTripDestinations(db: SqlExecutor): ReadonlyMap<string, string> {
  const rows = db.all(TRIP_DESTINATIONS_SQL);
  const destinations = new Map(rows.map((row) => [text(row, 'trip_id'), text(row, 'station_key')] as const));
  invariant(destinations.size === rows.length, 'trip ids are unique');
  invariant(destinations.size > 0, 'the schedule DB has trips, each running to a station');
  return destinations;
}

/** stop_id → station key, and station key → its stop_ids (sorted), for every stop in the schedule. */
export function readStopStations(db: SqlExecutor): { readonly stationOfStop: ReadonlyMap<string, string>; readonly stopsOfStation: ReadonlyMap<string, readonly string[]> } {
  const rows = db.all(STOP_STATIONS_SQL);
  const stationOfStop = new Map<string, string>();
  const stopsOfStation = new Map<string, string[]>();
  for (const row of rows) {
    const [stopId, stationKey] = [text(row, 'stop_id'), text(row, 'station_key')];
    stationOfStop.set(stopId, stationKey);
    stopsOfStation.set(stationKey, [...(stopsOfStation.get(stationKey) ?? []), stopId]);
  }
  invariant(stationOfStop.size === rows.length && rows.length > 0, 'stop ids are unique, and the DB has stops');
  invariant([...stopsOfStation.values()].every((stops) => stops.length > 0), 'every station listed has a stop');
  return { stationOfStop, stopsOfStation };
}

/** Every platform a train stops at, in station then stop order, each with its directions in order. */
export function readPlatforms(db: SqlExecutor): Platform[] {
  const byStop = new Map<string, { stationKey: string; stopId: string; directionIds: number[]; latitude: number; longitude: number }>();
  for (const row of db.all(PLATFORMS_SQL)) {
    const stopId = text(row, 'stop_id');
    const coordinate = { latitude: real(row, 'lat'), longitude: real(row, 'lon') };
    invariant(isLatLon(coordinate), `stop ${stopId} sits on a real coordinate`);
    const platform = byStop.get(stopId) ?? { stationKey: text(row, 'station_key'), stopId, directionIds: [], ...coordinate };
    platform.directionIds.push(int(row, 'direction_id'));
    byStop.set(stopId, platform);
  }
  const platforms = [...byStop.values()];
  invariant(platforms.length > 0, 'the schedule DB has platforms');
  invariant(platforms.every((p) => p.directionIds.length > 0 && new Set(p.directionIds).size === p.directionIds.length), 'each platform lists each of its directions once');
  return platforms;
}

/** One track per (line, shape) in line_shape, each its shape's points in order. */
export function readLineTracks(db: SqlExecutor): LineTrack[] {
  const rows = db.all(LINE_TRACKS_SQL);
  const tracks = new Map<string, { lineId: LineId; points: LatLon[] }>();
  for (const row of rows) {
    const key = `${text(row, 'line_id')}:${int(row, 'shape_idx')}`;
    const track = tracks.get(key) ?? { lineId: lineId(row), points: [] };
    tracks.set(key, track);
    invariant(int(row, 'seq') === track.points.length, `track ${key} lists its points 0, 1, 2…`);
    track.points.push({ latitude: real(row, 'lat'), longitude: real(row, 'lon') });
  }
  const list = [...tracks.values()];
  invariant(list.length > 0 && list.every((track) => track.points.length >= 2), 'every line has a track of at least one segment');
  return list;
}

/** Every station in the schedule, rail first, each mode in name order. */
export function readStations(db: SqlExecutor): StationListing[] {
  const stations = db.all(STATIONS_SQL).map(toStationListing);
  invariant(stations.length > 0, 'the schedule DB has stations');
  invariant(new Set(stations.map((station) => station.stationKey)).size === stations.length, 'station keys are unique');
  return stations;
}

/** station key -> every line stopping there, in line order (the Stations list's line strips, M6.5). */
export function readStationLines(db: SqlExecutor): ReadonlyMap<string, readonly LineId[]> {
  const lines = new Map<string, LineId[]>();
  for (const row of db.all(STATION_LINES_SQL)) {
    const key = text(row, 'station_key');
    lines.set(key, [...(lines.get(key) ?? []), lineId(row)]);
  }
  invariant(lines.size > 0, 'the schedule DB has stations served by lines');
  invariant([...lines.values()].every((ids) => new Set(ids).size === ids.length), 'each line is listed once per station');
  return lines;
}

/** One station's first departure per direction on one service day, inside `seconds` (terminating visits excluded). */
export type StationVisit = { readonly stationKey: string; readonly visit: StopVisit };

/** Every station's first departure in each direction on one service day, departing inside `seconds`. */
export function readNextDepartures(db: SqlExecutor, day: ServiceDay, seconds: DaySeconds): StationVisit[] {
  invariant(seconds.fromS <= seconds.toS, 'the day window is ordered');
  const rows = db.all(NEXT_DEPARTURES_SQL, { date: day.date, from_s: seconds.fromS, to_s: seconds.toS });
  const visits = rows.map((row) => ({ stationKey: text(row, 'station_key'), visit: toStopVisit(row) }));
  invariant(visits.every(({ visit }) => visit.seq < visit.lastSeq && visit.depS >= seconds.fromS && visit.depS <= seconds.toS), 'each is a departure inside the window');
  return visits;
}

/** One trip's stops in order and the trip its car runs next, or null when the schedule has no such trip. */
export function readTripRun(db: SqlExecutor, tripIdx: number): TripRun | null {
  invariant(Number.isSafeInteger(tripIdx) && tripIdx >= 0, `a trip is indexed, got ${tripIdx}`);
  const rows = db.all(TRIP_RUN_SQL, { trip_idx: tripIdx });
  if (rows.length === 0) {
    return null;
  }
  const next = (rows[0] as SqlRow).next_trip_idx ?? null;
  invariant(next === null || (typeof next === 'number' && Number.isSafeInteger(next)), 'next_trip_idx is a trip index or null');
  const stops = rows.map((row): RunStop => ({ seq: int(row, 'seq'), stationKey: text(row, 'station_key'), name: text(row, 'name'), arrS: int(row, 'arr_s'), depS: int(row, 'dep_s') }));
  return { tripIdx, stops, nextTripIdx: next };
}

/** One service day's trips running at some point inside `seconds`, each with its mode (mfix4). */
export function readModeTripsAround(db: SqlExecutor, day: ServiceDay, seconds: DaySeconds): ModeTrip[] {
  invariant(seconds.fromS <= seconds.toS, 'the day window is ordered');
  const trips = db.all(MODE_TRIPS_AROUND_SQL, { date: day.date, from_s: seconds.fromS, to_s: seconds.toS }).map(
    (row): ModeTrip => ({ mode: modeOf(row), startS: int(row, 'start_s'), endS: int(row, 'end_s') }),
  );
  invariant(trips.every((trip) => trip.startS <= seconds.toS && trip.endS >= seconds.fromS), 'every trip runs inside the day window');
  return trips;
}

/** Each mode's first trip on one service day starting after `afterS` of that day (mfix4); a mode with none is absent. */
export function readModeStartsAfter(db: SqlExecutor, day: ServiceDay, afterS: number): ModeStart[] {
  invariant(Number.isSafeInteger(afterS), `a day second is whole, got ${afterS}`);
  const starts = db.all(MODE_STARTS_AFTER_SQL, { date: day.date, after_s: afterS }).map(
    (row): ModeStart => ({ mode: modeOf(row), serviceDate: day.date, baseEpoch: day.baseEpoch, startS: int(row, 'start_s') }),
  );
  invariant(starts.every((start) => start.startS > afterS), 'every start is after the instant');
  return starts;
}

/** Each mode's first trip start on every service day of the calendar, in date order (mfix4). */
export function readModeCalendar(db: SqlExecutor): ModeCalendar {
  const calendar: Record<Mode, ModeStart[]> = { rail: [], mover: [] };
  for (const row of db.all(MODE_CALENDAR_SQL)) {
    const mode = modeOf(row);
    calendar[mode].push({ mode, serviceDate: int(row, 'date'), baseEpoch: int(row, 'base_epoch'), startS: int(row, 'start_s') });
  }
  invariant(calendar.rail.length + calendar.mover.length > 0, 'the schedule DB has service days with trips');
  invariant(
    Object.values(calendar).every((days) => days.every((start, i) => i === 0 || days[i - 1]!.serviceDate < start.serviceDate)),
    'each mode lists its service days once, in date order',
  );
  return calendar;
}

/** The keys of every station reached from `from` without changing vehicles, on any day of the timetable (M7.9). */
export function readDirectStationKeys(db: SqlExecutor, from: StationRef): ReadonlySet<string> {
  invariant(Number.isSafeInteger(from.stationIdx) && from.stationIdx >= 0, `a station is indexed, got ${from.stationIdx}`);
  const keys = new Set(db.all(DIRECT_STATIONS_SQL, { from_station_idx: from.stationIdx }).map((row) => text(row, 'station_key')));
  invariant(!keys.has(from.stationKey), 'a station is never its own destination');
  return keys;
}

/** The row's line.mode as a Mode. */
function modeOf(row: SqlRow): Mode {
  const mode = MODES_BY_CODE.get(int(row, 'mode'));
  invariant(mode !== undefined, `line.mode ${String(row.mode)} is rail (0) or mover (1)`);
  invariant(mode === 'rail' || mode === 'mover', 'a mode is rail or mover');
  return mode;
}

function toStationListing(row: SqlRow): StationListing {
  const mode = MODES_BY_CODE.get(int(row, 'mode'));
  invariant(mode !== undefined, `station.mode ${String(row.mode)} is rail (0) or mover (1)`);
  const coordinate = { latitude: real(row, 'lat'), longitude: real(row, 'lon') };
  invariant(isLatLon(coordinate), `station ${String(row.station_key)} sits on a real coordinate`);
  return { stationKey: text(row, 'station_key'), name: text(row, 'name'), mode, coordinate };
}

/** The row's line_id, which must be a catalog line. */
function lineId(row: SqlRow): LineId {
  const id = text(row, 'line_id');
  invariant((LINE_IDS as readonly string[]).includes(id), `line_id "${id}" is a catalog line`);
  invariant(id.length > 0, 'a line id is never empty');
  return id as LineId;
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
