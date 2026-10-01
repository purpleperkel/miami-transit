import Storage from 'expo-sqlite/kv-store';

import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';

/**
 * Plan M8b.1 "Walking pace" / M7c: Jamie's walking and jogging speeds, the two paces the
 * hurry-or-chill verdict weighs against a departure. They are user settings, kept in
 * expo-sqlite/kv-store — bundled in Expo Go and read SYNCHRONOUSLY, so the verdict needs no user.db
 * (arbiter ruling 2026-10-01: m7c reads readWalkingPace() from here, the same reasoning as the quota
 * store, ruling R-a).
 *
 * Both paces live under ONE key, written in one setItemSync, so a stored pair is always a pair that
 * passed the checks below — a jog faster than the walk, both inside PACE_RANGE_MPS. Nothing stored
 * means the defaults (plan M7c.1: walk 1.35 m/s, jog 2.7 m/s). A stored value this module cannot
 * read (only a future format could write one) is not used: the defaults apply, and Data & Settings
 * shows the paces in effect, so the fallback is visible.
 */

export type WalkingPace = { readonly walkMps: number; readonly jogMps: number };
export type PaceError = { readonly kind: 'invalid-pace' | 'storage'; readonly message: string };

/** The part of expo-sqlite/kv-store the paces use (tests may pass an in-memory one). */
export type PaceStore = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

export const DEFAULT_WALK_MPS = 1.35;
export const DEFAULT_JOG_MPS = 2.7;
export const DEFAULT_WALKING_PACE: WalkingPace = Object.freeze({ walkMps: DEFAULT_WALK_MPS, jogMps: DEFAULT_JOG_MPS });

/** A pace outside this range is a typo, not a speed: 0.3 m/s is a shuffle, 8 m/s a sprint. */
export const PACE_RANGE_MPS = Object.freeze({ min: 0.3, max: 8 });

/** The kv-store key holding both paces, as `{"walkMps":1.35,"jogMps":2.7}`. */
export const WALKING_PACE_ITEM = 'settings.walking-pace';

/** Exactly what saveWalkingPace writes: JSON.stringify of a checked pair, plain decimals only. */
const STORED_PACE = /^\{"walkMps":(\d+(?:\.\d+)?),"jogMps":(\d+(?:\.\d+)?)\}$/;

/** `pace` if it is usable — finite, inside PACE_RANGE_MPS, and the jog strictly faster than the walk — else why not. */
export function checkWalkingPace(pace: WalkingPace): Result<WalkingPace, PaceError> {
  invariant(typeof pace === 'object' && pace !== null, 'a pace is a { walkMps, jogMps } pair');
  if (!inPaceRange(pace.walkMps) || !inPaceRange(pace.jogMps)) {
    return err({ kind: 'invalid-pace', message: `paces are between ${PACE_RANGE_MPS.min} and ${PACE_RANGE_MPS.max} m/s` });
  }
  if (pace.jogMps <= pace.walkMps) {
    return err({ kind: 'invalid-pace', message: 'the jog must be faster than the walk' });
  }
  invariant(pace.walkMps < pace.jogMps, 'a usable pace jogs faster than it walks');
  return ok(Object.freeze({ walkMps: pace.walkMps, jogMps: pace.jogMps }));
}

/** The paces in effect: the stored pair, or the defaults when none is stored (or the stored one is unreadable). */
export function readWalkingPace(store: PaceStore = Storage): WalkingPace {
  invariant(typeof store.getItemSync === 'function', 'the paces are read synchronously from the kv store');
  const match = STORED_PACE.exec(store.getItemSync(WALKING_PACE_ITEM) ?? '');
  const stored = match === null ? null : checkWalkingPace({ walkMps: Number(match[1]), jogMps: Number(match[2]) });
  const pace = stored !== null && stored.ok ? stored.value : DEFAULT_WALKING_PACE;
  invariant(checkWalkingPace(pace).ok, 'the paces in effect are always usable');
  return pace;
}

/** Stores `pace` if it is usable and returns it; refuses — storing nothing — when it is not (a jog no faster than the walk). */
export function saveWalkingPace(pace: WalkingPace, store: PaceStore = Storage): Result<WalkingPace, PaceError> {
  invariant(typeof store.setItemSync === 'function', 'the paces are written synchronously to the kv store');
  const checked = checkWalkingPace(pace);
  if (!checked.ok) {
    return checked;
  }
  const text = JSON.stringify({ walkMps: checked.value.walkMps, jogMps: checked.value.jogMps });
  invariant(STORED_PACE.test(text), `a checked pace is written in the stored format, got ${text}`);
  const written = writeItem(store, text);
  if (!written.ok) {
    return written;
  }
  const back = readWalkingPace(store);
  invariant(back.walkMps === checked.value.walkMps && back.jogMps === checked.value.jogMps, 'the saved paces read back');
  return ok(back);
}

/** A finite speed inside PACE_RANGE_MPS. */
function inPaceRange(mps: number): boolean {
  invariant(typeof mps === 'number', 'a pace is a number of metres per second');
  const inRange = Number.isFinite(mps) && mps >= PACE_RANGE_MPS.min && mps <= PACE_RANGE_MPS.max;
  invariant(!inRange || mps > 0, 'a pace in range moves');
  return inRange;
}

/** One kv-store write; a native failure becomes a `storage` PaceError. */
function writeItem(store: PaceStore, text: string): Result<null, PaceError> {
  invariant(text.length > 0, 'a pace pair is written as text');
  invariant(typeof store.setItemSync === 'function', 'the kv store writes synchronously');
  try {
    store.setItemSync(WALKING_PACE_ITEM, text);
    return ok(null);
  } catch (error) {
    return err({ kind: 'storage', message: `could not save the paces: ${error instanceof Error ? error.message : String(error)}` });
  }
}
