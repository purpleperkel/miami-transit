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
 * such matching. A stop more than 100 m from the track is an Err: the stop or the shape is wrong.
 */

/** A stop farther than this from its pattern's shape is a data error, not a projection. */
export const MAX_STOP_OFFSET_M = 100;

export type ShapeGeometry = {
  readonly points: readonly LatLon[];
  /** cumulativeM[i] = metres along the shape from points[0] to points[i]; cumulativeM[0] = 0. */
  readonly cumulativeM: readonly number[];
  readonly lengthM: number;
};

export type ShapeError = {
  readonly kind: 'shape';
  readonly reason: 'too-few-points' | 'bad-point' | 'offset' | 'order';
  readonly message: string;
  /** The offending stop (offset / order) or point (bad-point), when there is one. */
  readonly index: number | null;
};

const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS_PER_DEGREE = Math.PI / 180;

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
  return ok({ points, cumulativeM, lengthM });
}

/** Each stop's distance along the shape (metres), non-decreasing in stop order. */
export function projectStops(shape: ShapeGeometry, stops: readonly LatLon[]): Result<number[], ShapeError> {
  invariant(shape.points.length >= 2 && shape.cumulativeM.length === shape.points.length, 'projection needs a built shape');
  invariant(stops.length >= 1 && stops.every(isLatLon), 'projection needs valid stop coordinates');
  const candidates = stops.map((stop) => segmentProjections(shape, stop));
  const farthest = candidates.findIndex((projection) => Math.min(...projection.offsetM) > MAX_STOP_OFFSET_M);
  if (farthest >= 0) {
    const offset = Math.min(...at(candidates, farthest).offsetM);
    const message = `stop ${farthest} is ${offset.toFixed(1)} m from the shape (max ${MAX_STOP_OFFSET_M} m)`;
    return err({ kind: 'shape', reason: 'offset', message, index: farthest });
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

type Projection = { readonly alongM: Float64Array; readonly offsetM: Float64Array };

/** The stop's closest point on every segment: distance along the shape, and offset from it. */
function segmentProjections(shape: ShapeGeometry, stop: LatLon): Projection {
  const segmentCount = shape.points.length - 1;
  invariant(segmentCount >= 1, 'a shape has at least one segment');
  const alongM = new Float64Array(segmentCount);
  const offsetM = new Float64Array(segmentCount);
  for (let j = 0; j < segmentCount; j += 1) {
    const from = at(shape.points, j);
    const to = at(shape.points, j + 1);
    // A local planar frame at `from` (metres east, metres north): exact enough for one segment.
    const east = Math.cos(from.latitude * RADIANS_PER_DEGREE) * EARTH_RADIUS_M * RADIANS_PER_DEGREE;
    const north = EARTH_RADIUS_M * RADIANS_PER_DEGREE;
    const [qx, qy] = [(to.longitude - from.longitude) * east, (to.latitude - from.latitude) * north];
    const [sx, sy] = [(stop.longitude - from.longitude) * east, (stop.latitude - from.latitude) * north];
    const lengthSquared = qx * qx + qy * qy;
    const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (sx * qx + sy * qy) / lengthSquared));
    const legM = at(shape.cumulativeM, j + 1) - at(shape.cumulativeM, j);
    alongM[j] = at(shape.cumulativeM, j) + t * legM;
    offsetM[j] = Math.hypot(sx - t * qx, sy - t * qy);
  }
  invariant(offsetM.every((d) => Number.isFinite(d) && d >= 0), 'every offset is a finite distance');
  return { alongM, offsetM };
}

/**
 * The segment for each stop minimising the total offset, with distances non-decreasing and every
 * offset ≤ MAX_STOP_OFFSET_M. cost[i][j] = best total for stops 0..i with stop i on segment j.
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

/** The stop's offset on segment j, or Infinity when it is too far to be projected there. */
function feasible(stop: Projection, j: number): number {
  const offset = at(stop.offsetM, j);
  invariant(offset >= 0, 'offsets are distances');
  invariant(j >= 0 && j < stop.offsetM.length, 'the segment exists');
  return offset <= MAX_STOP_OFFSET_M ? offset : Infinity;
}

/** Indexed read that fails loudly instead of yielding undefined. */
function at<T>(list: ArrayLike<T>, index: number): T {
  invariant(Number.isInteger(index) && index >= 0 && index < list.length, `index ${index} is inside a list of ${list.length}`);
  const value = list[index];
  invariant(value !== undefined, `item ${index} is present`);
  return value;
}
