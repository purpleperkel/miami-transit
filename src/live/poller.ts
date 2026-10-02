import { type ChainResolution, type ChainState, initialChainState, recordPoll, resolveChain, type Standings } from '../domain/live/chain';
import { PROVIDER_CONFIG } from '../domain/live/constants';
import { dueTasks, finishPoll, type PollOutcome, type PollTask, resumeAll, type SchedulerState, startPoll, syncTasks } from '../domain/live/scheduler';
import type { Capability, ChainProviderId, LiveBatch, LiveError, LivePrediction, LiveProvider, LiveResult, LiveVehicle, ProviderId } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { detach } from './detach';

/**
 * Plan M4.9 / §4 Polling: the live runtime's engine — plain TypeScript, no React, so it runs under a
 * test clock. The 1 s heartbeat (use-live-polling.ts, only while the app is active) calls `tick()`:
 *
 *  - Each capability resolves its own provider chain (m4a chain.ts, arbiter note 3): vehicles and
 *    predictions may be served by different providers. The serving provider is polled for the
 *    capability if it offers it — and `none`, the chain end (providers/none.ts), offers nothing: its
 *    tasks simply stay due, and poll the moment a provider becomes available (a key pasted).
 *  - Tasks: one `vehicles` task, and one `predictions:<stationKey>` task per WATCHED station (the
 *    stations on screen and saved-trip origins, set by the UI). A newly watched station is due at
 *    once. Each task polls at its provider's cadence, never overlapping, backing off on failure
 *    (m4a scheduler.ts; a 429 doubles the interval).
 *  - Every finished poll is recorded in the chain (3 failures in a row → failing / failover) and
 *    published as a new immutable snapshot through `onChange` — except a poll whose provider stands
 *    key-less when it ends (mfix10: Swiftly gated off Wi-Fi meanwhile), which the chain never records.
 *  - When a capability's serving provider CHANGES (failover, a re-probe of the primary after 300 s,
 *    a better provider's key pasted), each idle task of it is due at once: the new provider owes
 *    nothing to the old one's backoff or cadence, so a failover never waits out a dead provider.
 *
 * A failed poll keeps the previous batch: stale data ages visibly (its fetchedAt) instead of
 * vanishing. A poll that fails by a bug still ends (as a failure, so its task backs off rather than
 * wedging in flight) and the bug goes to `onBug`. Polls in flight when the app goes to the
 * background finish normally (each is bounded by its 8 s abort); `dispose()` aborts them and
 * nothing after that is recorded.
 *
 * TIME: the scheduler and the chain need an instant that never runs backwards, so the wall clock is
 * read through a MonotonicClock: a backwards step (a clock correction) is absorbed, a forward step
 * just makes everything due.
 */

export type CapabilityStatus = {
  /** Who serves the capability now: a provider, or `none` (the schedule alone). */
  readonly provider: ChainProviderId;
  /** The serving provider failed 3+ times in a row: its data is stale and never shown as fresh. */
  readonly failing: boolean;
  readonly consecutiveFailures: number;
  /** The latest finished poll's error for this capability; null once one succeeds (or before any). */
  readonly lastError: LiveError | null;
};

export type LiveSnapshot = {
  readonly vehicles: LiveBatch<LiveVehicle> | null;
  /** The latest predictions batch of each watched station that has had one. */
  readonly predictions: ReadonlyMap<string, LiveBatch<LivePrediction>>;
  readonly status: Readonly<Record<Capability, CapabilityStatus>>;
};

export type PollerDeps = {
  /** Every chain member, the chain end `none` included. */
  readonly providers: Readonly<Record<ChainProviderId, LiveProvider>>;
  /** Every provider's standing now: key present, capabilities, calls this month. */
  readonly standings: () => Standings;
  /** The wall clock in epoch seconds (read through a MonotonicClock). */
  readonly nowS: () => number;
  /** Called with each new snapshot. */
  readonly onChange: (snapshot: LiveSnapshot) => void;
  /** Called when a poll fails by a BUG (a broken invariant), not by a provider (detach.ts). */
  readonly onBug: (message: string) => void;
};

const VEHICLES_TASK = 'vehicles';
const STATION_TASK_PREFIX = 'predictions:';
const IDLE_STATUS: CapabilityStatus = Object.freeze({ provider: 'none', failing: false, consecutiveFailures: 0, lastError: null });

export const EMPTY_SNAPSHOT: LiveSnapshot = Object.freeze({
  vehicles: null,
  predictions: new Map<string, LiveBatch<LivePrediction>>(),
  status: Object.freeze({ vehicles: IDLE_STATUS, predictions: IDLE_STATUS }),
});

