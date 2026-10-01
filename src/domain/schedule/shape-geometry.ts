import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * Plan §4 step 9 (M2.11): shapes in metres. A shape's cumulative distance is the haversine sum of
 * its legs; a pattern's stops are projected onto it as distances along it.
 *
 * Projection is a monotone ALIGNMENT, not "nearest point per stop": on a loop the last stop sits on
 * top of the first point, and a shape can pass the same street twice, so each stop's nearest point
 * can lie behind the previous stop. The stops are matched to segments by dynamic programming —
 * distances never decrease along the pattern, and the total stop-to-track offset is the smallest
 * such matching.
 *
 * The M2.11 ruling (arbiter, 2026-10-01, measured on the live feed): the county's rail shapes stop
 * short of the terminal platforms — Palmetto sits ~103 m past the shape end ALONG the track (only
 * ~5 m sideways), Dadeland South ~50 m past. So:
 *  1. an INTERIOR stop must be within 100 m of the shape (nearest point on it);
 *  2. the FIRST and LAST stop are measured against the terminal segment extended as a ray: at most
 *     100 m sideways AND at most 150 m past that end of the shape;
 *  3. an overhanging terminal stop reads as a distance before the start (< 0) or past the end
 *     (> lengthM); `overhangOf` measures it and `extendShape` adds the stop's projection on the ray
 *     as the new terminal point, so the drawn line reaches the platform and distances stay monotone;
 *  4. anything farther is an Err naming the stop (the caller adds the shape).
 */

/** A stop farther than this from its pattern's shape is a data error, not a projection. */
export const MAX_STOP_OFFSET_M = 100;
/** A pattern's first or last stop may lie at most this far past the shape's end, along the terminal ray. */
export const MAX_TERMINAL_OVERHANG_M = 150;
/** An overhang this small is float noise at an end point: it reads as on the shape, never as an extension. */
const OVERHANG_NOISE_M = 0.01;

export type ShapeGeometry = {
  readonly points: readonly LatLon[];
  /** cumulativeM[i] = metres along the shape from points[0] to points[i]; cumulativeM[0] = 0. */
  readonly cumulativeM: readonly number[];
  readonly lengthM: number;
  /**
   * Metres the build added to the published polyline to reach overhanging terminal platforms: the
   * LONGER of the two end extensions (each is capped at MAX_TERMINAL_OVERHANG_M). 0 = as published.
   */
  readonly extendedM: number;
};

/** How far a pattern's terminal stops lie beyond the shape's two ends, along the terminal rays (0 = on it). */
export type Overhang = { readonly startM: number; readonly endM: number };

export type ShapeError = {
  readonly kind: 'shape';
  readonly reason: 'too-few-points' | 'bad-point' | 'offset' | 'overhang' | 'order';
  readonly message: string;
  /** The offending stop (offset / overhang / order) or point (bad-point), when there is one. */
  readonly index: number | null;
};

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS_PER_DEGREE = Math.PI / 180;
const METRES_PER_DEGREE = EARTH_RADIUS_M * RADIANS_PER_DEGREE;

export function buildShapeGeometry(points: readonly LatLon[]): Result<ShapeGeometry, ShapeError> {
  invariant(Array.isArray(points), 'a shape is a list of points');
  if (points.length < 2) {
    return err({ kind: 'shape', reason: 'too-few-points', message: `a shape needs 2 points, got ${points.length}`, index: null });
  }
  const bad = points.findIndex((point) => !isLatLon(point));
  if (bad >= 0) {
    return err({ kind: 'shape', reason: 'bad-point', message: `shape point ${bad} is not a coordinate`, index: bad });
  }
  const cumulativeM = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulativeM.push((cumulativeM[i - 1] ?? 0) + haversineMeters(at(points, i - 1), at(points, i)));
  }
  const lengthM = cumulativeM[cumulativeM.length - 1] ?? 0;
  invariant(cumulativeM.every((d, i) => i === 0 || d >= (cumulativeM[i - 1] ?? 0)), 'cumulative distance never decreases');
  return ok({ points, cumulativeM, lengthM, extendedM: 0 });
}

