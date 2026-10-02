import { useMemo } from 'react';

import type { SavedTrip } from '@/data/saved-trips-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { Platform } from '@/domain/hurry/platform';
import { walkKey, type WalkTo } from '@/domain/walk/walk-cache';
import { invariant } from '@/lib/invariant';

import { useWalkTo } from '../walk/RoutedWalkProvider';

/**
 * mfix11: the saved trips' street walks, for their cards — the Trips tab, the trip screen and the home context's cards
 * (the Now bar's countdown and its choice of near trip) — so a card walks the very distance the bar's verdict walks.
 * Every platform of each trip's origin station is registered with the app's RoutedWalkProvider (mfix9's useWalkTo);
 * a trip that walks its own minutes walks to no platform and asks for nothing. Under one provider every consumer's
 * stops travel in ONE request (mfix9's batching), the bar's included. Without a provider: the estimate.
 *
 * Pass the same `trips` array while the trips are the same (the user DB's list is, per revision): a new array
 * registers the stops again (useWalkTo).
 */

const NO_PLATFORMS: readonly Platform[] = Object.freeze([]);

export function useSavedTripsWalk(trips: readonly SavedTrip[]): WalkTo {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const stops = useMemo(() => (repo === null ? NO_PLATFORMS : walkablePlatforms(repo.platforms(), trips)), [repo, trips]);
  const walk = useWalkTo(stops);
  invariant(trips.every((trip) => trip.fromStationKey.includes(':') && trip.fromStationKey !== trip.toStationKey), 'every saved trip leaves one station, keyed mode:name, for another');
  invariant(new Set(stops.map(walkKey)).size === stops.length, 'each platform is asked for once, under its own walk key');
  return walk;
}

/** Every platform of the origins of the trips that walk to one: a card walks to the nearest of its trip's (savedTripWalk). */
function walkablePlatforms(platforms: readonly Platform[], trips: readonly SavedTrip[]): readonly Platform[] {
  invariant(platforms.length > 0, 'the open schedule has platforms to walk to');
  const origins = new Set(trips.filter((trip) => trip.walkOverrideMin === null).map((trip) => trip.fromStationKey));
  const walkable = platforms.filter((platform) => origins.has(platform.stationKey));
  invariant(walkable.every((platform) => trips.some((trip) => trip.walkOverrideMin === null && trip.fromStationKey === platform.stationKey)), 'only a trip that walks to a platform asks Transitous for a walk, never one walking its own minutes');
  return walkable;
}
