import { router } from 'expo-router';

import { invariant } from '@/lib/invariant';

/**
 * The trips' doors (plan M7.8–M7.9): a saved trip's own screen (src/app/trip/[tripId].tsx), the add-trip
 * flow (src/app/trip/new/{from,to,start,confirm}.tsx — a modal Stack with no index route, so every door
 * names its first step), and Apple Maps directions to a station (src/app/directions.tsx).
 */

export const TRIP_PATH = '/trip/[tripId]';
/** The add-trip flow's steps, in order. */
export const ADD_TRIP_FROM_PATH = '/trip/new/from';
export const ADD_TRIP_TO_PATH = '/trip/new/to';
export const ADD_TRIP_START_PATH = '/trip/new/start';
export const ADD_TRIP_CONFIRM_PATH = '/trip/new/confirm';
export const DIRECTIONS_PATH = '/directions';

/** Opens a saved trip's screen. */
export function openTrip(tripId: string): void {
  invariant(tripId.length > 0, 'a trip is opened by its id');
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push({ pathname: TRIP_PATH, params: { tripId } });
}

/** Starts the add-trip flow at its first step: choosing the station the trip leaves from. */
export function startAddTrip(): void {
  invariant(ADD_TRIP_FROM_PATH.startsWith('/trip/new/'), 'the flow lives under /trip/new');
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push(ADD_TRIP_FROM_PATH);
}

/** Starts the add-trip flow from a station (the station sheet's "Save trip"): straight to choosing where to. */
export function saveTripFrom(stationKey: string): void {
  invariant(stationKey.includes(':'), `a trip leaves from a station keyed mode:name, got "${stationKey}"`);
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push({ pathname: ADD_TRIP_TO_PATH, params: { from: stationKey } });
}

/** Apple Maps directions to a place, by transit or on foot (the directions screen offers both). */
export function openDirections(place: { readonly name: string; readonly latitude: number; readonly longitude: number }): void {
  invariant(place.name.length > 0, 'directions lead to a named place');
  invariant(Number.isFinite(place.latitude) && Number.isFinite(place.longitude), 'directions lead to a real coordinate');
  router.push({ pathname: DIRECTIONS_PATH, params: { name: place.name, lat: String(place.latitude), lon: String(place.longitude) } });
}