/**
 * Each stop's distance along the shape (metres), non-decreasing in stop order. An overhanging first
 * stop reads as a negative distance and an overhanging last stop as more than lengthM (rule 3).
 */
export function projectStops(shape: ShapeGeometry, stops: readonly LatLon[]): Result<number[], ShapeError> {
  invariant(shape.points.length >= 2 && shape.cumulativeM.length === shape.points.length, 'projection needs a built shape');
  invariant(stops.length >= 1 && stops.every(isLatLon), 'projection needs valid stop coordinates');
  const last = stops.length - 1;
  const candidates = stops.map((stop, i) => segmentProjections(shape, stop, { before: i === 0, after: i === last }));
  const unplaceable = candidates.findIndex((projection) => !projection.offsetM.some((_, j) => Number.isFinite(feasible(projection, j))));
  if (unplaceable >= 0) {
    return err(placementError(at(candidates, unplaceable), unplaceable));
  }
  const segments = alignMonotone(candidates);
  if (typeof segments === 'number') {
    const message = `stop ${segments} cannot be projected in order within ${MAX_STOP_OFFSET_M} m of the shape`;
    return err({ kind: 'shape', reason: 'order', message, index: segments });
  }
  const distances = segments.map((segment, i) => at(at(candidates, i).alongM, segment));
  invariant(distances.every((d, i) => i === 0 || d >= at(distances, i - 1)), 'projected distances never decrease');
  return ok(distances);
}

/** How far the first projected stop lies before the start and the last one past the end (rule 3). */
export function overhangOf(shape: ShapeGeometry, distancesM: readonly number[]): Overhang {
  invariant(distancesM.length >= 1, 'an overhang is measured on projected stops');
  const overhang = { startM: Math.max(0, -at(distancesM, 0)), endM: Math.max(0, at(distancesM, distancesM.length - 1) - shape.lengthM) };
  invariant(
    overhang.startM <= MAX_TERMINAL_OVERHANG_M && overhang.endM <= MAX_TERMINAL_OVERHANG_M,
    `a projected overhang is within ${MAX_TERMINAL_OVERHANG_M} m (projectStops enforces it)`,
  );
  return overhang;
}

/**
 * The published shape lengthened along its terminal rays: a new first point `startM` before the
 * start and a new last point `endM` past the end. Every existing distance shifts by startM, so a
 * stop's distance on the extended shape is its projected distance + startM.
 */
export function extendShape(shape: ShapeGeometry, overhang: Overhang): ShapeGeometry {
  invariant(shape.extendedM === 0, 'only a published shape is extended (extension is decided once, for every pattern on it)');
  invariant(overhang.startM >= 0 && overhang.endM >= 0, 'an extension never shortens a shape');
  if (overhang.startM === 0 && overhang.endM === 0) {
    return shape;
  }
  const n = shape.points.length;
  const points = [...shape.points];
  const cumulativeM = shape.cumulativeM.map((d) => d + overhang.startM);
  if (overhang.startM > 0) {
    points.unshift(alongRay(at(shape.points, 1), at(shape.points, 0), overhang.startM));
    cumulativeM.unshift(0);
  }
  if (overhang.endM > 0) {
    points.push(alongRay(at(shape.points, n - 2), at(shape.points, n - 1), overhang.endM));
    cumulativeM.push(shape.lengthM + overhang.startM + overhang.endM);
  }
  const lengthM = at(cumulativeM, cumulativeM.length - 1);
  invariant(Math.abs(lengthM - (shape.lengthM + overhang.startM + overhang.endM)) < 1e-6, 'the extension adds exactly the overhangs');
  return { points, cumulativeM, lengthM, extendedM: Math.max(overhang.startM, overhang.endM) };
}

/** The point `metres` beyond `to` on the ray from `from` through `to` (local planar frame at `to`). */
function alongRay(from: LatLon, to: LatLon, metres: number): LatLon {
  invariant(metres > 0, 'a ray point lies beyond the end');
  const east = Math.cos(to.latitude * RADIANS_PER_DEGREE) * METRES_PER_DEGREE;
  const [dx, dy] = [(to.longitude - from.longitude) * east, (to.latitude - from.latitude) * METRES_PER_DEGREE];
  const length = Math.hypot(dx, dy);
  invariant(length > 0, 'a terminal segment with a direction (an overhang is only measured on one)');
  const point = { latitude: to.latitude + ((dy / length) * metres) / METRES_PER_DEGREE, longitude: to.longitude + ((dx / length) * metres) / east };
  invariant(isLatLon(point), 'the extension point is a coordinate');
  return point;
}

