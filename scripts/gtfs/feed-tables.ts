import { parseGtfsTime } from '../../src/domain/gtfs/time';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { parseCsv, type CsvError, type CsvRecord } from './parse-csv';
import type { FeedFileName } from './unzip-feed';

/**
 * The GTFS columns the pipeline reads, declared once per file, and the one converter that turns
 * parsed CSV text into typed rows. A value that does not fit its column is an Err naming the file,
 * line, column and value — the "time format" assertion of plan §4 step 5 lives here, in the
 * `time` kind. Rows keep GTFS's own snake_case column names, so a row reads like the spec.
 */

/**
 * id: non-empty text · text: any text · int: an integer · decimal: a decimal number ·
 * time: GTFS H:MM:SS → service seconds · date: YYYYMMDD → that number · flag: 0 or 1 ·
 * code: a one-digit enum where empty means 0 (pickup_type, location_type…).
 */
export type FieldKind = 'id' | 'text' | 'int' | 'decimal' | 'time' | 'date' | 'flag' | 'code';
type NumericKind = Exclude<FieldKind, 'id' | 'text'>;
type FieldValue<K> = K extends 'id' | 'text' ? string : number;
type Fields = Readonly<Record<string, FieldKind>>;

/** Required columns must be in the header; optional ones read as '' when absent (so: text or code). */
export type TableSchema = { readonly file: FeedFileName; readonly required: Fields; readonly optional: Fields };

type ColumnOf<S extends TableSchema> = Extract<keyof S['required'] | keyof S['optional'], string>;
type KindOf<S extends TableSchema, C extends string> = C extends keyof S['required']
  ? S['required'][C]
  : C extends keyof S['optional']
    ? S['optional'][C]
    : never;

export type TableRow<S extends TableSchema> = { readonly [C in ColumnOf<S>]: FieldValue<KindOf<S, C>> };
export type RawRow<S extends TableSchema> = Readonly<Record<ColumnOf<S>, string>>;

export type FieldError = {
  readonly kind: 'field';
  readonly file: string;
  readonly line: number;
  readonly column: string;
  readonly value: string;
  readonly message: string;
};
export type TableError = CsvError | FieldError;

export const AGENCY = {
  file: 'agency.txt',
  required: { agency_name: 'text', agency_timezone: 'id' },
  optional: { agency_id: 'text' },
} as const satisfies TableSchema;
export const ROUTES = {
  file: 'routes.txt',
  required: { route_id: 'id', route_type: 'int' },
  optional: { agency_id: 'text', route_short_name: 'text', route_long_name: 'text', route_color: 'text', route_text_color: 'text' },
} as const satisfies TableSchema;
/** direction_id and shape_id are optional in GTFS; this pipeline needs both on every in-scope trip. */
export const TRIPS = {
  file: 'trips.txt',
  required: { route_id: 'id', service_id: 'id', trip_id: 'id', direction_id: 'flag', shape_id: 'id' },
  optional: { trip_headsign: 'text', block_id: 'text' },
} as const satisfies TableSchema;
export const STOP_TIMES = {
  file: 'stop_times.txt',
  required: { trip_id: 'id', arrival_time: 'time', departure_time: 'time', stop_id: 'id', stop_sequence: 'int' },
  optional: { pickup_type: 'code', drop_off_type: 'code' },
} as const satisfies TableSchema;
export const STOPS = {
  file: 'stops.txt',
  required: { stop_id: 'id', stop_name: 'text', stop_lat: 'decimal', stop_lon: 'decimal' },
  optional: { stop_code: 'text', location_type: 'code', parent_station: 'text' },
} as const satisfies TableSchema;
export const CALENDAR = {
  file: 'calendar.txt',
  required: {
    service_id: 'id',
    monday: 'flag',
    tuesday: 'flag',
    wednesday: 'flag',
    thursday: 'flag',
    friday: 'flag',
    saturday: 'flag',
    sunday: 'flag',
    start_date: 'date',
    end_date: 'date',
  },
  optional: {},
} as const satisfies TableSchema;
export const CALENDAR_DATES = {
  file: 'calendar_dates.txt',
  required: { service_id: 'id', date: 'date', exception_type: 'int' },
  optional: {},
} as const satisfies TableSchema;
export const SHAPES = {
  file: 'shapes.txt',
  required: { shape_id: 'id', shape_pt_lat: 'decimal', shape_pt_lon: 'decimal', shape_pt_sequence: 'int' },
  optional: {},
} as const satisfies TableSchema;
export const FEED_INFO = {
  file: 'feed_info.txt',
  required: { feed_publisher_name: 'text', feed_publisher_url: 'text', feed_lang: 'text' },
  optional: { feed_start_date: 'text', feed_end_date: 'text', feed_version: 'text' },
} as const satisfies TableSchema;
/** Read only to assert that no in-scope trip is frequency-based (plan §4 step 5). */
export const FREQUENCIES = { file: 'frequencies.txt', required: { trip_id: 'id' }, optional: {} } as const satisfies TableSchema;

