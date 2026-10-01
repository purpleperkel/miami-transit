import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';

/**
 * Map geometry for drawing (plan M5.6): zoom buckets, metres per screen point, polylines offset
 * sideways (the shared trunk drawn as parallel lines, plan §4), and the region that frames a set of
 * points. Pure, with relative imports only, so the Mac's node:test suites can run it as well as jest.
 *
 * Offsets are computed on a local tangent plane (x east, y north, in metres) anchored at the line's
 * mean latitude. Over the whole network (0.24° of latitude) its east-west scale is off by under
 * 0.3 %, about 1 cm on a 5 m offset.
 */

/** A map region as react-native-maps takes it (its `Region`): a centre and a span in degrees. */
export type MapRegion = {
  readonly latitude: number;
  readonly longitude: number;
  readonly latitudeDelta: number;
  readonly longitudeDelta: number;
};

export const ZOOM_BUCKETS = [0, 1, 2, 3] as const;
/** 0 system · 1 city · 2 downtown · 3 street. Markers and line spacing change per bucket, not per frame. */
export type ZoomBucket = (typeof ZOOM_BUCKETS)[number];

/**
 * The smallest latitudeDelta of buckets 0, 1 and 2; bucket 3 is everything closer.
 *   0 system   ≥ 0.15°  (≥ ~17 km tall: the whole rail network, Palmetto to Dadeland South)
 *   1 city     ≥ 0.06°  (~7–17 km: a stretch of line; downtown is one cluster)
 *   2 downtown ≥ 0.02°  (~2–7 km: the Mover loops become legible)
 *   3 street   < 0.02°  (under ~2 km: single Mover stations)
 */
export const ZOOM_BUCKET_MIN_DELTA = [0.15, 0.06, 0.02] as const;

/**
 * A typical latitudeDelta inside each bucket: the geometric middle of its range, taking 0.5° (all of
 * Miami-Dade) as bucket 0's top and 0.005° (a few blocks) as bucket 3's bottom.
 */
const TYPICAL_DELTA: Readonly<Record<ZoomBucket, number>> = { 0: 0.27, 1: 0.095, 2: 0.035, 3: 0.01 };
/** The map is full-bleed: its height is the phone's (852 pt on the 6.1-inch iPhones since the 15). */
export const REFERENCE_MAP_HEIGHT_PT = 852;
/** A region never spans less than this (about 550 m), so one point still frames a street view. */
export const MIN_REGION_DELTA = 0.005;

const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;
/** Points closer than this are one vertex: an offset needs a direction, and a repeated point has none. */
const SAME_POINT_M = 0.01;
/** A corner on the offset's outer side is mitred while the mitre stays within 5 % of the offset… */
const OUTER_MITER_TOLERANCE = 1.05;
const MAX_OUTER_MITER_TURN = 2 * Math.acos(1 / OUTER_MITER_TOLERANCE);
/** …and rounded beyond that, one vertex per 15° of turn (the chord sags under 1 % of the offset). */
const ROUND_STEP = Math.PI / 12;
/** On the inner side, a mitre longer than this many offsets is clamped (a hairpin folds back on itself). */
const INNER_MITER_LIMIT = 4;

/** The zoom bucket of a region whose height spans `latitudeDelta` degrees. */
export function zoomBucket(latitudeDelta: number): ZoomBucket {
  invariant(Number.isFinite(latitudeDelta) && latitudeDelta > 0, `a region spans a positive latitudeDelta, got ${latitudeDelta}`);
  const index = ZOOM_BUCKET_MIN_DELTA.findIndex((min) => latitudeDelta >= min);
  const bucket = (index === -1 ? ZOOM_BUCKET_MIN_DELTA.length : index) as ZoomBucket;
  invariant(ZOOM_BUCKETS.includes(bucket), `bucket ${bucket} is one of ${ZOOM_BUCKETS.join(', ')}`);
  return bucket;
}

/** Metres covered by one screen point when a map `heightPt` tall spans `latitudeDelta` degrees. */
export function metresPerPoint(latitudeDelta: number, heightPt: number): number {
  invariant(Number.isFinite(latitudeDelta) && latitudeDelta > 0, 'a region spans a positive latitudeDelta');
  invariant(Number.isFinite(heightPt) && heightPt > 0, 'the map has a positive height');
  return (latitudeDelta * METRES_PER_DEGREE) / heightPt;
}

/** Metres per screen point at a bucket's typical zoom on a full-bleed map. */
export function bucketMetresPerPoint(bucket: ZoomBucket): number {
  invariant(ZOOM_BUCKETS.includes(bucket), `${bucket} is a zoom bucket`);
  const metres = metresPerPoint(TYPICAL_DELTA[bucket], REFERENCE_MAP_HEIGHT_PT);
  invariant(zoomBucket(TYPICAL_DELTA[bucket]) === bucket, `the typical delta of bucket ${bucket} lies inside it`);
  return metres;
}

