import { useEffect, useMemo, useState } from 'react';

import type { ScheduleRepo } from '@/data/schedule-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import { nearestPlatform } from '@/domain/hurry/platform';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';
import type { LiveState } from '@/live/runtime';

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
 *
 * mfix7 (Jamie's 07:10 recording: the Brickell City Centre sheet opened on "Missed · next 7:18 · not worth
 * it", Scheduled, and flipped ~1 s later to the live "Not worth it · next in 7 min"): the STATION SHEET reads
 * useStationHurryVerdict, which holds a verdict back as 'checking' while a live provider serves predictions
 * and the station's first batch has not arrived — for at most LIVE_CHECK_TIMEOUT_MS from when the sheet
 * started watching. The batch brings the live verdict; the timeout, no key or a failing provider the
 * timetable's. The Now strip ('nearest') is unchanged: it has no room for a note.
 */

export const HURRY_TICK_MS = 15_000;

/** How long the station sheet waits for its station's first live predictions before it shows the timetable's verdict. */
export const LIVE_CHECK_TIMEOUT_MS = 3_000;

export type HurryTarget = { readonly kind: 'nearest' } | { readonly kind: 'station'; readonly stationKey: string };

/** The station sheet's reading: a HurryReading, or 'checking' while its first live predictions are on their way. */
export type SheetReading = HurryReading | { readonly kind: 'checking'; readonly stationKey: string };

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

/** The station sheet's hurry or chill: its station's reading, held back as 'checking' while its first live batch is awaited. */
export function useStationHurryVerdict(stationKey: string, clock: () => number = wallClockNowS): SheetReading {
  const reading = useHurryVerdict({ kind: 'station', stationKey }, clock);
  const checking = useLiveCheck(stationKey);
  const sheet: SheetReading = checking && reading.kind === 'boards' ? { kind: 'checking', stationKey } : reading;
  invariant(sheet.kind !== 'checking' || reading.kind === 'boards', 'only a verdict is held back; every other reading shows as it is');
  invariant(sheet.kind === 'checking' || sheet === reading, 'once the wait is over the reading shows unchanged');
  return sheet;
}

/**
 * True while the sheet waits for `stationKey`'s FIRST live predictions: a live provider serves predictions,
 * no batch for the station has arrived since the sheet started watching it, and LIVE_CHECK_TIMEOUT_MS has not
 * passed. The runtime keeps a station's batch only while it is watched, so the sheet's own watch keeps the
 * first batch for as long as the sheet is open, and a batch present at once came from a watch that is still
 * running (the Now strip's on the same station) and is used straight away.
 */
function useLiveCheck(stationKey: string): boolean {
  const { state } = useLive();
  const arrived = state?.predictions.has(stationKey) === true;
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => waitForLive(stationKey, setExpiredFor), [stationKey]);
  const checking = expiredFor !== stationKey && !arrived && servesPredictions(state);
  invariant(!checking || state !== null, 'only a live runtime is waited for');
  invariant(!(checking && arrived), 'the wait ends when the first batch arrives');
  return checking;
}

/** Ends the wait for `stationKey` after LIVE_CHECK_TIMEOUT_MS; returns the teardown (a sheet closed or retargeted). */
function waitForLive(stationKey: string, expire: (stationKey: string) => void): () => void {
  invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  invariant(LIVE_CHECK_TIMEOUT_MS > 0 && LIVE_CHECK_TIMEOUT_MS <= 4_000, 'the wait is short');
  const timer = setTimeout(() => expire(stationKey), LIVE_CHECK_TIMEOUT_MS);
  return () => clearTimeout(timer);
}

/** A live provider is serving predictions: the chain has one (so a key is saved) and it is not failing. */
function servesPredictions(state: LiveState | null): boolean {
  const status = state === null ? null : state.status.predictions;
  const serving = status !== null && status.provider !== 'none' && !status.failing;
  invariant(!serving || state !== null, 'only a runtime serves predictions');
  invariant(status === null || typeof status.failing === 'boolean', 'a predictions chain says whether it is failing');
  return serving;
}
