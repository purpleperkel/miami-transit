import manifest from '../../../../assets/db/manifest.json';
import { InvariantError } from '../../../lib/invariant';
import { expiryState, modeExpiry, scheduleExpiry, type ServiceEnds } from '../expiry';

/**
 * M3.7: schedule expiry per mode, on the REAL bundled manifest's service ends. The end epochs are
 * re-derived here by hand: the last service date's New York midnight (both dates fall after the
 * 2026-11-01 DST change, so −05:00 EST = 05:00 UTC) plus 86400.
 */

const DAY = 86_400;
const ENDS: ServiceEnds = manifest.serviceEnd;
/** New York midnight of a date in Nov/Dec 2026 (EST, after the Nov 1 DST change), as an epoch second. */
function estMidnight(month: number, day: number): number {
  const epoch = Date.UTC(2026, month - 1, day, 5) / 1000;
  const wall = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  expect(wall.format(new Date(epoch * 1000))).toBe('00:00');
  expect(Number.isSafeInteger(epoch)).toBe(true);
  return epoch;
}

describe('schedule expiry (M3.7): the boundaries', () => {
  it('rail ends 20261122 and Mover ends 20261231, each at start(end date) + 86400', () => {
    expect(ENDS.rail).toEqual({ date: 20261122, epoch: estMidnight(11, 22) + DAY });
    expect(ENDS.mover).toEqual({ date: 20261231, epoch: estMidnight(12, 31) + DAY });
    expect(ENDS.rail.epoch).toBe(1_795_410_000);
  });

  it('rail: more than 14 days left (14 days + 1 s) → ok', () => {
    const rail = modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 14 * DAY - 1);
    expect(rail.state).toBe('ok');
    expect(rail.daysLeft).toBe(15);
  });

  it('rail: exactly 14 days left → warn', () => {
    const rail = modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 14 * DAY);
    expect(rail).toEqual({ mode: 'rail', state: 'warn', end: ENDS.rail, remainingS: 14 * DAY, daysLeft: 14 });
    expect(modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 3 * DAY - 1).state).toBe('warn');
  });

  it('rail: exactly 3 days left → urgent', () => {
    const rail = modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 3 * DAY);
    expect(rail.state).toBe('urgent');
    expect(rail.daysLeft).toBe(3);
  });

  it('mover: 0 s left (the end instant itself) → urgent, 0 days left', () => {
    const mover = modeExpiry('mover', ENDS.mover, ENDS.mover.epoch);
    expect(mover.state).toBe('urgent');
    expect(mover.daysLeft).toBe(0);
  });

  it('mover: 1 s past the end → expired, with no days left to show', () => {
    const mover = modeExpiry('mover', ENDS.mover, ENDS.mover.epoch + 1);
    expect(mover).toEqual({ mode: 'mover', state: 'expired', end: ENDS.mover, remainingS: -1, daysLeft: null });
    expect(modeExpiry('mover', ENDS.mover, ENDS.mover.epoch + 400 * DAY).state).toBe('expired');
  });

});

describe('schedule expiry (M3.7): per mode', () => {
  it('mover: the same boundaries hold — 14 days + 1 s ok, 14 days warn, 3 days urgent', () => {
    const states = [14 * DAY + 1, 14 * DAY, 3 * DAY + 1, 3 * DAY, 1].map((left) => modeExpiry('mover', ENDS.mover, ENDS.mover.epoch - left).state);
    expect(states).toEqual(['ok', 'warn', 'warn', 'urgent', 'urgent']);
    expect(states).toHaveLength(5);
  });

  it('rail and mover are judged on their own ends: Fri 2026-11-20 noon → rail urgent, Mover ok; Nov 23 → rail expired', () => {
    const friday = scheduleExpiry(ENDS, estMidnight(11, 20) + 12 * 3600);
    expect([friday.rail.state, friday.mover.state]).toEqual(['urgent', 'ok']);
    const monday = scheduleExpiry(ENDS, estMidnight(11, 23) + 1);
    expect([monday.rail.state, monday.mover.state]).toEqual(['expired', 'ok']);
    expect(monday.mover.daysLeft).toBe(39);
  });

  it('daysLeft counts a partial day as one; the thresholds use exact seconds', () => {
    expect(modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 3 * DAY - 3600)).toMatchObject({ state: 'warn', daysLeft: 4 });
    expect(modeExpiry('rail', ENDS.rail, ENDS.rail.epoch - 1)).toMatchObject({ state: 'urgent', daysLeft: 1 });
    expect(expiryState(-1)).toBe('expired');
  });

  it('a malformed end or a fractional instant is a broken contract (ok is never guessed)', () => {
    expect(() => modeExpiry('rail', { date: 20261122.5, epoch: ENDS.rail.epoch }, ENDS.rail.epoch)).toThrow(InvariantError);
    expect(() => modeExpiry('rail', ENDS.rail, 1.5)).toThrow(InvariantError);
  });
});
