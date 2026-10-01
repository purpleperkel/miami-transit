import { haversineMeters, isLatLon } from '../geo';
import { InvariantError } from '../invariant';

// Government Center Metrorail platforms, from the county GTFS stops.txt (feed of 2026-07-31).
const GOV_CTR_SOUTHBOUND = { latitude: 25.776047, longitude: -80.196157 }; // stop 9512
const GOV_CTR_NORTHBOUND = { latitude: 25.776044, longitude: -80.19603 }; // stop 9513

describe('haversineMeters', () => {
  it('is zero from a point to itself', () => {
    expect(haversineMeters(GOV_CTR_NORTHBOUND, GOV_CTR_NORTHBOUND)).toBe(0);
    expect(haversineMeters(GOV_CTR_SOUTHBOUND, GOV_CTR_SOUTHBOUND)).toBe(0);
  });

  it('measures one degree of latitude as ~111.2 km', () => {
    const meters = haversineMeters({ latitude: 25, longitude: -80 }, { latitude: 26, longitude: -80 });
    expect(meters).toBeCloseTo(111_195, 0);
    expect(meters).toBeGreaterThan(111_000);
  });

  it('puts the two Government Center rail platforms ~12.7 m apart, in either direction', () => {
    const southToNorth = haversineMeters(GOV_CTR_SOUTHBOUND, GOV_CTR_NORTHBOUND);
    expect(southToNorth).toBeCloseTo(12.73, 1);
    expect(haversineMeters(GOV_CTR_NORTHBOUND, GOV_CTR_SOUTHBOUND)).toBe(southToNorth);
  });

  it('refuses an impossible coordinate instead of returning NaN', () => {
    expect(() => haversineMeters({ latitude: 91, longitude: 0 }, GOV_CTR_NORTHBOUND)).toThrow(InvariantError);
    expect(() => haversineMeters(GOV_CTR_NORTHBOUND, { latitude: 0, longitude: Number.NaN })).toThrow(InvariantError);
  });
});

describe('isLatLon', () => {
  it('accepts real coordinates and rejects out-of-range or non-finite ones', () => {
    expect(isLatLon(GOV_CTR_NORTHBOUND)).toBe(true);
    expect(isLatLon({ latitude: 0, longitude: 180.5 })).toBe(false);
    expect(isLatLon({ latitude: Number.POSITIVE_INFINITY, longitude: 0 })).toBe(false);
  });
});
