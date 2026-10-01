import { haversineMeters, type LatLon } from '../../../lib/geo';
import { InvariantError } from '../../../lib/invariant';
import type { ServiceDay } from '../../gtfs/service-day';
import {
  blockPlacementAt,
  MAX_LAYOVER_S,
  placeVehicle,
  pointAlongShape,
  type ScheduledTrip,
  scheduledVehicles,
  type ShapePath,
  type TripStop,
  tripProgressAt,
  vehicleBlocks,
} from '../positions';
import { buildShapeGeometry } from '../shape-geometry';

/**
 * M3.5: scheduled positions, pure. Shapes are built with the M2.11 geometry (the same cumulative
 * haversine distances the DB stores as shape_point.dist_m); every expected coordinate below is
 * computed independently of the interpolator — by walking the legs with haversine metres.
 */

const WED: ServiceDay = { date: 20260930, baseEpoch: 1_790_740_800 };
const THU: ServiceDay = { date: 20261001, baseEpoch: WED.baseEpoch + 86_400 };
const METRES_PER_DEGREE_LAT = (6_371_008.8 * Math.PI) / 180;

/** An L: ~1 km east along 25.76° N, then ~1.1 km north. Shape 0 runs it forwards, shape 1 backwards. */
const CORNER_POINTS: readonly LatLon[] = [
  { latitude: 25.76, longitude: -80.2 },
  { latitude: 25.76, longitude: -80.195 },
  { latitude: 25.76, longitude: -80.19 },
  { latitude: 25.77, longitude: -80.19 },
];

function shapePath(points: readonly LatLon[]): ShapePath {
  const built = buildShapeGeometry(points);
  expect(built.ok).toBe(true);
  const geometry = built.ok ? built.value : null;
  expect(geometry).not.toBeNull();
  return { points: geometry?.points ?? [], distM: geometry?.cumulativeM ?? [] };
}

const FORWARD = shapePath(CORNER_POINTS);
const BACKWARD = shapePath([...CORNER_POINTS].reverse());
const SHAPES: ReadonlyMap<number, ShapePath> = new Map([
  [0, FORWARD],
  [1, BACKWARD],
]);
const LENGTH_M = FORWARD.distM[FORWARD.distM.length - 1] ?? 0;

/** A trip on shape `shapeIdx` over [startS, endS], stopping at each [arrS, depS, distM]. */
function trip(tripIdx: number, blockId: string, shapeIdx: number, stops: readonly (readonly [number, number, number])[]): ScheduledTrip {
  expect(stops.length).toBeGreaterThanOrEqual(2);
  const made: ScheduledTrip = {
    tripIdx,
    tripId: `t${tripIdx}`,
    blockId,
    lineId: 'MM_INNER',
    mode: 'mover',
    directionId: shapeIdx,
    shapeIdx,
    stops: stops.map(([arrS, depS, distM]): TripStop => ({ arrS, depS, distM })),
  };
  expect(made.stops.every((stop, i) => i === 0 || stop.arrS >= (made.stops[i - 1]?.depS ?? 0))).toBe(true);
  return made;
}

/** End to end at Wednesday service-day second `s`: the vehicles the timetable places. */
function vehiclesAtWed(s: number, trips: readonly ScheduledTrip[]) {
  expect(Number.isInteger(s)).toBe(true);
  const vehicles = scheduledVehicles(WED.baseEpoch + s, [{ day: WED, trips }], SHAPES);
  expect(new Set(vehicles.map((v) => v.vehicleKey)).size).toBe(vehicles.length);
  return vehicles;
}

/** Independent: the point `metres` along the L, walking its legs (east leg, then north leg). */
function alongCorner(metres: number): LatLon {
  const eastLegM = haversineMeters(CORNER_POINTS[0]!, CORNER_POINTS[2]!);
  expect(metres).toBeGreaterThan(eastLegM);
  const north = CORNER_POINTS[2]!;
  const point = { latitude: north.latitude + (metres - eastLegM) / METRES_PER_DEGREE_LAT, longitude: north.longitude };
  expect(haversineMeters(north, point)).toBeCloseTo(metres - eastLegM, 3);
  return point;
}

