import { useEffect, useMemo } from 'react';

import { useScheduleDb } from '@/data/schedule-db-provider';
import { useUserDb } from '@/data/user-db-provider';
import { invariant } from '@/lib/invariant';

import { useNowS } from '../clock';
import { useUserPosition } from '../map/use-user-location';
import { readWalkingPace } from '../settings/walking-pace';
import { tripCards } from '../trips/trip-card';
import { type HomeContext, homeContext } from './homeContext';
import { NOW_STORE, type NowStore, useNowState } from './nowStore';

/**
 * The home context, live (M7.7): the saved trips' cards (user DB + schedule, Jamie's pace, the platform
 * buffer), whether each mode runs, the rider's position and the Now store, re-read every tick. The Now
 * strip calls it (it is mounted under every tab) and publishes the result to the Now store, where the Map
 * tab reads `autoPresent` (useAutoPresent.ts) — so the context is worked out once, in one place.
 */

/** The strip's countdowns and the context move with this tick. */
export const HOME_TICK_MS = 5_000;

export function useHomeContext(clock: () => number, store: NowStore = NOW_STORE): HomeContext {
  const user = useUserDb();
  const db = useScheduleDb();
  const position = useUserPosition();
  const { lastGestureS, presentedKey } = useNowState(store);
  const nowS = useNowS(HOME_TICK_MS, clock);
  const repo = db.kind === 'ready' ? db.repo : null;
  const minuteS = nowS - (nowS % 60);
  const modes = useMemo(() => {
    const outcome = repo === null ? null : repo.modeStatusAt(minuteS);
    return outcome === null || outcome.kind !== 'mode-status' ? null : { rail: outcome.rail, mover: outcome.mover };
  }, [repo, minuteS]);
  const trips = user.kind === 'ready' ? user.trips : null;
  const bufferS = user.kind === 'ready' ? user.settings.boardBufferS : 0;
  const cards = useMemo(() => (repo === null || trips === null ? [] : tripCards(repo, trips, { nowS, walkMps: readWalkingPace().walkMps, bufferS, position: position.coordinate })), [repo, trips, nowS, bufferS, position.coordinate]);
  const context = useMemo(
    () => homeContext({ nowS, position: position.coordinate, stations: repo === null ? [] : repo.stations(), modes, cards, now: { lastGestureS, presentedKey } }),
    [nowS, position.coordinate, repo, modes, cards, lastGestureS, presentedKey],
  );
  useEffect(() => store.publish(context), [store, context]);
  invariant(typeof context.kind === 'string', 'the home context is known');
  invariant(cards.length === (trips?.length ?? 0) || repo === null, 'one card per saved trip once the schedule is open');
  return context;
}
