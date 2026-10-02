import { useEffect, useMemo, useState } from 'react';

import { useScheduleDb } from '@/data/schedule-db-provider';
import type { Platform } from '@/domain/hurry/platform';
import type { WalkTo } from '@/domain/walk/walk-cache';
import { haversineMeters } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';
import type { LiveState } from '@/live/runtime';

import { useNowS, wallClockNowS } from '../clock';
import { useUserPosition } from '../map/use-user-location';
import { readWalkingPace } from '../settings/walking-pace';
import type { HomeContext } from '../now/homeContext';
import { watchStation } from '../stations/use-station-predictions';
import { useWalkTo } from '../walk/RoutedWalkProvider';
import { HURRY_RANGE_M, type HurryReading, hurryReading, stationTimetable } from './hurry-reading';
import { judgeTrip, tripMinuteWindow, type TripTimetable, tripTimetable, type TripVerdict, type TripVerdictInput, type TripVerdictSource } from './trip-verdict';

/**
 * Plan M7c.3: hurry-or-chill, live. Composes the real pieces —
 *   the schedule DB (its platforms and departures), the rider's position (useUserPosition, the app's ONE
 *   location watch, through expo-location), the station's live predictions (the live runtime, m4b),
 *   Jamie's walk and jog paces (m8b's readWalkingPace, Data & Settings) and the clock —
 * into a verdict, recomputed on every tick and every new fix or batch. mfix9: each walks to its platform by
 * useWalkTo (src/ui/walk) — the street-routed walk when the app's RoutedWalkProvider knows one, else the straight line
 * with m7c's detour: the sheet registers its station's platforms while the rider is in range, and the Now bar hands in
 * the walk to its near trip's origin (src/ui/now/near-trip-walk.ts). Two readers:
 *
 *   useStationHurryVerdict  the station sheet: its station's HurryReading (hurry-reading.ts), one verdict per
 *                           direction, recomputed every HURRY_TICK_MS
 *   useNearTripVerdict      the Now bar (mfix8): the saved trip the rider is near (homeContext.ts 'nearTrip'),
 *                           judged over that trip's own rides (trip-verdict.ts) at the home context's instant
 *
 * SCHEDULE READS ONCE A MINUTE: each reader reads the schedule DB once per minute — the sheet its station's
 * timetable (stationTimetable), the bar its near trip's rides and their boarding departures (tripTimetable over
 * tripMinuteWindow) — while the live batch, the position and the instant move the verdict on every tick.
 *
 * REALTIME COST RULE: each reader watches ONE station's predictions — the sheet its station, the bar its near
 * trip's origin, and the bar nothing at all without a near trip. Watches are counted per station
 * (use-station-predictions.ts), so a sheet and the bar on the same station poll once.
 *
 * mfix7 (Jamie's 07:10 recording: the Brickell City Centre sheet opened on "Missed · next 7:18 · not worth
 * it", Scheduled, and flipped ~1 s later to the live "Not worth it · next in 7 min"): the STATION SHEET holds a
 * verdict back as 'checking' while a live provider serves predictions and the station's first batch has not
 * arrived — for at most LIVE_CHECK_TIMEOUT_MS from when the sheet started watching. The batch brings the live
 * verdict; the timeout, no key or a failing provider the timetable's.
 */

export const HURRY_TICK_MS = 15_000;

/** How long the station sheet waits for its station's first live predictions before it shows the timetable's verdict. */
export const LIVE_CHECK_TIMEOUT_MS = 3_000;

/** The station sheet's reading: a HurryReading, or 'checking' while its first live predictions are on their way. */
export type SheetReading = HurryReading | { readonly kind: 'checking'; readonly stationKey: string };

const NO_PLATFORMS: readonly Platform[] = Object.freeze([]);

/** `stationKey`'s hurry or chill, live, watching that station's predictions (the station sheet's, before its live check). */
function useHurryVerdict(stationKey: string, clock: () => number = wallClockNowS): HurryReading {
  invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  const db = useScheduleDb();
  const position = useUserPosition();
  const { state, runtime } = useLive();
  const nowS = useNowS(HURRY_TICK_MS, clock);
  const minuteS = nowS - (nowS % 60);
  const repo = db.kind === 'ready' ? db.repo : null;
  useEffect(() => (runtime === null ? undefined : watchStation(runtime, stationKey)), [runtime, stationKey]);
  const timetable = useMemo(() => (repo === null ? null : stationTimetable(repo, stationKey, minuteS)), [repo, stationKey, minuteS]);
  const platforms = useMemo(() => (repo === null ? NO_PLATFORMS : repo.platforms().filter((platform) => platform.stationKey === stationKey)), [repo, stationKey]);
  const rider = position.coordinate;
  // The sheet registers its platforms with the RoutedWalkProvider only while the rider is within HURRY_RANGE_M of one:
  // the reading judges nothing farther, so a sheet opened for a station across town costs Transitous no request.
  const walk = useWalkTo(rider !== null && platforms.some((platform) => haversineMeters(rider, platform) <= HURRY_RANGE_M) ? platforms : NO_PLATFORMS);
  const batch = state?.predictions.get(stationKey) ?? null;
  const { walkMps, jogMps } = readWalkingPace();
  const reading = useMemo(() => hurryReading({ db, position, timetable, batch, nowS, pace: { walkMps, jogMps }, walk }), [db, position, timetable, batch, nowS, walkMps, jogMps, walk]);
  invariant(reading.kind !== 'boards' || reading.stationKey === stationKey, 'the reading is about the station asked for');
  return reading;
}