/** A local tangent plane: degrees ↔ metres east (x) and north (y) of an origin. */
export type Plane = { readonly origin: LatLon; readonly metresPerDegreeLon: number };
export type Vec = { readonly x: number; readonly y: number };

/** The plane anchored at the points' first point, scaled at their mean latitude. */
export function planeOf(points: readonly LatLon[]): Plane {
  const first = points[0];
  invariant(first !== undefined && points.every(isLatLon), 'a plane is anchored on real coordinates');
  const meanLatitude = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const plane = { origin: first, metresPerDegreeLon: METRES_PER_DEGREE * Math.cos((meanLatitude * Math.PI) / 180) };
  invariant(plane.metresPerDegreeLon > 0, 'the plane has an east-west scale');
  return plane;
}

export function toPlane(plane: Plane, point: LatLon): Vec {
  invariant(isLatLon(point), 'only a real coordinate is projected');
  const v = { x: (point.longitude - plane.origin.longitude) * plane.metresPerDegreeLon, y: (point.latitude - plane.origin.latitude) * METRES_PER_DEGREE };
  invariant(Number.isFinite(v.x) && Number.isFinite(v.y), 'a projected point is finite');
  return v;
}

export function fromPlane(plane: Plane, v: Vec): LatLon {
  invariant(Number.isFinite(v.x) && Number.isFinite(v.y), 'only a finite plane point is unprojected');
  const point = { latitude: plane.origin.latitude + v.y / METRES_PER_DEGREE, longitude: plane.origin.longitude + v.x / plane.metresPerDegreeLon };
  invariant(isLatLon(point), 'an unprojected point is a real coordinate');
  return point;
}

/** The line moved `offsetM` metres sideways: positive to the right of its direction of travel, negative to the left. */
export function offsetPolyline(line: readonly LatLon[], offsetM: number): LatLon[] {
  invariant(Number.isFinite(offsetM), `an offset is a finite number of metres, got ${offsetM}`);
  invariant(line.length >= 2, 'a polyline has at least two points');
  return offsetPolylineBy(line, new Array<number>(line.length).fill(offsetM));
}

/**
 * The line with each vertex moved sideways by its own offset (positive = right of travel), so a line
 * can leave a shared corridor's lane and return to its own track. Corners on the outer side are
 * mitred while the mitre stays within 5 % of the offset and rounded beyond; inner corners are mitred.
 */
export function offsetPolylineBy(line: readonly LatLon[], offsetsM: readonly number[]): LatLon[] {
  invariant(line.length >= 2 && offsetsM.length === line.length, 'one offset per vertex of a polyline');
  invariant(offsetsM.every(Number.isFinite), 'every offset is a finite number of metres');
  const plane = planeOf(line);
  const vertices = distinctVertices(line.map((point) => toPlane(plane, point)), offsetsM);
  const out: Vec[] = [];
  for (let i = 0; i < vertices.points.length; i += 1) {
    out.push(...cornerAt(vertices.points, i, vertices.offsets[i] ?? 0));
  }
  invariant(out.length >= vertices.points.length, 'every vertex gives at least one offset point');
  return out.map((v) => fromPlane(plane, v));
}

/** The vertices with repeated points (closer than 1 cm) dropped, each keeping its offset. */
function distinctVertices(points: readonly Vec[], offsets: readonly number[]): { points: Vec[]; offsets: number[] } {
  invariant(points.length === offsets.length, 'one offset per vertex');
  const kept: { points: Vec[]; offsets: number[] } = { points: [], offsets: [] };
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as Vec;
    const last = kept.points[kept.points.length - 1];
    if (last === undefined || Math.hypot(point.x - last.x, point.y - last.y) >= SAME_POINT_M) {
      kept.points.push(point);
      kept.offsets.push(offsets[i] ?? 0);
    }
  }
  invariant(kept.points.length >= 2, 'a polyline spans at least two distinct points');
  return kept;
}

/** The unit direction from a to b, and its right-hand normal. */
function heading(a: Vec, b: Vec): { readonly dir: Vec; readonly normal: Vec } {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  invariant(length >= SAME_POINT_M, 'a heading joins two distinct points');
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  invariant(Math.abs(Math.hypot(dir.x, dir.y) - 1) < 1e-9, 'a direction is a unit vector');
  return { dir, normal: { x: dir.y, y: -dir.x } };
}

