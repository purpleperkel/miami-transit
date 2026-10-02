import { useEffect } from 'react';

import type { LiveBatch, LivePrediction } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';
import type { LiveRuntime } from '@/live/runtime';

/**
 * The OPEN station sheet's live predictions (REALTIME COST RULE, R7): while a sheet is mounted its
 * station is watched — the runtime polls one predictions call per station per refresh (Transitland's
 * free key: 10,000 calls a month) — and the watch ends when the sheet closes. The other watchers follow
 * the same rule: hurry or chill (one station near the rider, useHurryVerdict.ts) and the route options
 * sheet (at most MAX_WATCHED_STATIONS boarding stations while it is open, src/ui/routes/use-route-plan.ts).
 * The Stations list watches nothing, so it costs no calls at all.
 *
 * Watches are counted per runtime and station: two sheets of the same station (or a sheet replaced
 * by the next one while the first is still animating away) never cancel each other's watch.
 */

const WATCHES = new WeakMap<LiveRuntime, Map<string, number>>();

/** The station's latest predictions batch while the calling sheet is open, or null before the first. */
export function useStationPredictions(stationKey: string): LiveBatch<LivePrediction> | null {
  invariant(stationKey.includes(':'), `a watched station is keyed mode:name, got "${stationKey}"`);
  const { state, runtime } = useLive();
  useEffect(() => (runtime === null ? undefined : watchStation(runtime, stationKey)), [runtime, stationKey]);
  const batch = state?.predictions.get(stationKey) ?? null;
  invariant(batch === null || Number.isFinite(batch.fetchedAt), 'a batch says when it arrived');
  return batch;
}

/** Adds one watch of `stationKey` on `runtime`; the returned function removes exactly that one. */
export function watchStation(runtime: LiveRuntime, stationKey: string): () => void {
  invariant(stationKey.includes(':'), `a watched station is keyed mode:name, got "${stationKey}"`);
  const counts = WATCHES.get(runtime) ?? new Map<string, number>();
  WATCHES.set(runtime, counts);
  counts.set(stationKey, (counts.get(stationKey) ?? 0) + 1);
  runtime.watchStations([...counts.keys()]);
  invariant((counts.get(stationKey) ?? 0) >= 1, 'the station is watched');
  let released = false;
  return () => {
    invariant(!released, 'a watch is released once');
    released = true;
    release(runtime, counts, stationKey);
  };
}

function release(runtime: LiveRuntime, counts: Map<string, number>, stationKey: string): void {
  const count = counts.get(stationKey) ?? 0;
  invariant(count >= 1, `${stationKey} has a watch to release`);
  if (count === 1) {
    counts.delete(stationKey);
  } else {
    counts.set(stationKey, count - 1);
  }
  runtime.watchStations([...counts.keys()]);
  invariant(!counts.has(stationKey) || (counts.get(stationKey) ?? 0) >= 1, 'a station still listed is still watched');
}