describe('scheduled positions (M3.5, pure): interpolation along the shape', () => {
  it('midpoint: halfway through a trip in time puts the vehicle at the shape midpoint (±1 m)', () => {
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    expect(tripProgressAt(run, 30_300)).toEqual({ distM: LENGTH_M / 2, state: 'moving' });
    const [vehicle, ...others] = vehiclesAtWed(30_300, [run]);
    expect(others).toHaveLength(0);
    expect(vehicle?.state).toBe('moving');
    expect(haversineMeters(vehicle!.position, alongCorner(LENGTH_M / 2))).toBeLessThanOrEqual(1);
  });

  it('midpoint of each leg: time is interpolated between consecutive stops, not across the whole trip', () => {
    const quarterM = LENGTH_M * 0.25;
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_100, 30_100, quarterM],
      [30_900, 30_900, LENGTH_M],
    ]);
    expect(tripProgressAt(run, 30_050)?.distM).toBeCloseTo(quarterM / 2, 9);
    expect(tripProgressAt(run, 30_500)?.distM).toBeCloseTo((quarterM + LENGTH_M) / 2, 9);
    const point = pointAlongShape(FORWARD, (quarterM + LENGTH_M) / 2);
    expect(haversineMeters(point, alongCorner((quarterM + LENGTH_M) / 2))).toBeLessThanOrEqual(1);
  });

  it('before start: a block whose first trip has not started shows no vehicle', () => {
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    expect(tripProgressAt(run, 29_999)).toBeNull();
    expect(vehiclesAtWed(29_999, [run])).toEqual([]);
    expect(vehiclesAtWed(30_000 - MAX_LAYOVER_S, [run])).toEqual([]);
    expect(vehiclesAtWed(30_000, [run]).map((v) => v.state)).toEqual(['at-stop']);
  });

  it('after the last trip of a block, the vehicle is gone', () => {
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    expect(tripProgressAt(run, 30_601)).toBeNull();
    expect(vehiclesAtWed(30_601, [run])).toEqual([]);
  });
});

