import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { invariant } from '@/lib/invariant';
import { detach } from '@/live/detach';

import type { CountdownState } from './countdown';

/**
 * Plan M7.5 + §4: when a trip's countdown reaches "Leave now", the phone says so once — one haptic
 * (expo-haptics) and a VoiceOver announcement — per DEPARTURE. The departures already cued are
 * remembered module-wide (bounded), so a card re-rendering every tick, the Trips tab and the trip screen
 * showing the same ride, or a screen opened again, never cue it twice; the next ride, reaching "now"
 * later, is a new departure and cues again. A departure is keyed by its trip and its epoch.
 *
 * A haptic that fails to play is not swallowed: the card that asked for it says so.
 */

/** At most this many cued departures are remembered (the oldest is forgotten first). */
export const MAX_REMEMBERED_CUES = 64;

const CUED = new Set<string>();

/** The departure a countdown is about: one trip's one ride. */
export function departureKey(tripId: string, depEpoch: number): string {
  invariant(tripId.length > 0, 'a cue belongs to a trip');
  invariant(Number.isSafeInteger(depEpoch), `a departure is a whole epoch second, got ${depEpoch}`);
  return `${tripId}@${depEpoch}`;
}

/** True when the countdown for `key` says "now" and that departure has not been cued yet. */
export function shouldCue(state: CountdownState, key: string, cued: ReadonlySet<string> = CUED): boolean {
  invariant(key.length > 0, 'a cue is for a departure');
  invariant(cued.size <= MAX_REMEMBERED_CUES, 'the cue memory stays bounded');
  return state === 'now' && !cued.has(key);
}

/**
 * Cues "Leave now" for `key` if shouldCue says so: remembers the departure, plays one Success haptic and
 * asks VoiceOver to read `announcement`. True when it cued; a failed haptic is handed to `onFailure`.
 */
export function cueLeaveNow(state: CountdownState, key: string, announcement: string, onFailure: (message: string) => void, cued: Set<string> = CUED): boolean {
  invariant(announcement.length > 0, 'VoiceOver is told something');
  invariant(typeof onFailure === 'function', 'a failed cue is reported');
  if (!shouldCue(state, key, cued)) {
    return false;
  }
  cued.add(key);
  const oldest = cued.size > MAX_REMEMBERED_CUES ? cued.values().next().value : undefined;
  if (oldest !== undefined) {
    cued.delete(oldest);
  }
  detach(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), (message) => onFailure(`The leave-now buzz did not play: ${message}`));
  AccessibilityInfo.announceForAccessibility(announcement);
  return true;
}

/** What a mounted countdown asks to be cued: its departure, its state now, and the sentence to announce. */
export type LeaveCue = { readonly key: string; readonly state: CountdownState; readonly announcement: string };

type CueProblem = { readonly key: string; readonly message: string };

/** Cues the departure once (module-wide) when it reaches "now"; returns why its haptic failed, or null. */
export function useLeaveNowCue(cue: LeaveCue | null): string | null {
  const [problem, setProblem] = useState<CueProblem | null>(null);
  const key = cue?.key ?? null;
  const state = cue?.state ?? null;
  const announcement = cue?.announcement ?? '';
  useEffect(() => (key === null || state === null ? undefined : startCue({ key, state, announcement }, setProblem)), [key, state, announcement]);
  invariant(problem === null || problem.message.length > 0, 'a cue problem says why');
  invariant(cue === null || cue.key.length > 0, 'a cue is for a departure');
  return problem !== null && problem.key === key ? problem.message : null;
}

/** Cues for a mounted card; a failure reaches the card only while it is still mounted. Returns the teardown. */
function startCue(cue: LeaveCue, report: (problem: CueProblem) => void): () => void {
  invariant(typeof report === 'function', 'a cue reports its failure to the card');
  const life = { mounted: true };
  cueLeaveNow(cue.state, cue.key, cue.announcement, (message) => (life.mounted ? report({ key: cue.key, message }) : undefined));
  invariant(life.mounted, 'the cue starts while the card is mounted');
  return () => {
    life.mounted = false;
  };
}
