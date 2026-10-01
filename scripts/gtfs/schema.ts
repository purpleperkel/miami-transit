import type { Mode } from '../../src/domain/network/stations';
import { invariant } from '../../src/lib/invariant';

/**
 * Plan §4 "GTFS pipeline" (M2.15): the schedule DB schema, version 1 (`PRAGMA user_version`).
 *
 * SCHEMA_DDL is the plan's DDL VERBATIM — copied into the plan on 2026-10-01 from the design
 * agent's output, plus the M2.11 shape-end ruling's `shape.extended_start_m` / `extended_end_m` (one
 * column per end, arbiter 2026-10-01). TABLES declares the same
 * columns, in the same order, with the TypeScript type each row value has; the writer's tests prove
 * the two agree column by column against `PRAGMA table_info`, so a row can never bind to the wrong
 * column silently.
 *
 * Conventions the queries (M3) rely on:
 *  - every *_idx is a dense 0-based index in a fixed sort order (stable for the same feed);
 *  - stop_time.seq and pattern_stop.seq are both 0-based positions, so a trip's stop i is its
 *    pattern's stop i (`JOIN pattern_stop USING (seq)` on the trip's pattern_idx);
 *  - times are GTFS service seconds (may pass 86400); an instant is service_day.base_epoch + seconds;
 *  - mode is MODE_CODES (rail 0, mover 1).
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE line(line_id TEXT PRIMARY KEY, mode INTEGER NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE station(station_idx INTEGER PRIMARY KEY, station_key TEXT NOT NULL UNIQUE, mode INTEGER NOT NULL, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE stop(stop_idx INTEGER PRIMARY KEY, stop_id TEXT NOT NULL UNIQUE, station_idx INTEGER NOT NULL, code TEXT NOT NULL, bound TEXT, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE INDEX stop_by_station ON stop(station_idx);
CREATE TABLE shape(shape_idx INTEGER PRIMARY KEY, shape_id TEXT NOT NULL UNIQUE, length_m REAL NOT NULL, extended_start_m REAL NOT NULL DEFAULT 0, extended_end_m REAL NOT NULL DEFAULT 0);
CREATE TABLE shape_point(shape_idx INTEGER NOT NULL, seq INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, dist_m REAL NOT NULL, PRIMARY KEY(shape_idx,seq)) WITHOUT ROWID;
CREATE TABLE line_shape(line_id TEXT NOT NULL, shape_idx INTEGER NOT NULL, PRIMARY KEY(line_id,shape_idx)) WITHOUT ROWID; -- rail: longest dir-0 shape per line; mover: all shapes
CREATE TABLE pattern(pattern_idx INTEGER PRIMARY KEY, route_id TEXT NOT NULL, line_id TEXT NOT NULL, variant TEXT NOT NULL, direction_id INTEGER NOT NULL, shape_idx INTEGER NOT NULL, dest_station_idx INTEGER NOT NULL, stop_count INTEGER NOT NULL);
CREATE TABLE pattern_stop(pattern_idx INTEGER NOT NULL, seq INTEGER NOT NULL, stop_idx INTEGER NOT NULL, dist_m REAL NOT NULL, PRIMARY KEY(pattern_idx,seq)) WITHOUT ROWID;
CREATE INDEX pattern_stop_by_stop ON pattern_stop(stop_idx);
CREATE TABLE service(service_idx INTEGER PRIMARY KEY, service_id TEXT NOT NULL UNIQUE);
CREATE TABLE service_day(date INTEGER PRIMARY KEY, base_epoch INTEGER NOT NULL, noon_utc_offset_s INTEGER NOT NULL);
CREATE TABLE service_day_active(date INTEGER NOT NULL, service_idx INTEGER NOT NULL, PRIMARY KEY(date,service_idx)) WITHOUT ROWID;
CREATE TABLE trip(trip_idx INTEGER PRIMARY KEY, trip_id TEXT NOT NULL UNIQUE, service_idx INTEGER NOT NULL, pattern_idx INTEGER NOT NULL, block_id TEXT NOT NULL, start_s INTEGER NOT NULL, end_s INTEGER NOT NULL, note TEXT, next_trip_idx INTEGER);
CREATE INDEX trip_by_service_start ON trip(service_idx, start_s);
CREATE TABLE stop_time(trip_idx INTEGER NOT NULL, seq INTEGER NOT NULL, stop_idx INTEGER NOT NULL, arr_s INTEGER NOT NULL, dep_s INTEGER NOT NULL, PRIMARY KEY(trip_idx,seq)) WITHOUT ROWID;
CREATE INDEX stop_time_by_stop_dep ON stop_time(stop_idx, dep_s);
CREATE TABLE transfer(from_station_idx INTEGER NOT NULL, to_station_idx INTEGER NOT NULL, walk_s INTEGER NOT NULL, PRIMARY KEY(from_station_idx,to_station_idx)) WITHOUT ROWID;
`;

/** text / int / real are NOT NULL; the '?' kinds may hold NULL. Each maps to the DDL's declared type. */
export type ColumnKind = 'text' | 'int' | 'real' | 'text?' | 'int?';

