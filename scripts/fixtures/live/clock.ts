import { invariant } from '../../../src/lib/invariant';

/**
 * Time formatting for the synthetic live fixtures in integer arithmetic only — no Date, no time
 * zone database, no locale — so the generator's output can never depend on the machine's clock or
 * zone. The New York offset of an instant comes from schedule.db (service_day.noon_utc_offset_s).
 */

const DAY_S = 86_400;

/** Days since 1970-01-01 → [year, month, day] (H. Hinnant's civil_from_days). */
export function civilFromDays(days: number): readonly [year: number, month: number, day: number] {
  invariant(Number.isSafeInteger(days), 'a day count is a whole number');
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  invariant(month >= 1 && month <= 12 && day >= 1 && day <= 31, `day ${days} is a calendar date`);
  return [year, month, day];
}

/** A whole number below 100 as two digits ("07"); a larger one keeps all its digits. */
function two(n: number): string {
  invariant(Number.isSafeInteger(n) && n >= 0, `a clock field is a whole number >= 0, got ${n}`);
  const text = String(n).padStart(2, '0');
  invariant(text.length >= 2, 'at least two digits');
  return text;
}

/** Wall-clock seconds as "HH:MM:SS"; a service-day time past midnight keeps counting ("24:10:00"), as GTFS does. */
export function clockOf(seconds: number): string {
  invariant(Number.isSafeInteger(seconds) && seconds >= 0, `a clock time is a whole number of seconds >= 0, got ${seconds}`);
  const text = `${two(Math.floor(seconds / 3_600))}:${two(Math.floor((seconds % 3_600) / 60))}:${two(seconds % 60)}`;
  invariant(/^\d{2,}:\d{2}:\d{2}$/.test(text), 'HH:MM:SS');
  return text;
}

/** An instant as ISO-8601 at `offsetS` from UTC: "2026-09-30T08:15:00-04:00" (offset 0 → "…Z"). */
export function isoAt(epoch: number, offsetS: number): string {
  invariant(Number.isSafeInteger(epoch) && epoch > 0, `an instant is a positive whole epoch second, got ${epoch}`);
  invariant(Number.isSafeInteger(offsetS) && offsetS % 60 === 0 && Math.abs(offsetS) < DAY_S, 'an offset is whole minutes, under a day');
  const local = epoch + offsetS;
  const [year, month, day] = civilFromDays(Math.floor(local / DAY_S));
  const zone = offsetS === 0 ? 'Z' : `${offsetS < 0 ? '-' : '+'}${two(Math.floor(Math.abs(offsetS) / 3_600))}:${two((Math.abs(offsetS) % 3_600) / 60)}`;
  return `${year}-${two(month)}-${two(day)}T${clockOf(((local % DAY_S) + DAY_S) % DAY_S)}${zone}`;
}

/** A YYYYMMDD service date as "YYYY-MM-DD". */
export function dashedDate(date: number): string {
  invariant(Number.isSafeInteger(date) && date >= 19_700_101 && date <= 99_991_231, `a service date is YYYYMMDD, got ${date}`);
  const text = `${Math.floor(date / 10_000)}-${two(Math.floor(date / 100) % 100)}-${two(date % 100)}`;
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(text), 'YYYY-MM-DD');
  return text;
}
