import type { LatLon } from '../../../lib/geo';
import { isOk, type Result } from '../../../lib/result';
import { buildShapeGeometry, MAX_STOP_OFFSET_M, projectStops, type ShapeError, type ShapeGeometry } from '../shape-geometry';

/** The IUGG mean radius geo.ts uses: on a sphere, a meridian arc is exactly R × Δφ. */
const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;
const ORIGIN: LatLon = { latitude: 25.77, longitude: -80.19 };

/** A point `east`/`north` metres from downtown Miami (local flat-earth offsets, exact enough under 2 km). */
function at(east: number, north: number): LatLon {
  expect(Number.isFinite(east) && Number.isFinite(north)).toBe(true);
  const point = {
    latitude: ORIGIN.latitude + north / METRES_PER_DEGREE,
    longitude: ORIGIN.longitude + east / (METRES_PER_DEGREE * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
  };
  expect(Math.abs(point.latitude - ORIGIN.latitude)).toBeLessThan(1);
  return point;
}

function okValue<T>(result: Result<T, ShapeError>): T {
  expect(result.ok).toBe(true);
  if (!isOk(result)) {
    throw new Error(`expected Ok, got Err: ${result.error.message}`);
  }
  expect(result.value).toBeDefined();
  return result.value;
}

function errValue<T>(result: Result<T, ShapeError>): ShapeError {
  expect(result.ok).toBe(false);
  if (isOk(result)) {
    throw new Error('expected Err, got Ok');
  }
  expect(result.error.kind).toBe('shape');
  return result.error;
}

function shape(points: readonly LatLon[]): ShapeGeometry {
  const geometry = okValue(buildShapeGeometry(points));
  expect(geometry.cumulativeM).toHaveLength(points.length);
  expect(geometry.cumulativeM[0]).toBe(0);
  return geometry;
}

/** A closed 400 m square loop: east, north, west, south, back to the start. */
const SQUARE_LOOP = [at(0, 0), at(400, 0), at(400, 400), at(0, 400), at(0, 0)];

describe('cumulative distance', () => {
  it('cumulative distance ±1 m along a meridian (oracle: R × Δφ)', () => {
    const points = Array.from({ length: 11 }, (_, i) => ({ latitude: 25.7 + i * 0.01, longitude: -80.19 }));
    const geometry = shape(points);
    const step = EARTH_RADIUS_M * 0.01 * (Math.PI / 180);
    expect(Math.max(...geometry.cumulativeM.map((metres, i) => Math.abs(metres - i * step)))).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.lengthM - 10 * step)).toBeLessThanOrEqual(1);
  });

  it('cumulative distance ±1 m around a 400 m square loop (4 × 400 m)', () => {
    const geometry = shape(SQUARE_LOOP);
    const expected = [0, 400, 800, 1200, 1600];
    expect(Math.max(...geometry.cumulativeM.map((metres, i) => Math.abs(metres - (expected[i] ?? NaN))))).toBeLessThanOrEqual(1);
    expect(geometry.lengthM).toBe(geometry.cumulativeM[4]);
  });

  it('a shape needs two valid points', () => {
    expect(errValue(buildShapeGeometry([ORIGIN])).reason).toBe('too-few-points');
    expect(errValue(buildShapeGeometry([ORIGIN, { latitude: 95, longitude: 0 }])).reason).toBe('bad-point');
  });
});

describe('stop projection', () => {
  it('projection is monotone on a loop: the last stop lands at the end, not back at 0', () => {
    const geometry = shape(SQUARE_LOOP);
    const stops = [at(0, 0), at(400, 0), at(400, 400), at(0, 400), at(0, 0)];
    const distances = okValue(projectStops(geometry, stops));
    expect(Math.max(...distances.map((d, i) => Math.abs(d - (geometry.cumulativeM[i] ?? NaN))))).toBeLessThanOrEqual(1);
    expect(distances[4]).toBeCloseTo(geometry.lengthM, 6);
  });

  it('projection is monotone on a loop even when a nearer point lies behind: platforms 5 m off the track', () => {
    const geometry = shape(SQUARE_LOOP);
    // Stop 2 sits beside the north side; stop 3 beside the start, which the loop passes twice:
    // 5 m along the first side, and 5 m before the end on the closing side (1600 - 5).
    const distances = okValue(projectStops(geometry, [at(5, 5), at(200, 405), at(5, 5)]));
    expect(distances.map((d) => Math.round(d))).toEqual([5, 1000, 1595]);
    expect(distances.every((d, i) => i === 0 || d >= (distances[i - 1] ?? Infinity))).toBe(true);
  });

  it('an out-and-back shape takes the second pass for a stop that comes later', () => {
    const geometry = shape([at(0, 0), at(0, 600), at(0, 0)]);
    expect(okValue(projectStops(geometry, [at(3, 0), at(3, 600), at(3, 300), at(3, 0)])).map((d) => Math.round(d))).toEqual([0, 600, 900, 1200]);
    // On a one-way shape the same order cannot be placed: the third stop would have to go backwards.
    const oneWay = shape([at(0, 0), at(0, 600)]);
    expect(errValue(projectStops(oneWay, [at(3, 0), at(3, 600), at(3, 300)]))).toMatchObject({ reason: 'order', index: 2 });
  });

  it('a stop whose only in-order placement is > 100 m off the track -> Err, never a silent far projection', () => {
    // An L-shaped track: north 600 m, then east 600 m. Stop 1 is beside the first leg but BEHIND
    // stop 0; the nearest in-order point (the corner) is 300 m away.
    const geometry = shape([at(0, 0), at(0, 600), at(600, 600)]);
    expect(errValue(projectStops(geometry, [at(3, 590), at(3, 300)]))).toMatchObject({ reason: 'order', index: 1 });
    expect(okValue(projectStops(geometry, [at(3, 300), at(3, 590)])).map((d) => Math.round(d))).toEqual([300, 590]);
  });

  it(`offset > 100 m -> Err naming the stop; ${MAX_STOP_OFFSET_M - 1} m is still a projection`, () => {
    const geometry = shape([at(0, 0), at(1000, 0)]);
    const error = errValue(projectStops(geometry, [at(0, 0), at(500, 150), at(1000, 0)]));
    expect(error).toMatchObject({ reason: 'offset', index: 1 });
    expect(error.message).toMatch(/stop 1 is 150\.\d m from the shape \(max 100 m\)/);
    expect(okValue(projectStops(geometry, [at(0, 0), at(500, 99), at(1000, 0)])).map((d) => Math.round(d))).toEqual([0, 500, 1000]);
  });
});
