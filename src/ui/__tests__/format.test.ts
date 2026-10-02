import { NOW_UNDER_MS, formatClockFromServiceSec, formatDistance, formatMinutes } from '../format';

/** M6.1 format: minutes to a departure and service-day clock times, by arithmetic alone. */

describe('formatMinutes', () => {
  it('29 s is Now', () => {
    expect(formatMinutes(29e3)).toBe('Now');
    expect(29e3).toBeLessThan(NOW_UNDER_MS);
  });

  it('a departure that is due or just leaving reads Now', () => {
    expect([formatMinutes(0), formatMinutes(-20e3), formatMinutes(NOW_UNDER_MS - 1)]).toEqual(['Now', 'Now', 'Now']);
    expect(formatMinutes(NOW_UNDER_MS)).toBe('1 min');
  });

  it('whole minutes round down, never promising more time than there is', () => {
    expect([formatMinutes(59e3), formatMinutes(119e3), formatMinutes(120e3)]).toEqual(['1 min', '1 min', '2 min']);
    expect([formatMinutes(14 * 60e3 + 59e3), formatMinutes(75 * 60e3)]).toEqual(['14 min', '75 min']);
  });

  it('a non-finite delta is a broken contract', () => {
    expect(() => formatMinutes(Number.NaN)).toThrow('finite');
    expect(() => formatMinutes(Number.POSITIVE_INFINITY)).toThrow('finite');
  });
});

describe('formatClockFromServiceSec', () => {
  it('97200 is 3:00 AM', () => {
    expect(formatClockFromServiceSec(97200)).toBe('3:00 AM');
    expect(formatClockFromServiceSec(97200)).not.toMatch(/[^\x20-\x7e]/);
  });

  it('midnight and noon read 12, mornings AM, afternoons PM', () => {
    expect([formatClockFromServiceSec(0), formatClockFromServiceSec(43200), formatClockFromServiceSec(45900)]).toEqual(['12:00 AM', '12:00 PM', '12:45 PM']);
    expect([formatClockFromServiceSec(5 * 3600 + 7 * 60), formatClockFromServiceSec(21 * 3600 + 5 * 60 + 59)]).toEqual(['5:07 AM', '9:05 PM']);
  });

  it('times past 24:00 and before the base wrap around the clock', () => {
    expect([formatClockFromServiceSec(86400), formatClockFromServiceSec(24 * 3600 + 14 * 60)]).toEqual(['12:00 AM', '12:14 AM']);
    expect(formatClockFromServiceSec(-300)).toBe('11:55 PM');
  });

  it('a non-finite service time is a broken contract', () => {
    expect(() => formatClockFromServiceSec(Number.NaN)).toThrow('finite');
    expect(() => formatClockFromServiceSec(Number.NEGATIVE_INFINITY)).toThrow('finite');
  });
});

describe('formatDistance (R7)', () => {
  it('metres to the nearest 10 under a kilometre', () => {
    expect([formatDistance(0), formatDistance(4), formatDistance(347), formatDistance(994)]).toEqual(['0 m', '0 m', '350 m', '990 m']);
    expect(formatDistance(995)).toBe('1.0 km');
  });

  it('kilometres to one decimal, whole from 10 km', () => {
    expect([formatDistance(1234), formatDistance(9949), formatDistance(10_000), formatDistance(24_600)]).toEqual(['1.2 km', '9.9 km', '10 km', '25 km']);
    expect(() => formatDistance(-1)).toThrow('non-negative');
  });
});
