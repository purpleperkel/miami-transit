import { haversineMeters } from '../../../lib/geo';
import { orderStations } from '../order-stations';

/**
 * R7: the Stations list's order. Synthetic stations along a line due north from downtown Miami (every
 * coordinate is made up, the public-repo rule); extra fields pass through untouched.
 */

type Spot = { readonly key: string; readonly latitude: number; readonly longitude: number; readonly line: string };

/** Five stations 0.01° of latitude (about 1.1 km) apart, listed out of distance order on purpose. */
const SPOTS: readonly Spot[] = [
  { key: 'c', latitude: 25.79, longitude: -80.2, line: 'GREEN' },
  { key: 'a', latitude: 25.77, longitude: -80.2, line: 'ORANGE' },
  { key: 'e', latitude: 25.81, longitude: -80.2, line: 'GREEN' },
  { key: 'b', latitude: 25.78, longitude: -80.2, line: 'ORANGE' },
  { key: 'd', latitude: 25.8, longitude: -80.2, line: 'GREEN' },
];

describe('orderStations (R7)', () => {
  it('orders stations nearest first with walking distance', () => {
    const rider = { latitude: 25.7799, longitude: -80.2 };
    const rows = orderStations(SPOTS, rider);
    expect(rows.map((row) => row.station.key)).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(rows.map((row) => row.walkingMeters)).toEqual(rows.map((row) => haversineMeters(rider, row.station)));
    expect(rows[0]?.walkingMeters).toBeCloseTo(11.1, 0);
    expect(rows.every((row, i) => i === 0 || (row.walkingMeters as number) >= (rows[i - 1]?.walkingMeters as number))).toBe(true);
    expect(rows[0]?.station).toBe(SPOTS[3]);
  });

  it('keeps a stable fallback order without a location', () => {
    const first = orderStations(SPOTS, null);
    const second = orderStations(SPOTS, null);
    expect(first.map((row) => row.station.key)).toEqual(['c', 'a', 'e', 'b', 'd']);
    expect(second.map((row) => row.station.key)).toEqual(first.map((row) => row.station.key));
    expect(first.every((row) => row.walkingMeters === null)).toBe(true);
  });

  it('a different location gives a different order, and an empty list stays empty', () => {
    const north = orderStations(SPOTS, { latitude: 25.82, longitude: -80.2 });
    expect(north.map((row) => row.station.key)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(orderStations([], { latitude: 25.82, longitude: -80.2 })).toEqual([]);
  });

  it('equal distances keep the input order', () => {
    // A rail and a Mover station on the same spot: exactly the same distance from anywhere.
    const twins = [
      { key: 'rail', latitude: 25.78, longitude: -80.2 },
      { key: 'mover', latitude: 25.78, longitude: -80.2 },
    ];
    expect(orderStations(twins, { latitude: 25.79, longitude: -80.21 }).map((row) => row.station.key)).toEqual(['rail', 'mover']);
    expect(orderStations([...twins].reverse(), { latitude: 25.79, longitude: -80.21 }).map((row) => row.station.key)).toEqual(['mover', 'rail']);
  });
});
