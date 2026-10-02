import { useEffect, useState } from 'react';

import { invariant } from '@/lib/invariant';

/**
 * The screens' clock: now as a whole epoch second, re-read every `periodMs` while the screen is
 * mounted, so minute counts ("4 min") move on their own. Kept apart from the live runtime's clock
 * (src/live/runtime.ts) on purpose: the Stations list must not import the live layer at all (R7).
 */

/** The wall clock, in whole epoch seconds. */
export function wallClockNowS(): number {
  const nowS = Math.floor(Date.now() / 1000);
  invariant(Number.isSafeInteger(nowS), 'the wall clock reads a whole second');
  invariant(nowS > 0, 'the wall clock is past the epoch');
  return nowS;
}

/** Now (whole epoch s), re-read every `periodMs`; `clock` is injected by tests. */
export function useNowS(periodMs: number, clock: () => number = wallClockNowS): number {
  invariant(Number.isSafeInteger(periodMs) && periodMs >= 1000, `a screen clock ticks at most once a second, got ${periodMs} ms`);
  const [nowS, setNowS] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNowS(clock()), periodMs);
    return () => clearInterval(timer);
  }, [clock, periodMs]);
  invariant(Number.isSafeInteger(nowS), 'now is a whole epoch second');
  return nowS;
}
