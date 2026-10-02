import type { UserPosition } from '../../map/use-user-location';
import { type PlanOrigin, watchIsFresher } from '../use-route-plan';

/**
 * mfix8 cleanup: the route chips walk from the rider's FRESHEST fix. These pin the rule's edges directly: a station
 * start never beats a fix of the rider; against the plan's own timed fix the watch wins only when STRICTLY later; and
 * a watch fix that came without a time never counts as the newer one.
 */
const PLAN_AT_MS = 1_790_000_000_000;
const HERE = { latitude: 25.7743, longitude: -80.1937 };
const NEARBY = { latitude: 25.7735, longitude: -80.1937 };
const STATION_START: PlanOrigin = { name: 'Government Center', coordinate: HERE, takenAtMs: null };
const TIMED_START: PlanOrigin = { name: 'Your location', coordinate: HERE, takenAtMs: PLAN_AT_MS };
const EPOCH_START: PlanOrigin = { name: 'Your location', coordinate: HERE, takenAtMs: 0 };
const LATER: UserPosition = { coordinate: NEARBY, takenAtMs: PLAN_AT_MS + 1, note: null };
const SAME_INSTANT: UserPosition = { coordinate: NEARBY, takenAtMs: PLAN_AT_MS, note: null };
const EARLIER: UserPosition = { coordinate: NEARBY, takenAtMs: PLAN_AT_MS - 30_000, note: null };
const UNTIMED: UserPosition = { coordinate: NEARBY, takenAtMs: null, note: null };

describe('the route chip walks from the freshest fix (mfix8 cleanup)', () => {
  it('a station start never beats a fix of the rider, timed or not', () => {
    expect(watchIsFresher(EARLIER, STATION_START)).toBe(true);
    expect(watchIsFresher(UNTIMED, STATION_START)).toBe(true);
  });

  it('against the plan fix the watch wins only when strictly later', () => {
    expect(watchIsFresher(LATER, TIMED_START)).toBe(true);
    expect(watchIsFresher(SAME_INSTANT, TIMED_START)).toBe(false);
    expect(watchIsFresher(EARLIER, TIMED_START)).toBe(false);
  });

  it('a watch fix without a time never counts as newer than the plan fix', () => {
    expect(watchIsFresher(UNTIMED, TIMED_START)).toBe(false);
    expect(watchIsFresher(UNTIMED, EPOCH_START)).toBe(false);
  });
});