/** Seconds from a wall clock that never run backwards: a backwards step is absorbed into an offset. */
export class MonotonicClock {
  private offset = 0;
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly source: () => number) {
    invariant(typeof source === 'function', 'the clock reads a time source');
    invariant(this.offset === 0, 'the clock starts on its source');
  }

  now(): number {
    const raw = this.source() + this.offset;
    invariant(Number.isFinite(raw), 'the time source reads a finite instant');
    if (raw < this.last) {
      this.offset += this.last - raw;
    }
    const now = Math.max(raw, this.last);
    invariant(now >= this.last, 'the clock never runs backwards');
    this.last = now;
    return now;
  }
}

export class LivePoller {
  private chain: ChainState = initialChainState();
  private scheduler: SchedulerState = new Map();
  private stations: readonly string[] = [];
  private current: LiveSnapshot = EMPTY_SNAPSHOT;
  private readonly lastError: Record<Capability, LiveError | null> = { vehicles: null, predictions: null };
  /** The provider each task last polled. */
  private readonly servedBy = new Map<string, ProviderId>();
  private readonly clock: MonotonicClock;
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(private readonly deps: PollerDeps) {
    invariant(typeof deps.onChange === 'function', 'the poller publishes its snapshots');
    invariant((['swiftly', 'transitland', 'none'] as const).every((id) => deps.providers[id].id === id), 'each chain member is in its own slot');
    this.clock = new MonotonicClock(deps.nowS);
  }

  /** The latest snapshot. */
  get snapshot(): LiveSnapshot {
    invariant(this.current.status.vehicles !== undefined, 'the snapshot has a vehicles status');
    invariant(this.current.status.predictions !== undefined, 'the snapshot has a predictions status');
    return this.current;
  }

  /** The heartbeat: re-resolve both chains, then start every due poll whose capability has a provider. */
  tick(): void {
    invariant(!this.disposed, 'a disposed poller does not tick');
    const nowS = this.clock.now();
    const resolutions = this.resolve(nowS);
    this.syncTasks(this.tasks(resolutions), resolutions, nowS);
    this.publishStatus(resolutions, false);
    for (const id of dueTasks(this.scheduler, nowS)) {
      const capability = capabilityOf(id);
      const serving = this.deps.providers[resolutions[capability].provider];
      if (serving.capabilities[capability]) {
        invariant(serving.id !== 'none', 'the chain end offers nothing, so it is never polled');
        this.scheduler = startPoll(this.scheduler, id, nowS);
        this.servedBy.set(id, serving.id);
        detach(this.poll(id, capability, serving.id), this.deps.onBug);
      }
    }
    invariant(dueTasks(this.scheduler, nowS).every((id) => resolutions[capabilityOf(id)].provider === 'none'), 'only tasks without a provider stay due');
  }

  /** Back from the background: every task is due again (never sooner than one cadence after its last start), then a tick. */
  resume(): void {
    invariant(!this.disposed, 'a disposed poller does not resume');
    const nowS = this.clock.now();
    this.scheduler = resumeAll(this.scheduler, nowS);
    invariant([...this.scheduler.values()].every((task) => task.inFlight || task.dueAt <= nowS + task.cadenceS), 'every idle task is due within one cadence');
    this.tick();
  }

  /**
   * The stations whose predictions are polled (on screen, saved-trip origins), in the caller's order.
   * Unwatched stations' batches are dropped. A disposed poller watches nothing, so a late call is a no-op.
   */
  watchStations(stationKeys: readonly string[]): void {
    invariant(stationKeys.every((key) => key.includes(':')), 'stations are watched by station key (mode:name)');
    invariant(new Set(stationKeys).size === stationKeys.length, 'each station is watched once');
    const unchanged = stationKeys.length === this.stations.length && stationKeys.every((key, i) => key === this.stations[i]);
    if (this.disposed || unchanged) {
      return;
    }
    this.stations = [...stationKeys];
    const predictions = new Map([...this.current.predictions].filter(([key]) => stationKeys.includes(key)));
    this.publish({ ...this.current, predictions });
  }

  /**
   * A provider's key (or Swiftly's agency key) changed: its failure record is forgotten in both
   * chains, and every idle task is due again (never sooner than one cadence after its last start),
   * so a corrected key is tried at the next heartbeat instead of after a backoff or a 300 s bench.
   */
  credentialsChanged(provider: ProviderId): void {
    invariant(!this.disposed, 'a disposed poller has no credentials');
    const clean = initialChainState();
    this.chain = Object.freeze({
      vehicles: Object.freeze({ ...this.chain.vehicles, [provider]: clean.vehicles[provider] }),
      predictions: Object.freeze({ ...this.chain.predictions, [provider]: clean.predictions[provider] }),
    });
    this.scheduler = resumeAll(this.scheduler, this.clock.now());
    invariant(this.chain.vehicles[provider].consecutive === 0 && this.chain.predictions[provider].consecutive === 0, `${provider} starts clean`);
  }