/** Parse one file into typed rows; `keep` filters on the raw text before any value is converted. */
export function readTable<S extends TableSchema>(
  schema: S,
  input: Uint8Array | string,
  keep?: (raw: RawRow<S>) => boolean,
): Result<TableRow<S>[], TableError> {
  const optional = Object.entries(schema.optional);
  invariant(optional.every(([, kind]) => kind === 'text' || kind === 'code'), `${schema.file}: optional columns must read '' sensibly`);
  invariant(optional.every(([column]) => !(column in schema.required)), `${schema.file}: no column is both required and optional`);
  const columns = {
    required: Object.keys(schema.required) as ColumnOf<S>[],
    optional: optional.map(([column]) => column) as ColumnOf<S>[],
  };
  const records = parseCsv(schema.file, input, columns, keep);
  if (!records.ok) {
    return records;
  }
  const kinds = { ...schema.optional, ...schema.required } as Readonly<Record<ColumnOf<S>, FieldKind>>;
  const rows: TableRow<S>[] = [];
  for (const record of records.value) {
    const row = convertRecord(schema.file, record, kinds);
    if (!row.ok) {
      return row;
    }
    rows.push(row.value as TableRow<S>);
  }
  return ok(rows);
}

function convertRecord<C extends string>(
  file: string,
  record: CsvRecord<C>,
  kinds: Readonly<Record<C, FieldKind>>,
): Result<Record<C, string | number>, FieldError> {
  invariant(record.line >= 2, 'a data record follows the header line');
  const row = {} as Record<C, string | number>;
  for (const column of Object.keys(kinds) as C[]) {
    const raw = record.fields[column];
    const value = convertField(kinds[column], raw);
    if (!value.ok) {
      const message = `${file} line ${record.line}: ${column} ${JSON.stringify(raw)} ${value.error}`;
      return err({ kind: 'field', file, line: record.line, column, value: raw, message });
    }
    row[column] = value.value;
  }
  invariant(Object.keys(row).length === Object.keys(kinds).length, 'every declared column is converted');
  return ok(row);
}

/** One field: text kinds stay strings, every other kind reads as a number, or an Err says why not. */
export function convertField(kind: FieldKind, raw: string): Result<string | number, string> {
  invariant(raw === raw.trim(), 'fields arrive trimmed by the CSV reader');
  if (kind === 'text' || kind === 'id') {
    return kind === 'id' && raw === '' ? err('is empty') : ok(raw);
  }
  const value = readNumber(kind, raw);
  invariant(value === null || Number.isFinite(value), 'a numeric field reads as a finite number');
  return value === null ? err(EXPECTED[kind]) : ok(value);
}

const EXPECTED: Readonly<Record<NumericKind, string>> = {
  int: 'is not an integer',
  decimal: 'is not a decimal number',
  time: 'is not a GTFS time (H:MM:SS, before 48:00:00)',
  date: 'is not a YYYYMMDD calendar date',
  flag: 'is not 0 or 1',
  code: 'is not a one-digit code',
};
const INTEGER = /^-?\d{1,15}$/;
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/;

function readNumber(kind: NumericKind, raw: string): number | null {
  invariant(kind in EXPECTED, 'readNumber reads numeric kinds only');
  let value: number | null = null;
  switch (kind) {
    case 'int':
      value = INTEGER.test(raw) ? Number(raw) : null;
      break;
    case 'decimal':
      value = DECIMAL.test(raw) ? Number(raw) : null;
      break;
    case 'time': {
      const seconds = parseGtfsTime(raw);
      value = seconds.ok ? seconds.value : null;
      break;
    }
    case 'date':
      value = calendarDate(raw);
      break;
    case 'flag':
      value = raw === '0' || raw === '1' ? Number(raw) : null;
      break;
    case 'code':
      value = raw === '' ? 0 : /^\d$/.test(raw) ? Number(raw) : null;
      break;
  }
  invariant(value === null || Number.isSafeInteger(value) || kind === 'decimal', 'only decimals may be fractional');
  return value;
}

/** YYYYMMDD → that number, when it names a real calendar day (leap years included); else null. */
function calendarDate(raw: string): number | null {
  invariant(typeof raw === 'string', 'calendarDate reads text');
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (match === null) {
    return null;
  }
  const [year, month, day] = match.slice(1, 4).map(Number);
  invariant(year !== undefined && month !== undefined && day !== undefined, 'the pattern has three groups');
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return monthDays !== undefined && day >= 1 && day <= monthDays ? Number(raw) : null;
}
