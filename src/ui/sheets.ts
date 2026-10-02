import { router } from 'expo-router';

import { invariant } from '@/lib/invariant';

/**
 * The doors to the two native sheets (plan M6.4, M6.6): the station sheet (src/app/station/[stationKey].tsx)
 * and the vehicle sheet (src/app/vehicle/[vehicleKey].tsx), opened from the map's markers and the
 * Stations list. The key goes in as the route's param, so expo-router encodes its ':' (`rail:brickell`,
 * `20260930:1403245`) into the path segment and decodes it back for the route.
 *
 * `router.navigate`, not push: when the sheet on top is already a station sheet, tapping another
 * station shows that station in the same sheet (React Navigation updates the current route's params);
 * from the tabs, or over the other kind of sheet, it presents a new one, which a swipe down dismisses.
 */

/** The station sheet route, by its file's pattern. */
export const STATION_SHEET_PATH = '/station/[stationKey]';
/** The vehicle sheet route, by its file's pattern. */
export const VEHICLE_SHEET_PATH = '/vehicle/[vehicleKey]';

/** Opens (or retargets) the station sheet. */
export function openStationSheet(stationKey: string): void {
  invariant(stationKey.includes(':'), `a station key reads mode:name, got "${stationKey}"`);
  invariant(typeof router.navigate === 'function', 'expo-router navigates');
  router.navigate({ pathname: STATION_SHEET_PATH, params: { stationKey } });
}

/** Opens (or retargets) the vehicle sheet. */
export function openVehicleSheet(vehicleKey: string): void {
  invariant(vehicleKey.includes(':'), `a vehicle key reads day:block or live:id, got "${vehicleKey}"`);
  invariant(typeof router.navigate === 'function', 'expo-router navigates');
  router.navigate({ pathname: VEHICLE_SHEET_PATH, params: { vehicleKey } });
}
