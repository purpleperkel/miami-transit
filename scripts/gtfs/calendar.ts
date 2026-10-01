import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import type { CalendarDate, CalendarRow } from './load-feed';
import { FEED_TIME_ZONE } from './scope';

/**
 * Plan §4 step 10 (M2.14): expand calendar.txt + calendar_dates.txt into service days, each with
 * its `base_epoch`, computed here on the Mac with Intl so the phone never does time-zone math
 * (a departure's instant is just `base_epoch + dep_s`).
 *
 * GTFS times count from "noon minus 12 h" of the service date, NOT local midnight. The two differ
 * only on daylight-saving days: on 20261101 (DST ends) noon EST minus 12 h is 1793509200, while
 * local midnight (still EDT) is 1793505600. Using midnight would shift every departure of that day
 * by an hour.
 */

export type ServiceDay = {
  /** YYYYMMDD. */
  readonly date: number;
  readonly baseEpoch: number;
  /** The services that run on this date, sorted. */
  readonly serviceIds: readonly string[];
};

export type ServiceCalendar = {
  /** Every service id the calendar defines, sorted. */
  readonly serviceIds: readonly string[];
  /** One row per date from the first service date to the last, in date order. */
  readonly days: readonly ServiceDay[];
};

export type CalendarError = { readonly kind: 'calendar'; readonly message: string };

const SECONDS_PER_DAY = 86_400;
const HALF_DAY_SECONDS = 43_200;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;
const WEEKDAY_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** The epoch second a GTFS service day counts from: local noon of `yyyymmdd`, minus 12 hours. */
export function baseEpoch(yyyymmdd: number, timeZone: string = FEED_TIME_ZONE): number {
  const { year, month, day } = splitDate(yyyymmdd);
  const noonAsUtc = Date.UTC(year, month - 1, day, 12) / 1000;
  // The instant whose wall clock reads noon: start from noon-as-UTC and correct by the zone offset,
  // re-checking once in case the first guess sat on the other side of an offset change.
  let noon = noonAsUtc - utcOffsetSeconds(noonAsUtc, timeZone);
  noon = noonAsUtc - utcOffsetSeconds(noon, timeZone);
  invariant(noon + utcOffsetSeconds(noon, timeZone) === noonAsUtc, `${yyyymmdd} has a local noon in ${timeZone}`);
  const base = noon - HALF_DAY_SECONDS;
  invariant(Number.isSafeInteger(base) && base % 60 === 0, 'a base epoch is a whole minute');
  return base;
}

/** Expand the in-scope calendar into dated service days (exceptions applied: 1 adds, 2 removes). */
export function expandCalendar(
  calendar: readonly CalendarRow[],
  exceptions: readonly CalendarDate[],
  timeZone: string = FEED_TIME_ZONE,
): Result<ServiceCalendar, CalendarError> {
  invariant(calendar.length + exceptions.length > 0, 'a feed defines at least one service');
  invariant(exceptions.every((row) => row.exception_type === 1 || row.exception_type === 2), 'exceptions are adds (1) or removals (2)');
  const backwards = calendar.find((row) => row.end_date < row.start_date);
  if (backwards !== undefined) {
    return err({ kind: 'calendar', message: `calendar.txt service ${backwards.service_id} ends (${backwards.end_date}) before it starts (${backwards.start_date})` });
  }
  const dates = [...calendar.flatMap((row) => [row.start_date, row.end_date]), ...exceptions.map((row) => row.date)];
  const first = epochDay(Math.min(...dates));
  const last = epochDay(Math.max(...dates));
  const days: ServiceDay[] = [];
  for (let n = first; n <= last; n += 1) {
    const date = dateOfEpochDay(n);
    days.push({ date, baseEpoch: baseEpoch(date, timeZone), serviceIds: activeServices(calendar, exceptions, date) });
  }
  const serviceIds = [...new Set([...calendar, ...exceptions].map((row) => row.service_id))].sort();
  invariant(days.length === last - first + 1, 'one service day per date, no gaps');
  return ok({ serviceIds, days });
}

