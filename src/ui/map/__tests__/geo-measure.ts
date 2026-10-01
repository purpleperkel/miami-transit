import type { LatLon } from '@/lib/geo';

/**
 * Test-side measurement for the map tests: metres from a point to a polyline, on a plane centred at
 * the measured point itself — independent of src/ui/map/mapGeometry.ts's own plane.
 */

export const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

/** Metres from `x` to the nearest point of the polyline. */
export function distanceToLine(x: LatLon, line: readonly LatLon[]): number {
  const kx = METRES_PER_DEGREE * Math.cos((x.latitude * Math.PI) / 180);
  const xy = line.map((p) => ({ x: (p.longitude - x.longitude) * kx, y: (p.latitude - x.latitude) * METRES_PER_DEGREE }));
  let best = Infinity;
  for (let i = 1; i < xy.length; i += 1) {
    const a = xy[i - 1] as { x: number; y: number };
    const b = xy[i] as { x: number; y: number };
    const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * (b.x - a.x) + a.y * (b.y - a.y)) / lengthSq));
    best = Math.min(best, Math.hypot(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
  }
  expect(Number.isFinite(best)).toBe(true);
  expect(best).toBeGreaterThanOrEqual(0);
  return best;
}
