import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * GTFS service time: seconds since the start of a service day (noon minus 12 h), written H:MM:SS.
 * Hours run PAST 24 — a train leaving at "25:04:00" belongs to the previous service day — so this
 * is plain arithmetic, never Date or Intl: the phone does no time-zone math (plan §4 step 10).
 *
 * The county feed writes single-digit hours unpadded and right-aligned with a space (" 5:32:00"),
 * so surrounding whitespace is tolerated; anything else malformed is an Err, never a guess.
 */

export const SECONDS_PER_DAY = 24 * 60 * 60;
/**
 * The engine resolves at most two service days (today and yesterday), so a service time must lie
 * before 48:00:00. A later time could never be shown, so it is rejected as malformed.
 */
export const MAX_SERVICE_SECONDS = 2 * SECONDS_PER_DAY - 1;

export type GtfsTimeError = { readonly kind: 'gtfs-time'; readonly input: string; readonly message: string };

const GTFS_TIME = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;

/** " 5:32:00" → 19920; "25:04:00" → 90240; malformed or ≥ 48:00:00 → Err. */
export function parseGtfsTime(text: string): Result<number, GtfsTimeError> {
  invariant(typeof text === 'string', 'parseGtfsTime reads a string');
  const match = GTFS_TIME.exec(text.trim());
  if (match === null) {
    return err(timeError(text, 'is not a GTFS time (H:MM:SS)'));
  }
  const [hours, minutes, seconds] = match.slice(1, 4).map(Number);
  invariant(hours !== undefined && minutes !== undefined && seconds !== undefined, 'the pattern has three groups');
  const total = hours * 3600 + minutes * 60 + seconds;
  if (total > MAX_SERVICE_SECONDS) {
    return err(timeError(text, 'is at or past 48:00:00, beyond the two service days the engine resolves'));
  }
  invariant(Number.isSafeInteger(total) && total >= 0, 'a parsed service time is a non-negative integer');
  return ok(total);
}

function timeError(input: string, problem: string): GtfsTimeError {
  invariant(problem.length > 0, 'a time error says what is wrong');
  const error: GtfsTimeError = { kind: 'gtfs-time', input, message: `${JSON.stringify(input)} ${problem}` };
  invariant(error.message.includes(problem), 'the message carries the problem');
  return error;
}

/**
 * A service time as a 12-hour clock label: 90240 (25:04:00) → "1:04 AM". Wraps past 24:00 with
 * plain arithmetic, truncates to the minute, and uses a plain ASCII space before AM/PM (Intl's
 * en-US output uses U+202F there, which this deliberately does not).
 */
export function formatServiceSeconds(seconds: number): string {
  invariant(Number.isSafeInteger(seconds), `a service time is whole seconds, got ${seconds}`);
  invariant(seconds >= 0 && seconds <= MAX_SERVICE_SECONDS, `a service time lies in [0, 48 h), got ${seconds}`);
  const minuteOfDay = Math.floor(seconds / 60) % (24 * 60);
  const hour24 = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const label = `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
  invariant(/^(1[0-2]|[1-9]):[0-5]\d [AP]M$/.test(label), `a clock label is h:mm AM/PM, got "${label}"`);
  return label;
}
