import { useMemo } from 'react';

import { useScheduleDb } from '@/data/schedule-db-provider';
import type { Platform } from '@/domain/hurry/platform';
import type { WalkEstimate } from '@/domain/walk/walk-cache';
import { invariant } from '@/lib/invariant';

import { useWalkTo } from '../walk/RoutedWalkProvider';
import type { HomeContext } from './homeContext';

/**
 * mfix9 (Jamie, 2026-10-02 09:12: the bar said "chill" for Fifth Street; Google's walk put him a minute late): the Now
 * bar's walk to its near trip's ORIGIN. Every platform of that station is registered with the app's
 * RoutedWalkProvider (useWalkTo), so the bar's verdict (useNearTripVerdict) walks the street-routed distance to the
 * boarding platform when Transitous gave one, and m7c's straight-line estimate otherwise. Without a near trip the bar
 * asks for no walk at all. The two accessory placements iOS mounts register the same stops: one request between them.
 */

const NO_PLATFORMS: readonly Platform[] = Object.freeze([]);

export function useNearTripWalk(context: HomeContext): (stopId: string) => WalkEstimate {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const from = context.kind === 'nearTrip' ? context.card.trip.fromStationKey : null;
  const origin = useMemo(() => (repo === null || from === null ? NO_PLATFORMS : repo.platforms().filter((platform) => platform.stationKey === from)), [repo, from]);
  const walk = useWalkTo(origin);
  invariant(from === null || from.includes(':'), `a trip leaves from a station keyed mode:name, got "${from}"`);
  invariant(origin.every((platform) => platform.stationKey === from), 'the bar walks only to its near trip\'s origin');
  return walk;
}
