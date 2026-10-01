import { invariant } from '../../../src/lib/invariant';
import type { ShapePoint } from './schedule-facts';

/**
 * Plane geometry on a shape for the synthetic vehicles: how far a point lies from a polyline, and
 * which way the polyline runs at a distance along it. A local equirectangular projection around the
 * point is exact to well under a centimetre over Miami's few-hundred-metre shape segments.
 */

const METRES_PER_DEGREE_LAT = 110_540;
const METRES_PER_DEGREE_LON_AT_EQUATOR = 111_320;

/** Metres from (latitude, longitude) to the nearest point of the polyline. */
export function metresToPolyline(latitude: number, longitude: number, points: readonly ShapePoint[]): number {
  invariant(points.length >= 2, 'a polyline has at least two points');
  invariant(Number.isFinite(latitude) && Number.isFinite(longitude), 'the point is a coordinate');
  const kx = METRES_PER_DEGREE_LON_AT_EQUATOR * Math.cos((latitude * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as ShapePoint;
    const b = points[i + 1] as ShapePoint;
    const ax = (a.longitude - longitude) * kx;
    const ay = (a.latitude - latitude) * METRES_PER_DEGREE_LAT;
    const dx = (b.longitude - longitude) * kx - ax;
    const dy = (b.latitude - latitude) * METRES_PER_DEGREE_LAT - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Degrees clockwise from true north that the shape runs at `distM` metres along it. */
export function bearingAlong(points: readonly ShapePoint[], distM: number): number {
  invariant(points.length >= 2, 'a polyline has at least two points');
  invariant(Number.isFinite(distM) && distM >= 0, 'a distance along the shape is >= 0');
  let i = 0;
  while (i + 2 < points.length && (points[i + 1] as ShapePoint).distM < distM) {
    i += 1;
  }
  const a = points[i] as ShapePoint;
  const b = points[i + 1] as ShapePoint;
  const east = (b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180);
  const north = b.latitude - a.latitude;
  const degrees = Math.round(((Math.atan2(east, north) * 180) / Math.PI + 360) % 360) % 360;
  invariant(degrees >= 0 && degrees < 360, 'a bearing lies in [0, 360)');
  return degrees;
}