/** The offset point(s) for vertex i: one at an end or a mitre, an arc of them around a sharp outer corner. */
function cornerAt(points: readonly Vec[], i: number, offsetM: number): Vec[] {
  const p = points[i];
  invariant(p !== undefined, `vertex ${i} exists`);
  const before = i > 0 ? heading(points[i - 1] as Vec, p) : null;
  const after = i < points.length - 1 ? heading(p, points[i + 1] as Vec) : null;
  const into = before ?? after;
  invariant(into !== null, 'a vertex of a two-point line has a neighbour');
  if (before === null || after === null || offsetM === 0) {
    return [{ x: p.x + offsetM * into.normal.x, y: p.y + offsetM * into.normal.y }];
  }
  const cross = before.dir.x * after.dir.y - before.dir.y * after.dir.x;
  const turn = Math.atan2(cross, before.dir.x * after.dir.x + before.dir.y * after.dir.y);
  if (Math.abs(turn) > Math.PI - 1e-6) {
    // A hairpin has no inside: the offset caps it with a half circle ahead of the vertex.
    return roundCorner(p, before.normal, Math.sign(offsetM) * Math.PI, offsetM);
  }
  // A left turn (cross > 0) puts the right side (offset > 0) on the outside of the corner.
  if (cross * offsetM > 0 && Math.abs(turn) > MAX_OUTER_MITER_TURN) {
    return roundCorner(p, before.normal, turn, offsetM);
  }
  return [miterCorner(p, before.normal, after.normal, offsetM)];
}

/** The offset arc around p from the incoming normal through the whole turn, one vertex per ≤ 15°. */
function roundCorner(p: Vec, normal: Vec, turn: number, offsetM: number): Vec[] {
  const steps = Math.ceil(Math.abs(turn) / ROUND_STEP);
  invariant(steps >= 1 && steps <= 12, 'a turn of at most 180° is rounded in 1–12 steps');
  const arc: Vec[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const angle = (turn * k) / steps;
    const n = { x: normal.x * Math.cos(angle) - normal.y * Math.sin(angle), y: normal.x * Math.sin(angle) + normal.y * Math.cos(angle) };
    arc.push({ x: p.x + offsetM * n.x, y: p.y + offsetM * n.y });
  }
  invariant(arc.length === steps + 1, 'the arc runs from the incoming to the outgoing normal');
  return arc;
}

/** Where the two offset edges meet: p + (n1 + n2)·d / (1 + n1·n2), clamped to INNER_MITER_LIMIT offsets. */
function miterCorner(p: Vec, n1: Vec, n2: Vec, offsetM: number): Vec {
  const sum = { x: n1.x + n2.x, y: n1.y + n2.y };
  const sumLength = Math.hypot(sum.x, sum.y);
  invariant(sumLength > 1e-9, 'a mitre joins two edges that do not fold back (hairpins are rounded)');
  const unit = { x: sum.x / sumLength, y: sum.y / sumLength };
  const cosHalf = sumLength / 2;
  const length = cosHalf < 1 / INNER_MITER_LIMIT ? INNER_MITER_LIMIT * offsetM : offsetM / cosHalf;
  const corner = { x: p.x + length * unit.x, y: p.y + length * unit.y };
  invariant(Math.hypot(corner.x - p.x, corner.y - p.y) <= INNER_MITER_LIMIT * Math.abs(offsetM) + 1e-6, 'a mitre never reaches past its limit');
  return corner;
}

/** The region centred on the points' bounding box that contains all of them, padded by `padding` of the span per side. */
export function regionForPoints(points: readonly LatLon[], padding = 0.1): MapRegion {
  invariant(points.length > 0 && points.every(isLatLon), 'a region frames at least one real coordinate');
  invariant(Number.isFinite(padding) && padding >= 0, 'padding is a non-negative fraction of the span');
  const box = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  for (const p of points) {
    box.minLat = Math.min(box.minLat, p.latitude);
    box.maxLat = Math.max(box.maxLat, p.latitude);
    box.minLon = Math.min(box.minLon, p.longitude);
    box.maxLon = Math.max(box.maxLon, p.longitude);
  }
  invariant(box.maxLon - box.minLon < 180, 'the points do not straddle the antimeridian');
  const region: MapRegion = {
    latitude: (box.minLat + box.maxLat) / 2,
    longitude: (box.minLon + box.maxLon) / 2,
    latitudeDelta: Math.max((box.maxLat - box.minLat) * (1 + 2 * padding), MIN_REGION_DELTA),
    longitudeDelta: Math.max((box.maxLon - box.minLon) * (1 + 2 * padding), MIN_REGION_DELTA),
  };
  invariant(points.every((p) => regionContains(region, p)), 'the region contains every point it frames');
  return region;
}

/** Whether the point lies inside the region (edges included). */
export function regionContains(region: MapRegion, point: LatLon): boolean {
  invariant(region.latitudeDelta > 0 && region.longitudeDelta > 0, 'a region has a positive span');
  invariant(isLatLon(point), 'containment is asked of a real coordinate');
  return (
    Math.abs(point.latitude - region.latitude) <= region.latitudeDelta / 2 && Math.abs(point.longitude - region.longitude) <= region.longitudeDelta / 2
  );
}