type Projection = {
  readonly alongM: Float64Array;
  /** Distance from the track: to the nearest point of the segment, or sideways from its ray. */
  readonly offsetM: Float64Array;
  /** Metres past the shape's end along a terminal ray (0 within the segment). */
  readonly overhangM: Float64Array;
};
type Rays = { readonly before: boolean; readonly after: boolean };

/**
 * The stop's closest point on every segment: distance along the shape, offset from it, and how far
 * past an end it lies. The first stop may run back off segment 0, the last stop on past the last
 * segment (the terminal rays); every other projection is clamped to its segment.
 */
function segmentProjections(shape: ShapeGeometry, stop: LatLon, rays: Rays): Projection {
  const segmentCount = shape.points.length - 1;
  invariant(segmentCount >= 1, 'a shape has at least one segment');
  const [alongM, offsetM, overhangM] = [new Float64Array(segmentCount), new Float64Array(segmentCount), new Float64Array(segmentCount)];
  for (let j = 0; j < segmentCount; j += 1) {
    const from = at(shape.points, j);
    const to = at(shape.points, j + 1);
    // A local planar frame at `from` (metres east, metres north): exact enough for one segment.
    const east = Math.cos(from.latitude * RADIANS_PER_DEGREE) * METRES_PER_DEGREE;
    const [qx, qy] = [(to.longitude - from.longitude) * east, (to.latitude - from.latitude) * METRES_PER_DEGREE];
    const [sx, sy] = [(stop.longitude - from.longitude) * east, (stop.latitude - from.latitude) * METRES_PER_DEGREE];
    const lengthSquared = qx * qx + qy * qy;
    const legM = at(shape.cumulativeM, j + 1) - at(shape.cumulativeM, j);
    const raw = lengthSquared === 0 ? 0 : (sx * qx + sy * qy) / lengthSquared;
    const t = clampToSegment(raw, legM, rays.before && j === 0, rays.after && j === segmentCount - 1);
    alongM[j] = at(shape.cumulativeM, j) + t * legM;
    offsetM[j] = Math.hypot(sx - t * qx, sy - t * qy);
    overhangM[j] = t < 0 ? -t * legM : t > 1 ? (t - 1) * legM : 0;
  }
  invariant(offsetM.every((d) => Number.isFinite(d) && d >= 0), 'every offset is a finite distance');
  return { alongM, offsetM, overhangM };
}

/** The segment parameter: inside [0, 1], or beyond an end onto an open terminal ray (noise snapped back). */
function clampToSegment(raw: number, legM: number, openBefore: boolean, openAfter: boolean): number {
  invariant(Number.isFinite(raw), 'the projection parameter is a number');
  invariant(legM >= 0, 'a leg has a length');
  if (openBefore && raw < 0 && -raw * legM > OVERHANG_NOISE_M) {
    return raw;
  }
  if (openAfter && raw > 1 && (raw - 1) * legM > OVERHANG_NOISE_M) {
    return raw;
  }
  return Math.min(1, Math.max(0, raw));
}

/** Why a stop fits on no segment: too far sideways, or (a terminal stop) too far past the end. */
function placementError(projection: Projection, index: number): ShapeError {
  const offset = Math.min(...projection.offsetM);
  invariant(Number.isFinite(offset), 'every stop has a nearest offset');
  if (offset > MAX_STOP_OFFSET_M) {
    const message = `stop ${index} is ${offset.toFixed(1)} m from the shape (max ${MAX_STOP_OFFSET_M} m)`;
    return { kind: 'shape', reason: 'offset', message, index };
  }
  // Within 100 m sideways but placeable nowhere: only a terminal ray candidate can be, and it is too long.
  const j = projection.offsetM.findIndex((d, k) => d <= MAX_STOP_OFFSET_M && at(projection.overhangM, k) > MAX_TERMINAL_OVERHANG_M);
  invariant(j >= 0, 'an unplaceable stop within 100 m of the track overhangs a terminal ray');
  const end = j === 0 && at(projection.alongM, 0) < 0 ? 'start' : 'end';
  const message = `stop ${index} is ${at(projection.overhangM, j).toFixed(1)} m past the shape ${end} along the track (max ${MAX_TERMINAL_OVERHANG_M} m)`;
  return { kind: 'shape', reason: 'overhang', message, index };
}

