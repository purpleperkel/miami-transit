import { InvariantError } from '../../../lib/invariant';
import {
  instantWindow,
  resolveServiceDays,
  runsDuring,
  type ServiceCalendarBounds,
  type ServiceDay,
  windowFrom,
} from '../service-day';

/** Three consecutive service days with the real feed's span (the latest trip ends at 25:04). */
const DAY = 86_400;
const SPAN_S = 90_240;
const WED: ServiceDay = { date: 20260930, baseEpoch: 1_790_740_800 };
const THU: ServiceDay = { date: 20261001, baseEpoch: WED.baseEpoch + DAY };
const FRI: ServiceDay = { date: 20261002, baseEpoch: THU.baseEpoch + DAY };
const CALENDAR: readonly ServiceDay[] = [WED, THU, FRI];
const BOUNDS: ServiceCalendarBounds = { first: WED, last: FRI, spanS: SPAN_S };

describe('service-day resolution (M3.2, pure)', () => {
  it('a day runs from its base epoch (inclusive) until base + span (exclusive)', () => {
    expect(runsDuring(THU, instantWindow(THU.baseEpoch), SPAN_S)).toBe(true);
    expect(runsDuring(THU, instantWindow(THU.baseEpoch - 1), SPAN_S)).toBe(false);
    expect(runsDuring(WED, instantWindow(WED.baseEpoch + SPAN_S - 1), SPAN_S)).toBe(true);
    expect(runsDuring(WED, instantWindow(WED.baseEpoch + SPAN_S), SPAN_S)).toBe(false);
  });

  it('midday is one service day; just after midnight is two (yesterday’s 24:xx trains still run)', () => {
    expect(resolveServiceDays(instantWindow(THU.baseEpoch + 12 * 3600), CALENDAR, BOUNDS)).toEqual({ kind: 'active', days: [THU] });
    expect(resolveServiceDays(instantWindow(THU.baseEpoch + 1800), CALENDAR, BOUNDS)).toEqual({ kind: 'active', days: [WED, THU] });
  });

  it('a window touches every day running at any point inside it', () => {
    const window = windowFrom(WED.baseEpoch + 20 * 3600, 30 * 3600);
    expect(resolveServiceDays(window, CALENDAR, BOUNDS)).toEqual({ kind: 'active', days: [WED, THU, FRI] });
    expect(window.toEpoch - window.fromEpoch).toBe(30 * 3600);
  });

  it('past the last day’s span -> expired; before the first base -> not-started', () => {
    expect(resolveServiceDays(instantWindow(FRI.baseEpoch + SPAN_S), CALENDAR, BOUNDS)).toEqual({ kind: 'expired', lastDate: FRI.date });
    expect(resolveServiceDays(instantWindow(WED.baseEpoch - 1), CALENDAR, BOUNDS)).toEqual({ kind: 'not-started', firstDate: WED.date });
    expect(resolveServiceDays(instantWindow(FRI.baseEpoch + SPAN_S - 1), CALENDAR, BOUNDS)).toEqual({ kind: 'active', days: [FRI] });
  });

  it('a hole inside the calendar is a broken contract, not a quiet "no service"', () => {
    expect(() => resolveServiceDays(instantWindow(THU.baseEpoch + 12 * 3600), [WED, FRI], BOUNDS)).toThrow(InvariantError);
    expect(() => resolveServiceDays(instantWindow(THU.baseEpoch), [THU, WED], BOUNDS)).toThrow(/date order/);
  });

  it('windows are whole, ordered epoch seconds', () => {
    expect(() => windowFrom(WED.baseEpoch, -1)).toThrow(InvariantError);
    expect(() => instantWindow(1.5)).toThrow(InvariantError);
    expect(windowFrom(WED.baseEpoch, 0)).toEqual(instantWindow(WED.baseEpoch));
  });
});
