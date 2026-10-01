import { InvariantError } from '../../../lib/invariant';
import { isOk, type Result } from '../../../lib/result';
import { formatServiceSeconds, MAX_SERVICE_SECONDS, parseGtfsTime, type GtfsTimeError } from '../time';

/** The parsed seconds of an Ok result; fails the test on an Err. */
function secondsOf(result: Result<number, GtfsTimeError>): number {
  expect(result.ok).toBe(true);
  if (!isOk(result)) {
    throw new Error(`expected Ok, got ${result.error.message}`);
  }
  expect(Number.isInteger(result.value)).toBe(true);
  return result.value;
}

describe('parseGtfsTime', () => {
  it('" 5:32:00" → 19920 (the feed\'s leading space and unpadded hour)', () => {
    expect(secondsOf(parseGtfsTime(' 5:32:00'))).toBe(19920);
    expect(secondsOf(parseGtfsTime('05:32:00'))).toBe(19920);
  });

  it('"25:04:00" → 90240 (a time past 24:00 stays on its service day)', () => {
    expect(secondsOf(parseGtfsTime('25:04:00'))).toBe(90240);
    expect(secondsOf(parseGtfsTime('24:00:30'))).toBe(86430);
  });

  it('reads the day boundaries: 0:00:00 → 0 and 47:59:59 → the last representable second', () => {
    expect(secondsOf(parseGtfsTime('0:00:00'))).toBe(0);
    expect(secondsOf(parseGtfsTime('47:59:59'))).toBe(MAX_SERVICE_SECONDS);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['no seconds', '5:32'],
    ['one-digit seconds', '5:32:0'],
    ['minutes past 59', '5:60:00'],
    ['seconds past 59', '5:32:60'],
    ['three-digit hours', '100:00:00'],
    ['at 48:00:00', '48:00:00'],
    ['negative', '-1:00:00'],
    ['trailing junk', '5:32:00 x'],
    ['words', 'noon'],
  ])('bad input → Err (%s: %p)', (_label, input) => {
    const result = parseGtfsTime(input);
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.error.kind).toBe('gtfs-time');
      expect(result.error.message).toContain(JSON.stringify(input));
    }
  });
});

describe('formatServiceSeconds', () => {
  it('formatServiceSeconds(90240) = "1:04 AM" (wraps past 24:00)', () => {
    expect(formatServiceSeconds(90240)).toBe('1:04 AM');
    expect(formatServiceSeconds(90240)).not.toContain('\u202f');
  });

  it('labels midnight, noon and the last minute of the day', () => {
    expect(formatServiceSeconds(0)).toBe('12:00 AM');
    expect(formatServiceSeconds(12 * 3600)).toBe('12:00 PM');
    expect(formatServiceSeconds(19920)).toBe('5:32 AM');
    expect(formatServiceSeconds(86399)).toBe('11:59 PM');
  });

  it('truncates to the minute (25:04:59 is still 1:04 AM)', () => {
    expect(formatServiceSeconds(90299)).toBe('1:04 AM');
    expect(formatServiceSeconds(90300)).toBe('1:05 AM');
  });

  it('round-trips the feed text through parse and format', () => {
    expect(formatServiceSeconds(secondsOf(parseGtfsTime(' 5:32:00')))).toBe('5:32 AM');
    expect(formatServiceSeconds(secondsOf(parseGtfsTime('25:04:00')))).toBe('1:04 AM');
  });

  it('refuses a negative, fractional or out-of-range time (a broken contract, not a label)', () => {
    expect(() => formatServiceSeconds(-1)).toThrow(InvariantError);
    expect(() => formatServiceSeconds(1.5)).toThrow(InvariantError);
    expect(() => formatServiceSeconds(MAX_SERVICE_SECONDS + 1)).toThrow(InvariantError);
  });
});
