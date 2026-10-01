import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import { useScheduleDb } from '../data/schedule-db-provider';
import type { ScheduleRepo } from '../data/schedule-repo';
import { invariant } from '../lib/invariant';
import { LiveRuntime, type LiveState } from './runtime';
import { useLivePolling } from './use-live-polling';

/**
 * Plan M4.9: the live data, provided to the whole app (mounted once, in the root layout, inside the
 * schedule DB provider). Once the bundled schedule DB is open, one LiveRuntime runs over its network;
 * useLivePolling starts it and gates its heartbeat on AppState.
 *
 * `useLive()` gives:
 *   state    the latest LiveState — vehicles, predictions per watched station, per-capability chain
 *            status, bytes, quota, which keys exist — or null until the runtime first publishes;
 *   runtime  the runtime, for watchStations(...) and the Data & Settings key actions, or null while
 *            the schedule DB is still opening (or failed).
 */

export type LiveContextValue = {
  readonly state: LiveState | null;
  readonly runtime: LiveRuntime | null;
};

/** A state together with the runtime that published it, so a replaced runtime's last state is never shown. */
type Published = { readonly runtime: LiveRuntime; readonly state: LiveState };

const NO_LIVE: LiveContextValue = Object.freeze({ state: null, runtime: null });
const LiveContext = createContext<LiveContextValue>(NO_LIVE);

/** The live runtime and its latest state. */
export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  invariant(value.state === null || value.runtime !== null, 'a published state belongs to a runtime');
  invariant(value.state === null || value.state.status !== undefined, 'a state carries its chain status');
  return value;
}

/** Runs the live runtime over the open schedule DB for everything inside it. */
export function LiveDataProvider({ children }: { readonly children: ReactNode }) {
  const schedule = useScheduleDb();
  const repo = schedule.kind === 'ready' ? schedule.repo : null;
  const [published, setPublished] = useState<Published | null>(null);
  // Constructing a runtime has no side effects (useLivePolling starts and stops it), so it is derived from the open DB.
  const runtime = useMemo(() => (repo === null ? null : createRuntime(repo, setPublished)), [repo]);
  useLivePolling(runtime);
  const state = published !== null && published.runtime === runtime ? published.state : null;
  const value = useMemo<LiveContextValue>(() => (runtime === null ? NO_LIVE : { state, runtime }), [runtime, state]);
  invariant(value.runtime === runtime, 'the context offers the current runtime');
  invariant(value.state === null || value.runtime !== null, 'a state is offered only with its runtime');
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** A (stopped) runtime over the schedule's network that publishes each state tagged with itself. */
function createRuntime(repo: ScheduleRepo, publish: (published: Published) => void): LiveRuntime {
  invariant(typeof publish === 'function', 'the runtime publishes to the provider');
  const runtime: LiveRuntime = new LiveRuntime({ network: repo.liveNetwork(), onChange: (state) => publish({ runtime, state }) });
  invariant(!runtime.isStarted(), 'a new runtime waits for useLivePolling to start it');
  return runtime;
}