describe('scheduled positions (M3.5, pure): a block is one vehicle — layovers and joins', () => {
  it('layover: a block gap of 600 s parks the vehicle at the next trip’s first stop, keyed date:block_id', () => {
    const out = trip(1, 'B7', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    const back = trip(2, 'B7', 1, [
      [30_600 + MAX_LAYOVER_S, 30_600 + MAX_LAYOVER_S, 0],
      [31_800, 31_800, LENGTH_M],
    ]);
    const parked = vehiclesAtWed(30_900, [back, out]);
    expect(parked.map((v) => [v.vehicleKey, v.state, v.tripId])).toEqual([['20260930:B7', 'layover', 't2']]);
    expect(haversineMeters(parked[0]!.position, CORNER_POINTS[3]!)).toBeLessThanOrEqual(1);
    const moving = vehiclesAtWed(31_500, [back, out]);
    expect(moving.map((v) => [v.vehicleKey, v.state, v.tripId])).toEqual([['20260930:B7', 'moving', 't2']]);
  });

  it('layover: a block gap of 601 s is not a layover — no vehicle between the trips', () => {
    const out = trip(1, 'B7', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    const back = trip(2, 'B7', 1, [
      [30_600 + MAX_LAYOVER_S + 1, 30_600 + MAX_LAYOVER_S + 1, 0],
      [31_800, 31_800, LENGTH_M],
    ]);
    expect(blockPlacementAt([out, back], 30_900)).toBeNull();
    expect(vehiclesAtWed(30_900, [out, back])).toEqual([]);
  });

  it('a join (one half-trip ends as the next starts, like the Inner Loop) is one vehicle, one key, on the later trip', () => {
    const out = trip(1, 'B9', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    const back = trip(2, 'B9', 1, [
      [30_600, 30_600, 0],
      [31_200, 31_200, LENGTH_M],
    ]);
    const keys = [30_300, 30_600, 30_900].map((s) => vehiclesAtWed(s, [out, back]).map((v) => `${v.vehicleKey}/${v.tripId}`));
    expect(keys).toEqual([['20260930:B9/t1'], ['20260930:B9/t2'], ['20260930:B9/t2']]);
    expect(new Set(keys.flat().map((k) => k.split('/')[0])).size).toBe(1);
  });
});

describe('scheduled positions (M3.5, pure): stops, service days and keys', () => {
  it('at-stop: between a stop’s arrival and departure the vehicle stands at that stop', () => {
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_200, 30_260, 500],
      [30_600, 30_600, LENGTH_M],
    ]);
    expect(tripProgressAt(run, 30_230)).toEqual({ distM: 500, state: 'at-stop' });
    expect(tripProgressAt(run, 30_260)).toEqual({ distM: 500, state: 'at-stop' });
    expect(tripProgressAt(run, 30_261)?.state).toBe('moving');
  });

  it('24:xx: a Wednesday block still running after midnight is keyed by Wednesday, beside Thursday’s first vehicle', () => {
    const late = trip(1, 'B1', 0, [
      [86_400 + 600, 86_400 + 600, 0],
      [86_400 + 1200, 86_400 + 1200, LENGTH_M],
    ]);
    const early = trip(2, 'B1', 1, [
      [600, 600, 0],
      [1200, 1200, LENGTH_M],
    ]);
    const vehicles = scheduledVehicles(THU.baseEpoch + 900, [
      { day: WED, trips: [late] },
      { day: THU, trips: [early] },
    ], SHAPES);
    expect(vehicles.map((v) => [v.vehicleKey, v.serviceDate, v.tripId])).toEqual([
      ['20260930:B1', 20260930, 't1'],
      ['20261001:B1', 20261001, 't2'],
    ]);
    expect(vehicles.map((v) => v.state)).toEqual(['moving', 'moving']);
  });

  it('a trip with no block is a vehicle of its own, never merged with another block-less trip', () => {
    const a = trip(1, '', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    const b = trip(2, '', 1, [
      [30_100, 30_100, 0],
      [30_700, 30_700, LENGTH_M],
    ]);
    const vehicles = vehiclesAtWed(30_300, [a, b]);
    expect(vehicles.map((v) => v.vehicleKey)).toEqual(['20260930:trip:t1', '20260930:trip:t2']);
    expect(vehicles.map((v) => v.tripId)).toEqual(['t1', 't2']);
  });
});

describe('scheduled positions (M3.5, pure): contracts', () => {
  it('the binary search lands on every vertex, and a distance off the shape is a broken contract', () => {
    FORWARD.distM.forEach((d, i) => {
      expect(haversineMeters(pointAlongShape(FORWARD, d), FORWARD.points[i]!)).toBeLessThan(1e-6);
    });
    expect(() => pointAlongShape(FORWARD, LENGTH_M + 1)).toThrow(InvariantError);
    expect(() => pointAlongShape(FORWARD, -1)).toThrow(InvariantError);
  });

  it('a trip on a shape the caller did not supply is a broken contract, not a vehicle at 0,0', () => {
    const lost = trip(1, 'B1', 5, [
      [30_000, 30_000, 0],
      [30_600, 30_600, 100],
    ]);
    expect(() => vehiclesAtWed(30_300, [lost])).toThrow(InvariantError);
    expect(() => vehiclesAtWed(30_300, [lost])).toThrow(/shape 5/);
  });
});

describe('scheduled positions (M5.10): vehicle blocks placed between whole seconds', () => {
  it('a block placed at a fraction of a second sits between its whole-second places, on the same key', () => {
    const run = trip(1, 'B1', 0, [
      [30_000, 30_000, 0],
      [30_600, 30_600, LENGTH_M],
    ]);
    const [block, ...others] = vehicleBlocks([{ day: WED, trips: [run] }]);
    expect(others).toHaveLength(0);
    expect(block).toMatchObject({ vehicleKey: '20260930:B1', serviceDate: WED.date, baseEpoch: WED.baseEpoch, mode: 'mover' });
    const [whole, quarter, half, next] = [30_300, 30_300.25, 30_300.5, 30_301].map((s) => placeVehicle(block!, WED.baseEpoch + s, SHAPES)?.distM ?? NaN);
    expect(quarter).toBeGreaterThan(whole!);
    expect(quarter).toBeLessThan(next!);
    expect(half).toBeCloseTo((whole! + next!) / 2, 9);
    expect(placeVehicle(block!, WED.baseEpoch + 30_300, SHAPES)).toEqual(vehiclesAtWed(30_300, [run])[0]);
    expect(placeVehicle(block!, WED.baseEpoch + 29_000.5, SHAPES)).toBeNull();
  });
});