/** The 15 tables, in DDL order (also the insert order), each with its columns in DDL order. */
export const TABLES = {
  meta: { key: 'text', value: 'text' },
  line: { line_id: 'text', mode: 'int', name: 'text', sort: 'int' },
  station: { station_idx: 'int', station_key: 'text', mode: 'int', name: 'text', lat: 'real', lon: 'real' },
  stop: { stop_idx: 'int', stop_id: 'text', station_idx: 'int', code: 'text', bound: 'text?', lat: 'real', lon: 'real' },
  shape: { shape_idx: 'int', shape_id: 'text', length_m: 'real', extended_start_m: 'real', extended_end_m: 'real' },
  shape_point: { shape_idx: 'int', seq: 'int', lat: 'real', lon: 'real', dist_m: 'real' },
  line_shape: { line_id: 'text', shape_idx: 'int' },
  pattern: {
    pattern_idx: 'int',
    route_id: 'text',
    line_id: 'text',
    variant: 'text',
    direction_id: 'int',
    shape_idx: 'int',
    dest_station_idx: 'int',
    stop_count: 'int',
  },
  pattern_stop: { pattern_idx: 'int', seq: 'int', stop_idx: 'int', dist_m: 'real' },
  service: { service_idx: 'int', service_id: 'text' },
  service_day: { date: 'int', base_epoch: 'int', noon_utc_offset_s: 'int' },
  service_day_active: { date: 'int', service_idx: 'int' },
  trip: {
    trip_idx: 'int',
    trip_id: 'text',
    service_idx: 'int',
    pattern_idx: 'int',
    block_id: 'text',
    start_s: 'int',
    end_s: 'int',
    note: 'text?',
    next_trip_idx: 'int?',
  },
  stop_time: { trip_idx: 'int', seq: 'int', stop_idx: 'int', arr_s: 'int', dep_s: 'int' },
  transfer: { from_station_idx: 'int', to_station_idx: 'int', walk_s: 'int' },
} as const satisfies Record<string, Record<string, ColumnKind>>;

export type TableName = keyof typeof TABLES;
/** Table names in DDL order (string keys keep their declaration order). */
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

type ValueOf<K extends ColumnKind> = K extends 'text' ? string : K extends 'text?' ? string | null : K extends 'int?' ? number | null : number;
/** One row of `T`, typed column by column from TABLES. */
export type Row<T extends TableName> = { readonly [C in keyof (typeof TABLES)[T]]: ValueOf<(typeof TABLES)[T][C] & ColumnKind> };
/** Every row of every table — what the writer writes. */
export type ScheduleRows = { readonly [T in TableName]: readonly Row<T>[] };

/** The `mode` column's codes. */
export const MODE_CODES = { rail: 0, mover: 1 } as const satisfies Record<Mode, number>;

/** The SQLite declared type of a column kind (`PRAGMA table_info(...).type`). */
export function declaredType(kind: ColumnKind): 'TEXT' | 'INTEGER' | 'REAL' {
  invariant(kind.length > 0, 'a column has a kind');
  const type = kind.startsWith('text') ? 'TEXT' : kind.startsWith('int') ? 'INTEGER' : 'REAL';
  invariant(kind !== 'real' || type === 'REAL', 'real columns are REAL');
  return type;
}

/** The column names of `table`, in DDL order. */
export function columnsOf(table: TableName): string[] {
  invariant(table in TABLES, `${table} is a schema table`);
  const columns = Object.keys(TABLES[table]);
  invariant(columns.length > 0, `${table} has columns`);
  return columns;
}

/** `INSERT INTO t (a, b) VALUES (:a, :b)` for every column of `table`, bound by name. */
export function insertSql(table: TableName): string {
  const columns = columnsOf(table);
  invariant(columns.every((column) => /^[a-z_]+$/.test(column)), 'column names are plain identifiers');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`;
  invariant(sql.startsWith('INSERT INTO'), 'an insert statement');
  return sql;
}
