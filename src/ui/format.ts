import { invariant } from '../lib/invariant';
import { copy } from './copy';

/**
 * Times as riders read them (plan M6.1). Pure arithmetic: the phone does no time-zone math (plan §4
 * step 10). A clock time comes from SERVICE seconds — GTFS times count from the service day's
 * "noon minus 12 h", which is local midnight on every day but the two daylight-saving switches — so
 * "3:00 AM" is computed from the number itself and never from a device clock or locale API.
 */

/** Under half a minute to go, a departure reads "Now". */
export const NOW_UNDER_MS = 30_000;
const MINUTE_MS = 60_000;
const DAY_S = 86_400;
const HOUR_S = 3_600;

/**
 * How long until a departure, from the milliseconds left: "Now" under 30 s (also once it is due),
 * else whole minutes rounded DOWN, at least 1 — the board never promises a rider more time than there is.
 */
export function formatMinutes(deltaMs: number): string {
  invariant(Number.isFinite(deltaMs), `a time to departure is a finite number of ms, got ${deltaMs}`);
  if (deltaMs < NOW_UNDER_MS) {
    return copy.now;
  }
  const minutes = Math.max(1, Math.floor(deltaMs / MINUTE_MS));
  invariant(minutes * MINUTE_MS <= Math.max(deltaMs, MINUTE_MS), 'the minutes shown never exceed the time left');
  return copy.minutes(minutes);
}

/**
 * A service-day second as a 12-hour clock: 97200 (27:00, the small hours after the service day's
 * midnight) → "3:00 AM"; 0 → "12:00 AM"; 45900 → "12:45 PM". The hour wraps every 24 h, so a time past
 * 24:00 — or before a base, for a row placed against a neighbouring day — still reads correctly.
 */
export function formatClockFromServiceSec(serviceSec: number): string {
  invariant(Number.isFinite(serviceSec), `a service time is a finite number of seconds, got ${serviceSec}`);
  const secondOfDay = ((Math.floor(serviceSec) % DAY_S) + DAY_S) % DAY_S;
  const hour24 = Math.floor(secondOfDay / HOUR_S);
  const minute = Math.floor((secondOfDay % HOUR_S) / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  invariant(hour24 >= 0 && hour24 < 24 && minute >= 0 && minute < 60, `${serviceSec} s lands on a clock time`);
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}
