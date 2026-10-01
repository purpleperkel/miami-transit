import { invariant } from '../../lib/invariant';
import type { Mode } from '../network/stations';

/**
 * Plan M3.7: how close each mode's bundled schedule is to running out. The county publishes rail
 * and Mover service with different end dates (the real feed: rail through 2026-11-22, Mover through
 * 2026-12-31), so each mode is judged on its own.
 *
 * A mode's end is the manifest's `serviceEnd.<mode>` (M2.17): its last service date, and the instant
 * that date's service day is over — start(end date) + 86400, computed on the Mac, so the phone does
 * no time-zone math. The state is decided on the exact seconds left:
 *
 *   more than 14 days left → ok · 14 days or less → warn · 3 days or less → urgent (0 included)
 *   · past the end → expired
 */

export const WARN_DAYS = 14;
export const URGENT_DAYS = 3;
const DAY_S = 86_400;

export type ExpiryState = 'ok' | 'warn' | 'urgent' | 'expired';

/** One mode's service end, as the manifest records it. */
export type ServiceEnd = {
  /** The last service date, YYYYMMDD. */
  readonly date: number;
  /** The epoch second that date's service day ends: its start + 86400. */
  readonly epoch: number;
};

export type ServiceEnds = Readonly<Record<Mode, ServiceEnd>>;

export type ModeExpiry = {
  readonly mode: Mode;
  readonly state: ExpiryState;
  readonly end: ServiceEnd;
  /** Seconds from now to the end; negative once expired. */
  readonly remainingS: number;
  /** Whole days left, a partial day counting as one (0 exactly at the end); null once expired. */
  readonly daysLeft: number | null;
};

/** The state for `remainingS` seconds left before a service end. */
export function expiryState(remainingS: number): ExpiryState {
  invariant(Number.isSafeInteger(remainingS), `seconds left is a whole number, got ${remainingS}`);
  invariant(0 < URGENT_DAYS && URGENT_DAYS < WARN_DAYS, 'urgent is the nearer threshold');
  if (remainingS < 0) {
    return 'expired';
  }
  if (remainingS <= URGENT_DAYS * DAY_S) {
    return 'urgent';
  }
  return remainingS <= WARN_DAYS * DAY_S ? 'warn' : 'ok';
}

/** One mode's expiry at `nowEpoch`. */
export function modeExpiry(mode: Mode, end: ServiceEnd, nowEpoch: number): ModeExpiry {
  invariant(Number.isSafeInteger(nowEpoch), `now is a whole epoch second, got ${nowEpoch}`);
  invariant(isServiceEnd(end), `the ${mode} service end is a YYYYMMDD date and a whole epoch second`);
  const remainingS = end.epoch - nowEpoch;
  const state = expiryState(remainingS);
  return { mode, state, end, remainingS, daysLeft: state === 'expired' ? null : Math.ceil(remainingS / DAY_S) };
}

/** Both modes' expiry at `nowEpoch`. */
export function scheduleExpiry(ends: ServiceEnds, nowEpoch: number): Readonly<Record<Mode, ModeExpiry>> {
  invariant(ends.rail !== undefined && ends.mover !== undefined, 'the manifest records a service end for rail and for Mover');
  const expiry = { rail: modeExpiry('rail', ends.rail, nowEpoch), mover: modeExpiry('mover', ends.mover, nowEpoch) };
  invariant(expiry.rail.mode === 'rail' && expiry.mover.mode === 'mover', 'each mode is judged on its own end');
  return expiry;
}

function isServiceEnd(end: ServiceEnd): boolean {
  invariant(typeof end === 'object' && end !== null, 'a service end is an object');
  invariant('date' in end && 'epoch' in end, 'a service end has a date and an epoch');
  return Number.isInteger(end.date) && end.date >= 19_700_101 && end.date <= 99_991_231 && Number.isSafeInteger(end.epoch);
}