/**
 * The Now bar's verdict (mfix8): hurry or chill for the near saved trip the home context chose, over that
 * trip's own rides, walked from the rider — live, with its ORIGIN's predictions watched while it is the trip
 * judged. Null whenever the context is not 'nearTrip'. The trip's rides are read once a minute (useTripTimetable);
 * the verdict is judged at the context's instant with the latest batch and position, on every home tick. It reads
 * the same schedule, position and instant the context was worked out from, so a near trip the schedule can judge
 * always comes with its verdict. `walk` is the bar's useWalkTo over the trip's origin platforms (mfix9,
 * useNearTripWalk); without it, the straight line with m7c's detour. mfix11: the verdict walks the trip's ONE walk
 * (savedTripWalk, given the trip) — its own minutes when it has them — the walk its card shows.
 */
export function useNearTripVerdict(context: HomeContext, walk?: WalkTo): TripVerdict | null {
  const db = useScheduleDb();
  const position = useUserPosition();
  const { state, runtime } = useLive();
  const near = context.kind === 'nearTrip' ? context : null;
  const from = near === null ? null : near.card.trip.fromStationKey;
  useEffect(() => (runtime === null || from === null ? undefined : watchStation(runtime, from)), [runtime, from]);
  const batch = from === null ? null : (state?.predictions.get(from) ?? null);
  const { walkMps, jogMps } = readWalkingPace();
  const repo = db.kind === 'ready' ? db.repo : null;
  const timetable = useTripTimetable(repo, near);
  const coordinate = position.coordinate;
  const judged = useMemo(
    () => (near === null || timetable === null || coordinate === null ? null : judgeNearTrip(timetable, near, { position: coordinate, pace: { walkMps, jogMps }, batch, walk })),
    [near, timetable, coordinate, walkMps, jogMps, batch, walk],
  );
  invariant(judged === null || near !== null, 'a verdict is about the near trip');
  invariant(context.kind !== 'nearTrip' || repo === null || coordinate === null || judged !== null, 'a near trip the schedule can judge comes with its verdict');
  return judged;
}

type NearTrip = Extract<HomeContext, { readonly kind: 'nearTrip' }>;

/**
 * The near trip's schedule reads — its rides and their boarding departures — once per MINUTE, like the station
 * sheet's stationTimetable: over tripMinuteWindow, which holds the verdict window of every second of the minute,
 * so the 5 s home ticks in between judge without touching the schedule DB. Null without a near trip or a
 * schedule, or when the schedule cannot judge the trip.
 */
function useTripTimetable(repo: TripVerdictSource | null, near: NearTrip | null): TripTimetable | null {
  const from = near === null ? null : near.card.trip.fromStationKey;
  const to = near === null ? null : near.card.trip.toStationKey;
  const minuteS = near === null ? null : near.nowS - (near.nowS % 60);
  invariant(minuteS === null || (Number.isSafeInteger(minuteS) && minuteS % 60 === 0), 'the trip is read on the minute');
  const timetable = useMemo(
    () => (repo === null || from === null || to === null || minuteS === null ? null : tripTimetable(repo, from, to, tripMinuteWindow(minuteS))),
    [repo, from, to, minuteS],
  );
  invariant(timetable === null || (timetable.from === from && timetable.to === to), 'the timetable is the near trip\'s');
  return timetable;
}

/** The near trip's verdict from the rider at the context's instant (trip-verdict.ts). */
function judgeNearTrip(timetable: TripTimetable, near: NearTrip, rider: Pick<TripVerdictInput, 'position' | 'pace' | 'batch' | 'walk'>): TripVerdict {
  const { fromStationKey, toStationKey } = near.card.trip;
  invariant(fromStationKey !== toStationKey, 'a saved trip joins two stations');
  const judged = judgeTrip(timetable, { from: fromStationKey, to: toStationKey, trip: near.card.trip, nowS: near.nowS, ...rider });
  invariant(judged.ctx.now === near.nowS, 'the trip is judged at the context\'s instant');
  return judged;
}

/** The station sheet's hurry or chill: its station's reading, held back as 'checking' while its first live batch is awaited. */
export function useStationHurryVerdict(stationKey: string, clock: () => number = wallClockNowS): SheetReading {
  const reading = useHurryVerdict(stationKey, clock);
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
 * running (the Now bar's, on its near trip's origin) and is used straight away.
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
