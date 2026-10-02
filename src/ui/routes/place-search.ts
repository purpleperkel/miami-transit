import * as Location from 'expo-location';

import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';

import { copy } from '../copy';
import type { RecentPlace } from './recent-places';
import { geocodeQuery } from './route-options';

/**
 * Plan M10b.1: the "To" field's search. The rider's words go to the system geocoder through
 * expo-location's geocodeAsync (SDK 57: `geocodeAsync(address) → Promise<LocationGeocodedLocation[]>`,
 * "in most cases its size is 1"; the docs ask for a location permission on Android only), placed in
 * Miami-Dade unless they already name Florida (route-options.ts geocodeQuery). The first match becomes the
 * destination, named by the rider's own words. The docs ask for reasonable use, so a search runs only when
 * the rider submits, never per keystroke.
 */

/** A geocoder: expo-location's on the phone, a stand-in in tests. */
export type Geocoder = (address: string) => Promise<readonly LatLon[]>;

/** The system geocoder (expo-location). */
export function geocodePlace(address: string): Promise<readonly LatLon[]> {
  invariant(address.trim().length > 0, 'a geocoder is asked for words');
  const found = Location.geocodeAsync(address);
  invariant(typeof found.then === 'function', 'the matches arrive later');
  return found;
}

/** The destination the rider's words name, or what to say instead (no match, or the geocoder failed). */
export async function searchPlace(words: string, geocode: Geocoder = geocodePlace): Promise<Result<RecentPlace, string>> {
  const name = words.trim();
  invariant(name.length > 0, 'a search has words');
  const found = await Promise.resolve(geocodeQuery(name)).then(geocode).then(
    (matches) => ok(matches),
    (error: unknown) => err(`${copy.searchFailed}: ${error instanceof Error ? error.message : String(error)}`),
  );
  if (!found.ok) {
    return found;
  }
  const matches: readonly LatLon[] | undefined = found.value;
  const first = matches?.find((match) => isLatLon(match));
  const place = first === undefined ? err(copy.noPlaceFound(name)) : ok({ name, lat: first.latitude, lon: first.longitude });
  invariant(!place.ok || place.value.name === name, 'the destination is named by the rider\'s words');
  return place;
}