/** The services running on `date`: the weekly pattern inside its date range, then that date's exceptions. */
function activeServices(calendar: readonly CalendarRow[], exceptions: readonly CalendarDate[], date: number): string[] {
  const weekday = WEEKDAY_COLUMNS[new Date(epochDay(date) * MS_PER_DAY).getUTCDay()];
  invariant(weekday !== undefined, 'every date falls on a weekday');
  const active = new Set(
    calendar.filter((row) => row[weekday] === 1 && row.start_date <= date && date <= row.end_date).map((row) => row.service_id),
  );
  for (const exception of exceptions.filter((row) => row.date === date)) {
    if (exception.exception_type === 1) {
      active.add(exception.service_id);
    } else {
      active.delete(exception.service_id);
    }
  }
  const sorted = [...active].sort();
  invariant(new Set(sorted).size === sorted.length, 'each service is listed once');
  return sorted;
}

/** Seconds to add to UTC to read the wall clock in `timeZone` at `epochSeconds`. */
function utcOffsetSeconds(epochSeconds: number, timeZone: string): number {
  invariant(Number.isFinite(epochSeconds), 'the offset is asked for a real instant');
  const parts = wallClockFormat(timeZone).formatToParts(new Date(epochSeconds * 1000));
  const wallAsUtc =
    Date.UTC(
      partValue(parts, 'year'),
      partValue(parts, 'month') - 1,
      partValue(parts, 'day'),
      partValue(parts, 'hour'),
      partValue(parts, 'minute'),
      partValue(parts, 'second'),
    ) / 1000;
  const offset = wallAsUtc - epochSeconds;
  invariant(Number.isInteger(offset) && Math.abs(offset) <= 14 * 3600, `${timeZone} has a whole-second offset within ±14 h`);
  return offset;
}

function partValue(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  invariant(parts.length > 0, 'a formatted instant has parts');
  const value = Number(parts.find((part) => part.type === type)?.value);
  invariant(Number.isInteger(value), `the wall clock has a numeric ${type}`);
  return value;
}

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

/** One cached formatter per zone, reading the wall clock as 24-hour numeric fields. */
function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
  invariant(timeZone.length > 0, 'a time zone is named');
  let format = wallClockFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClockFormats.set(timeZone, format);
  }
  invariant(format.resolvedOptions().timeZone === timeZone, `Intl knows the time zone ${timeZone} by that name`);
  return format;
}

function splitDate(yyyymmdd: number): { year: number; month: number; day: number } {
  invariant(Number.isInteger(yyyymmdd) && yyyymmdd >= 19000101 && yyyymmdd <= 29991231, `${yyyymmdd} is a YYYYMMDD date`);
  const parts = { year: Math.floor(yyyymmdd / 10000), month: Math.floor(yyyymmdd / 100) % 100, day: yyyymmdd % 100 };
  const roundTrip = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  invariant(roundTrip.getUTCMonth() === parts.month - 1 && roundTrip.getUTCDate() === parts.day, `${yyyymmdd} is a real calendar date`);
  return parts;
}

/** Days since 1970-01-01 of a civil date (no time zone involved). */
function epochDay(yyyymmdd: number): number {
  const { year, month, day } = splitDate(yyyymmdd);
  const n = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  invariant(Number.isInteger(n), 'a civil date is a whole number of days from the epoch');
  invariant(dateOfEpochDay(n) === yyyymmdd, 'epoch days round-trip');
  return n;
}

function dateOfEpochDay(n: number): number {
  invariant(Number.isInteger(n), 'epoch days are whole');
  const date = new Date(n * MS_PER_DAY);
  const yyyymmdd = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  invariant(yyyymmdd >= 19000101, 'service dates are modern');
  return yyyymmdd;
}
