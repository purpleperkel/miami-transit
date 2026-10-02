import { useCallback, useMemo } from 'react';

import type { SavedTrip } from '@/data/saved-trips-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { Platform } from '@/domain/hurry/platform';
import { walkFor, walkKey, type WalkTo } from '@/domain/walk/walk-cache';
import { haversineMeters, isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { HURRY_RANGE_M } from '../hurry/hurry-reading';
import { useUserPosition } from '../map/use-user-location';
import { useWalkTo } from '../walk/RoutedWalkProvider';

/**
 * mfix11: the saved trips' street walks, for their cards — the Trips tab, the trip screen and the home context's cards
 * (the Now bar's countdown and its choice of near trip) — so a card walks the very distance the bar's verdict walks.
 * The platforms of each trip's origin station WITHIN HURRY_RANGE_M (2 km) of the rider's latest fix are registered with
 * the app's RoutedWalkProvider (mfix9's useWalkTo): nobody walks further, and asking for far origins while riding
 * would cost Transitous a request a minute (mfix11 review). Farther origins, and every origin with no fix, walk the
 * estimate. A trip that walks its own minutes walks to no platform and asks for nothing. Under one provider every consumer's
 * stops travel in ONE request (mfix9's batching), the bar's included. Without a provider: the estimate.
 *
 * Pass the same `trips` array while the trips are the same (the user DB's list is, per revision): a new array
 * registers the stops again (useWalkTo).
 */

const NO_PLATFORMS: readonly Platform[] = Object.freeze([]);

export function useSavedTripsWalk(trips: readonly SavedTrip[]): WalkTo {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const rider = useUserPosition().coordinate;
  // Keyed by the reachable set itself, so a new fix that leaves the set unchanged registers nothing again.
  const reach = useMemo(() => (repo === null ? '' : reachableKeys(repo.platforms(), trips, rider)), [repo, trips, rider]);
  const stops = useMemo(() => (repo === null || reach === '' ? NO_PLATFORMS : platformsOf(repo.platforms(), reach)), [repo, reach]);
  const registered = useWalkTo(stops);
  const reachable = useMemo(() => new Set(stops.map(walkKey)), [stops]);
  // A platform beyond reach was never registered, so the provider is not asked for it: it walks the estimate.
  const walk = useCallback<WalkTo>((stop) => (rider === null || reachable.has(walkKey(stop)) ? registered(stop) : walkFor(null, stop, rider)), [registered, reachable, rider]);
  invariant(trips.every((trip) => trip.fromStationKey.includes(':') && trip.fromStationKey !== trip.toStationKey), 'every saved trip leaves one station, keyed mode:name, for another');
  invariant(new Set(stops.map(walkKey)).size === stops.length, 'each platform is asked for once, under its own walk key');
  return walk;
}

/**
 * The walk keys (space-joined) of the platforms a card may walk to: the origins of the trips that walk to a platform,
 * within HURRY_RANGE_M of the rider. Empty with no fix: then every card walks the estimate.
 */
function reachableKeys(platforms: readonly Platform[], trips: readonly SavedTrip[], rider: LatLon | null): string {
  invariant(platforms.length > 0, 'the open schedule has platforms to walk to');
  invariant(rider === null || isLatLon(rider), 'the rider is a real coordinate, or not located');
  if (rider === null) {
    return '';
  }
  const origins = new Set(trips.filter((trip) => trip.walkOverrideMin === null).map((trip) => trip.fromStationKey));
  return platforms.filter((platform) => origins.has(platform.stationKey) && haversineMeters(rider, platform) <= HURRY_RANGE_M).map(walkKey).join(' ');
}

/** The schedule's platforms named by `keys` (reachableKeys' answer), in schedule order. */
function platformsOf(platforms: readonly Platform[], keys: string): readonly Platform[] {
  invariant(keys !== '', 'only a non-empty set of walk keys names platforms');
  const wanted = new Set(keys.split(' '));
  const picked = platforms.filter((platform) => wanted.has(walkKey(platform)));
  invariant(picked.length === wanted.size, 'every walk key names exactly one platform of the schedule');
  return picked;
}
