import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';

/**
 * Plan M7c.3 "location → nearest station in the trip/route direction, giving walkMeters to its
 * platform". A platform is one GTFS stop of a station, with the directions (GTFS direction_id) whose
 * trains stop there: a rail platform serves one direction, but a Metromover stop can serve BOTH (stop 813
 * at Government Center lists 0 and 1), so `directionIds` is a list.
 *
 * `walkMeters` is the STRAIGHT-LINE (haversine) distance, which picks the nearest platform. It is never padded here: a
 * verdict walks the street-routed metres to that platform when the app knows them (mfix9, detour 1), else this straight
 * line with the engine's own detour factor (verdict.ts). Pure.
 */

export type Platform = {
  readonly stationKey: string;
  readonly stopId: string;
  readonly directionIds: readonly number[];
  readonly latitude: number;
  readonly longitude: number;
};

export type PlatformHit = { readonly platform: Platform; readonly walkMeters: number };

/**
 * The nearest platform whose directions include `directionId` (any platform when it is null), with the
 * straight-line metres to it; null when no platform serves that direction. A tie keeps the first listed.
 */
export function nearestPlatform(position: LatLon, platforms: readonly Platform[], directionId: number | null): PlatformHit | null {
  invariant(isLatLon(position), `a position is a real coordinate, got ${position.latitude},${position.longitude}`);
  invariant(directionId === null || Number.isInteger(directionId), `a direction is a GTFS direction_id, got ${directionId}`);
  let best: PlatformHit | null = null;
  for (const platform of platforms) {
    if (directionId !== null && !platform.directionIds.includes(directionId)) {
      continue;
    }
    const walkMeters = haversineMeters(position, platform);
    if (best === null || walkMeters < best.walkMeters) {
      best = { platform, walkMeters };
    }
  }
  invariant(best === null || directionId === null || best.platform.directionIds.includes(directionId), 'the platform found serves the direction asked for');
  return best;
}
