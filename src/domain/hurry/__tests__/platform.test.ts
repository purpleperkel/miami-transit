import { haversineMeters } from '../../../lib/geo';
import { nearestPlatform, type Platform } from '../platform';

/**
 * Plan M7c.3: the platform the rider walks to — the nearest one serving the trip's direction — and the
 * straight-line metres to it. Coordinates are a few hundred metres apart along one meridian, so the
 * order of the distances is plain to read.
 */

const RIDER = { latitude: 25.7743, longitude: -80.1937 };

function platform(stationKey: string, stopId: string, directionIds: readonly number[], latitude: number): Platform {
  const made: Platform = { stationKey, stopId, directionIds, latitude, longitude: -80.1937 };
  expect(made.directionIds.length).toBeGreaterThan(0);
  expect(Math.abs(made.latitude - RIDER.latitude)).toBeLessThan(0.02);
  return made;
}

const CLOSE_SOUTHBOUND = platform('rail:c', 'C0', [0], 25.7748);
const NORTHBOUND = platform('rail:a', 'A1', [1], 25.7753);
const SOUTHBOUND = platform('rail:a', 'A0', [0], 25.7754);
const MOVER_BOTH_WAYS = platform('mover:b', '813', [0, 1], 25.7763);
const FAR_NORTHBOUND = platform('rail:d', 'D1', [1], 25.7843);
const ALL = [FAR_NORTHBOUND, MOVER_BOTH_WAYS, SOUTHBOUND, NORTHBOUND, CLOSE_SOUTHBOUND];

describe('the nearest platform (M7c.3)', () => {
  it('skips a closer platform of the other direction', () => {
    expect(nearestPlatform(RIDER, ALL, 1)?.platform.stopId).toBe('A1');
    expect(nearestPlatform(RIDER, ALL, 0)?.platform.stopId).toBe('C0');
    expect(nearestPlatform(RIDER, ALL, null)?.platform.stopId).toBe('C0');
  });

  it('walkMeters is the straight-line distance to the platform', () => {
    const hit = nearestPlatform(RIDER, ALL, 1);
    expect(hit?.walkMeters).toBeCloseTo(haversineMeters(RIDER, NORTHBOUND), 6);
    // About 111 m: 0.001° of latitude, with no detour added (the verdict adds its own).
    expect(hit?.walkMeters).toBeCloseTo(111.2, 0);
  });

  it('a Mover stop serving both directions matches either', () => {
    expect(nearestPlatform(RIDER, [CLOSE_SOUTHBOUND, MOVER_BOTH_WAYS], 1)?.platform.stopId).toBe('813');
    expect(nearestPlatform(RIDER, [MOVER_BOTH_WAYS, FAR_NORTHBOUND], 0)?.platform.stopId).toBe('813');
  });

  it('is null when no platform serves the direction', () => {
    expect(nearestPlatform(RIDER, [CLOSE_SOUTHBOUND], 1)).toBeNull();
    expect(nearestPlatform(RIDER, [], null)).toBeNull();
  });
});
