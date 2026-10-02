import { REAL_STOPS } from '../../network/__fixtures__/real-stops';
import {
  BACKOFF_CAP_S,
  BACKOFF_FIRST_S,
  DEPARTURES_WINDOW_S,
  FAILOVER_AFTER_FAILURES,
  HEARTBEAT_MS,
  MATCH_RADIUS_M,
  MIAMI_BOUNDS,
  providerConfig,
  quotaSkipAt,
  REPROBE_AFTER_S,
  REQUEST_ABORT_MS,
  TRUNK_LINE_OF_ROUTE,
} from '../constants';

/** M4.1: the provider config table holds the plan's §3 / §4 values exactly. */

const METRES_PER_DEGREE_LAT = (6_371_008.8 * Math.PI) / 180;

describe('live constants (M4.1): the per-provider table', () => {
  it('swiftly 30/75/150: cadence 30 s, fresh ≤ 75 s, max age 150 s, no published quota', () => {
    expect(providerConfig('swiftly')).toEqual({ id: 'swiftly', cadenceS: 30, freshS: 75, maxAgeS: 150, lagStaleS: 60, monthlyQuota: null });
    expect(quotaSkipAt('swiftly')).toBeNull();
  });

  it('transitland 60/180/300: cadence 60 s, fresh ≤ 180 s, max age 300 s, 10,000 calls a month', () => {
    expect(providerConfig('transitland')).toEqual({ id: 'transitland', cadenceS: 60, freshS: 180, maxAgeS: 300, lagStaleS: 90, monthlyQuota: 10_000 });
    expect(quotaSkipAt('transitland')).toBe(9_500);
  });
});

/**
 * The relative staleness rule's numbers (arbiter ruling for mfix3 §4, 2026-10-01): a vehicle is stale
 * past lagStaleS behind its own feed header; the feed reads Live while its header is at most freshS old;
 * a vehicle is dropped when the feed is older than maxAgeS or the vehicle lags it by more than maxAgeS.
 */
describe('live constants (mfix3 §4): the relative staleness rule', () => {
  it('transitland staleness lag 90 live 180 drop 300', () => {
    const { lagStaleS, freshS, maxAgeS } = providerConfig('transitland');
    expect([lagStaleS, freshS, maxAgeS]).toEqual([90, 180, 300]);
    expect(lagStaleS < freshS && freshS < maxAgeS).toBe(true);
  });

  it('swiftly staleness lag 60 live 75 drop 150', () => {
    const { lagStaleS, freshS, maxAgeS } = providerConfig('swiftly');
    expect([lagStaleS, freshS, maxAgeS]).toEqual([60, 75, 150]);
    expect(lagStaleS < freshS && freshS < maxAgeS).toBe(true);
  });
});

describe('live constants (M4.1): polling and merge values', () => {
  it('8 s abort on every request (in ms)', () => {
    expect(REQUEST_ABORT_MS).toBe(8_000);
    expect(HEARTBEAT_MS).toBe(1_000);
  });

  it('backoff cap 120 s, first retry 15 s; failover after 3, re-probe after 300 s', () => {
    expect([BACKOFF_FIRST_S, BACKOFF_CAP_S]).toEqual([15, 120]);
    expect([FAILOVER_AFTER_FAILURES, REPROBE_AFTER_S]).toEqual([3, 300]);
  });

  it('greedy match radius 800 m; departures look 3600 s ahead', () => {
    expect(MATCH_RADIUS_M).toBe(800);
    expect(DEPARTURES_WINDOW_S).toBe(3_600);
  });

  it('the Miami bounding box holds every real rail and Mover stop with at least 5 km to spare', () => {
    const lats = REAL_STOPS.map((stop) => stop.latitude);
    const lons = REAL_STOPS.map((stop) => stop.longitude);
    const eastMetresPerDegree = Math.cos((25.77 * Math.PI) / 180) * METRES_PER_DEGREE_LAT;
    expect(REAL_STOPS.length).toBe(89);
    expect((Math.min(...lats) - MIAMI_BOUNDS.south) * METRES_PER_DEGREE_LAT).toBeGreaterThan(5_000);
    expect((MIAMI_BOUNDS.north - Math.max(...lats)) * METRES_PER_DEGREE_LAT).toBeGreaterThan(5_000);
    expect((Math.min(...lons) - MIAMI_BOUNDS.west) * eastMetresPerDegree).toBeGreaterThan(5_000);
    expect((MIAMI_BOUNDS.east - Math.max(...lons)) * eastMetresPerDegree).toBeGreaterThan(5_000);
  });

  it('the shared-track neutral lines: RAIL_TRUNK for Metrorail, MM_TRUNK for Omni + Brickell, none for the Inner Loop', () => {
    expect([...TRUNK_LINE_OF_ROUTE.entries()]).toEqual([
      ['31009', 'RAIL_TRUNK'],
      ['14456', 'MM_TRUNK'],
    ]);
    expect(TRUNK_LINE_OF_ROUTE.has('14457')).toBe(false);
  });
});
