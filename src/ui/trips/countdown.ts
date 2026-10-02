import { invariant } from '@/lib/invariant';

/**
 * Plan M7.2 "Countdown states": what a trip's countdown shows, from the time left until its leave-by
 * (src/domain/trips/leave-by.ts). Pure — the CountdownHero (M7.8) and the Now strip render it.
 *
 *   more than 60 min left  → clock   ("Leave at 8:14": a minute count that large reads as noise)
 *   over 5 min, ≤ 60 min   → normal  ("Leave in 30 min")
 *   over 60 s, ≤ 5 min     → soon    ("Leave in 4 min", emphasised)
 *   0 s up to 60 s         → now     ("Leave now")
 *   past the leave-by      → missed  (shown through leave-by's 30 s grace, then the next ride takes over)
 */

export type CountdownState = 'clock' | 'normal' | 'soon' | 'now' | 'missed';

/** Beyond this much time left, show the clock time instead of a count. */
export const CLOCK_BEYOND_S = 60 * 60;
/** At or under this much time left, the countdown is "soon". */
export const SOON_WITHIN_S = 5 * 60;
/** At or under this much time left, it is time to go. */
export const NOW_WITHIN_S = 60;

/** The counting states, tightest first: a non-negative time left takes the first band it fits. */
const BANDS: readonly { readonly upToS: number; readonly state: CountdownState }[] = [
  { upToS: NOW_WITHIN_S, state: 'now' },
  { upToS: SOON_WITHIN_S, state: 'soon' },
  { upToS: CLOCK_BEYOND_S, state: 'normal' },
];

export type Countdown = {
  readonly state: CountdownState;
  /** Seconds from now until the leave-by; negative once it has passed. */
  readonly leftS: number;
  /** Whole minutes left, rounded up ("4 min" from 4:00 down to 3:01 left); 0 once it is time to go. */
  readonly minutesLeft: number;
};

/** The countdown to `leaveByEpoch` at `now` (both whole epoch seconds). */
export function countdown(leaveByEpoch: number, now: number): Countdown {
  invariant(Number.isSafeInteger(leaveByEpoch), `a leave-by is a whole epoch second, got ${leaveByEpoch}`);
  invariant(Number.isSafeInteger(now), `now is a whole epoch second, got ${now}`);
  const leftS = leaveByEpoch - now;
  const state = countdownState(leftS);
  const minutesLeft = state === 'now' || state === 'missed' ? 0 : Math.ceil(leftS / 60);
  invariant(minutesLeft >= 0, 'minutes left are never negative');
  return { state, leftS, minutesLeft };
}

/** The state for `leftS` seconds until the leave-by. */
export function countdownState(leftS: number): CountdownState {
  invariant(Number.isSafeInteger(leftS), `time left is whole seconds, got ${leftS}`);
  const band = leftS < 0 ? undefined : BANDS.find((b) => leftS <= b.upToS);
  const state: CountdownState = leftS < 0 ? 'missed' : (band?.state ?? 'clock');
  invariant((state === 'missed') === leftS < 0, 'missed means the leave-by has passed, and only that');
  return state;
}