  /** Aborts every poll in flight; nothing is recorded or published afterwards. */
  dispose(): void {
    invariant(!this.disposed, 'a poller is disposed once');
    this.disposed = true;
    this.abort.abort();
    invariant(this.abort.signal.aborted, 'polls in flight see the abort');
  }

  private resolve(nowS: number, standings: Standings = this.deps.standings()): Readonly<Record<Capability, ChainResolution>> {
    const resolutions = { vehicles: resolveChain(this.chain, 'vehicles', standings, nowS), predictions: resolveChain(this.chain, 'predictions', standings, nowS) };
    invariant(resolutions.vehicles.provider === 'none' || standings[resolutions.vehicles.provider].hasKey, 'a keyed provider serves vehicles');
    invariant(resolutions.predictions.provider === 'none' || standings[resolutions.predictions.provider].hasKey, 'a keyed provider serves predictions');
    return resolutions;
  }

  /** The scheduler's tasks: vehicles, plus one per watched station, each at its serving provider's cadence. */
  private tasks(resolutions: Readonly<Record<Capability, ChainResolution>>): PollTask[] {
    const tasks = [
      { id: VEHICLES_TASK, cadenceS: cadenceOf(resolutions.vehicles.provider) },
      ...this.stations.map((key) => ({ id: `${STATION_TASK_PREFIX}${key}`, cadenceS: cadenceOf(resolutions.predictions.provider) })),
    ];
    invariant(tasks.length === this.stations.length + 1, 'one task for vehicles, one per watched station');
    invariant(tasks.every((task) => task.cadenceS > 0), 'every task has a cadence');
    return tasks;
  }

  /**
   * The scheduler for `tasks`: kept tasks keep their state — except an idle task whose serving
   * provider changed since its last poll, which starts over, due now. Dropped tasks are forgotten.
   */
  private syncTasks(tasks: readonly PollTask[], resolutions: Readonly<Record<Capability, ChainResolution>>, nowS: number): void {
    const switched = tasks.filter((task) => {
      const last = this.servedBy.get(task.id);
      return this.scheduler.get(task.id)?.inFlight === false && last !== undefined && last !== resolutions[capabilityOf(task.id)].provider;
    });
    const kept = tasks.filter((task) => !switched.includes(task));
    this.scheduler = syncTasks(syncTasks(this.scheduler, kept, nowS), tasks, nowS);
    for (const id of [...this.servedBy.keys()].filter((id) => !kept.some((task) => task.id === id))) {
      this.servedBy.delete(id);
    }
    invariant(this.scheduler.size === tasks.length, 'every task is scheduled once');
    invariant(switched.every((task) => this.scheduler.get(task.id)?.dueAt === nowS), 'a task whose provider changed is due now');
  }

  private async poll(id: string, capability: Capability, provider: ProviderId): Promise<void> {
    invariant(this.scheduler.get(id)?.inFlight === true, `task ${id} was started`);
    invariant(capability === 'vehicles' || id.startsWith(STATION_TASK_PREFIX), 'a predictions task names its station');
    let outcome: PollOutcome = 'failed';
    try {
      outcome = capability === 'vehicles' ? await this.pollVehicles(provider) : await this.pollStation(provider, id.slice(STATION_TASK_PREFIX.length));
    } finally {
      this.finish(id, capability, provider, outcome);
    }
  }

  private async pollVehicles(provider: ProviderId): Promise<PollOutcome> {
    invariant(this.deps.providers[provider].capabilities.vehicles, `${provider} offers vehicles`);
    const result = await this.deps.providers[provider].fetchVehicles(this.abort.signal);
    if (!this.disposed) {
      this.lastError.vehicles = result.ok ? null : result.error;
      this.current = { ...this.current, vehicles: result.ok ? result.value : this.current.vehicles };
    }
    invariant(!result.ok || result.value.provider === provider, 'the batch is the polled provider\'s');
    return outcomeOf(result);
  }

  private async pollStation(provider: ProviderId, stationKey: string): Promise<PollOutcome> {
    invariant(this.deps.providers[provider].capabilities.predictions, `${provider} offers predictions`);
    const result = await this.deps.providers[provider].fetchPredictions(stationKey, this.abort.signal);
    if (!this.disposed) {
      this.lastError.predictions = result.ok ? null : result.error;
      if (result.ok && this.stations.includes(stationKey)) {
        this.current = { ...this.current, predictions: new Map(this.current.predictions).set(stationKey, result.value) };
      }
    }
    invariant(!result.ok || result.value.provider === provider, 'the batch is the polled provider\'s');
    return outcomeOf(result);
  }

