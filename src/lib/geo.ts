import { invariant } from './invariant';

/**
 * Great-circle geometry on WGS 84 coordinates. Pure (no react / expo imports), so the app,
 * `src/domain` and the Mac scripts share one implementation.
 */

export type LatLon = { readonly latitude: number; readonly longitude: number };

/** The IUGG mean Earth radius, in metres. */
const EARTH_RADIUS_M = 6_371_008.8;
const RADIANS_PER_DEGREE = Math.PI / 180;

export function isLatLon(point: LatLon): boolean {
  invariant(typeof point === 'object' && point !== null, 'a coordinate is an object');
  invariant('latitude' in point && 'longitude' in point, 'a coordinate has latitude and longitude');
  const { latitude, longitude } = point;
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/** Haversine distance between two coordinates, in metres. */
export function haversineMeters(from: LatLon, to: LatLon): number {
  invariant(isLatLon(from), `distance needs a valid start coordinate: ${from.latitude},${from.longitude}`);
  invariant(isLatLon(to), `distance needs a valid end coordinate: ${to.latitude},${to.longitude}`);
  const dLat = (to.latitude - from.latitude) * RADIANS_PER_DEGREE;
  const dLon = (to.longitude - from.longitude) * RADIANS_PER_DEGREE;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.latitude * RADIANS_PER_DEGREE) * Math.cos(to.latitude * RADIANS_PER_DEGREE) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  invariant(Number.isFinite(meters) && meters >= 0, 'a distance is a finite, non-negative number of metres');
  return meters;
}