/**
 * The segment for each stop minimising the total offset, with distances non-decreasing and every
 * placement feasible. cost[i][j] = best total for stops 0..i with stop i on segment j.
 * Returns the segments, or the index of the first stop that cannot be placed in order.
 */
function alignMonotone(candidates: readonly Projection[]): number[] | number {
  const segmentCount = at(candidates, 0).offsetM.length;
  invariant(candidates.every((c) => c.offsetM.length === segmentCount), 'every stop is projected on the same segments');
  const cost = candidates.map(() => new Float64Array(segmentCount).fill(Infinity));
  const previous = candidates.map(() => new Int32Array(segmentCount).fill(-1));
  for (let j = 0; j < segmentCount; j += 1) {
    at(cost, 0)[j] = feasible(at(candidates, 0), j);
  }
  for (let i = 1; i < candidates.length; i += 1) {
    const placed = placeStop(at(candidates, i - 1), at(cost, i - 1), at(candidates, i), at(cost, i), at(previous, i));
    if (!placed) {
      return i;
    }
  }
  const lastCost = at(cost, candidates.length - 1);
  let best = lastCost.indexOf(Math.min(...lastCost));
  invariant(Number.isFinite(at(lastCost, best)), 'every stop was placed, so the last row has a finite cost');
  const segments = new Array<number>(candidates.length).fill(0);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    segments[i] = best;
    best = at(at(previous, i), best);
  }
  invariant(segments.every((j, i) => i === 0 || j >= at(segments, i - 1)), 'aligned segments never go backwards');
  return segments;
}

/** One DP row: stop i on segment j follows the cheapest earlier placement of stop i-1. False if none fits. */
function placeStop(before: Projection, beforeCost: Float64Array, stop: Projection, cost: Float64Array, previous: Int32Array): boolean {
  invariant(before.alongM.length === stop.alongM.length, 'consecutive stops share the segment list');
  let bestEarlier = Infinity;
  let bestEarlierAt = -1;
  for (let j = 0; j < cost.length; j += 1) {
    const sameSegment = at(before.alongM, j) <= at(stop.alongM, j) ? at(beforeCost, j) : Infinity;
    const [from, fromAt] = bestEarlier <= sameSegment ? [bestEarlier, bestEarlierAt] : [sameSegment, j];
    cost[j] = from + feasible(stop, j);
    previous[j] = fromAt;
    if (at(beforeCost, j) < bestEarlier) {
      [bestEarlier, bestEarlierAt] = [at(beforeCost, j), j];
    }
  }
  const placed = cost.some(Number.isFinite);
  invariant(!placed || previous.some((j) => j >= 0), 'a placed stop has a predecessor');
  return placed;
}

/** The stop's offset on segment j, or Infinity when it is too far (sideways, or past a terminal end) to go there. */
function feasible(stop: Projection, j: number): number {
  const offset = at(stop.offsetM, j);
  invariant(offset >= 0, 'offsets are distances');
  invariant(j >= 0 && j < stop.offsetM.length, 'the segment exists');
  return offset <= MAX_STOP_OFFSET_M && at(stop.overhangM, j) <= MAX_TERMINAL_OVERHANG_M ? offset : Infinity;
}

/** Indexed read that fails loudly instead of yielding undefined. */
function at<T>(list: ArrayLike<T>, index: number): T {
  invariant(Number.isInteger(index) && index >= 0 && index < list.length, `index ${index} is inside a list of ${list.length}`);
  const value = list[index];
  invariant(value !== undefined, `item ${index} is present`);
  return value;
}