  /**
   * Records a finished poll in the scheduler and the chain, then publishes. Ignored after dispose().
   * A provider that stands key-less when its poll ends is recorded nowhere in the chain: no failure, no
   * success, so never benched (mfix10 fix round). That is Swiftly gated off Wi-Fi meanwhile — the poll
   * started while it was allowed, and leaving Wi-Fi may have cut the download — or a key removed
   * meanwhile. Its task still finishes in the scheduler, and the next tick hands it to whoever serves.
   */
  private finish(id: string, capability: Capability, provider: ProviderId, outcome: PollOutcome): void {
    if (this.disposed) {
      return;
    }
    const nowS = this.clock.now();
    const standings = this.deps.standings();
    this.scheduler = finishPoll(this.scheduler, id, outcome, nowS);
    if (standings[provider].hasKey) {
      this.chain = recordPoll(this.chain, capability, provider, outcome === 'ok' ? 'ok' : 'failed', nowS);
    }
    invariant(this.scheduler.get(id)?.inFlight !== true, `task ${id} is no longer in flight`);
    invariant(outcome !== 'ok' || !standings[provider].hasKey || this.chain[capability][provider].consecutive === 0, 'a recorded success clears the provider\'s failures');
    this.publishStatus(this.resolve(nowS, standings), true);
  }

  private publishStatus(resolutions: Readonly<Record<Capability, ChainResolution>>, always: boolean): void {
    const status = { vehicles: statusOf(resolutions.vehicles, this.lastError.vehicles), predictions: statusOf(resolutions.predictions, this.lastError.predictions) };
    const changed = !sameStatus(status.vehicles, this.current.status.vehicles) || !sameStatus(status.predictions, this.current.status.predictions);
    invariant(status.vehicles.provider === resolutions.vehicles.provider, 'the status names the serving provider');
    invariant(status.predictions.provider === resolutions.predictions.provider, 'the status names the serving provider');
    if (always || changed) {
      this.publish({ ...this.current, status });
    }
  }

  private publish(snapshot: LiveSnapshot): void {
    invariant(!this.disposed, 'a disposed poller publishes nothing');
    this.current = Object.freeze(snapshot);
    invariant(this.current === snapshot, 'the published snapshot is the current one');
    this.deps.onChange(this.current);
  }
}

/** The capability a task polls: `vehicles`, or `predictions:<stationKey>`. */
function capabilityOf(taskId: string): Capability {
  invariant(taskId === VEHICLES_TASK || taskId.startsWith(STATION_TASK_PREFIX), `"${taskId}" is a poll task`);
  const capability: Capability = taskId === VEHICLES_TASK ? 'vehicles' : 'predictions';
  invariant(capability === 'predictions' || taskId === VEHICLES_TASK, 'only the vehicles task polls vehicles');
  return capability;
}

/** The poll cadence for a capability's serving provider; `none` never polls, so any cadence will do. */
function cadenceOf(provider: ChainProviderId): number {
  const cadenceS = provider === 'none' ? PROVIDER_CONFIG.transitland.cadenceS : PROVIDER_CONFIG[provider].cadenceS;
  invariant(cadenceS > 0, 'a cadence is positive');
  invariant(provider === 'none' || cadenceS === PROVIDER_CONFIG[provider].cadenceS, 'a provider polls at its own cadence');
  return cadenceS;
}

/** How a poll ended, for the scheduler: a 429 is rate-limited (the interval doubles), any other error a failure. */
function outcomeOf<T>(result: LiveResult<T>): PollOutcome {
  invariant(typeof result.ok === 'boolean', 'a poll ends in a Result');
  const outcome: PollOutcome = result.ok ? 'ok' : result.error.kind === 'http' && result.error.status === 429 ? 'rate-limited' : 'failed';
  invariant(result.ok === (outcome === 'ok'), 'only a success is ok');
  return outcome;
}

function statusOf(resolution: ChainResolution, lastError: LiveError | null): CapabilityStatus {
  invariant(resolution.consecutiveFailures >= 0, 'a failure count is never negative');
  const status: CapabilityStatus = Object.freeze({ ...resolution, lastError });
  invariant(status.failing === resolution.failing, 'the status carries the chain\'s verdict');
  return status;
}

function sameStatus(a: CapabilityStatus, b: CapabilityStatus): boolean {
  invariant(a !== undefined && b !== undefined, 'two statuses are compared');
  const same = a.provider === b.provider && a.failing === b.failing && a.consecutiveFailures === b.consecutiveFailures && a.lastError === b.lastError;
  invariant(!same || a.provider === b.provider, 'equal statuses name the same provider');
  return same;
}
