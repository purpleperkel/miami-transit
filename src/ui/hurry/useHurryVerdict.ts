import { useEffect, useMemo } from 'react';

import type { ScheduleRepo } from '@/data/schedule-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import { nearestPlatform } from '@/domain/hurry/platform';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';

import { useNowS, wallClockNowS } from '../clock';
import { useUserPosition } from '../map/use-user-location';
import { readWalkingPace } from '../settings/walking-pace';
import { watchStation } from '../stations/use-station-predictions';
import { HURRY_RANGE_M, type HurryReading, hurryReading, stationTimetable } from './hurry-reading';

/**
 * Plan M7c.3: hurry-or-chill, live. Composes the real pieces —
 *   the schedule DB (its platforms and departures), the rider's position (useUserPosition, the app's ONE
 *   location watch, through expo-location), the station's live predictions (the live runtime, m4b),
 *   Jamie's walk and jog paces (m8b's readWalkingPace, Data & Settings) and the clock —
 * into a HurryReading (hurry-reading.ts), recomputed on every 15 s tick and every new fix or batch.
 *
 * Targets: `station` — the open station sheet's station; `nearest` — the Now strip's: the station of the
 * nearest platform. REALTIME COST RULE: the hook watches ONE station's predictions, and for `nearest`
 * only while that station is within HURRY_RANGE_M (a rider across town costs no calls). Watches are
 * counted per station (use-station-predictions.ts), so a sheet and the strip on the same station poll once.
 */

export const HURRY_TICK_MS = 15_000;

export type HurryTarget = { readonly kind: 'nearest' } | { readonly kind: 'station'; readonly stationKey: string };

/** The station a reading is about, and the one whose live predictions are watched (null: none). */
type Chosen = { readonly stationKey: string | null; readonly watch: string | null };
const NONE: Chosen = Object.freeze({ stationKey: null, watch: null });

export function useHurryVerdict(target: HurryTarget, clock: () => number = wallClockNowS): HurryReading {
  const db = useScheduleDb();
  const position = useUserPosition();
  const { state, runtime } = useLive();
  const nowS = useNowS(HURRY_TICK_MS, clock);
  const minuteS = nowS - (nowS % 60);
  const repo = db.kind === 'ready' ? db.repo : null;
  const targetKey = target.kind === 'station' ? target.stationKey : null;
  const chosen = useMemo(() => chooseStation(repo, position.coordinate, targetKey), [repo, position.coordinate, targetKey]);
  useEffect(() => (runtime === null || chosen.watch === null ? undefined : watchStation(runtime, chosen.watch)), [runtime, chosen.watch]);
  const timetable = useMemo(() => (repo === null || chosen.stationKey === null ? null : stationTimetable(repo, chosen.stationKey, minuteS)), [repo, chosen.stationKey, minuteS]);
  const batch = chosen.stationKey === null ? null : (state?.predictions.get(chosen.stationKey) ?? null);
  const { walkMps, jogMps } = readWalkingPace();
  const reading = useMemo(() => hurryReading({ db, position, timetable, batch, nowS, pace: { walkMps, jogMps } }), [db, position, timetable, batch, nowS, walkMps, jogMps]);
  invariant(target.kind === 'nearest' || chosen.stationKey === target.stationKey, 'a station sheet reads its own station');
  invariant(reading.kind !== 'boards' || reading.stationKey === chosen.stationKey, 'the reading is about the chosen station');
  return reading;
}

/** The target's station: the one asked for, or the station of the nearest platform once there is a fix. */
function chooseStation(repo: ScheduleRepo | null, coordinate: LatLon | null, targetKey: string | null): Chosen {
  invariant(targetKey === null || targetKey.includes(':'), `a station is keyed mode:name, got "${targetKey}"`);
  if (targetKey !== null) {
    return { stationKey: targetKey, watch: targetKey };
  }
  const nearest = repo === null || coordinate === null ? null : nearestPlatform(coordinate, repo.platforms(), null);
  if (nearest === null) {
    return NONE;
  }
  const stationKey = nearest.platform.stationKey;
  invariant(stationKey.includes(':'), 'the nearest platform belongs to a station');
  return { stationKey, watch: nearest.walkMeters <= HURRY_RANGE_M ? stationKey : null };
}
