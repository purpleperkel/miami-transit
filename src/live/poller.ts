import { type ChainResolution, type ChainState, initialChainState, recordPoll, resolveChain, type Standings } from '../domain/live/chain';
import { PROVIDER_CONFIG } from '../domain/live/constants';
import { dueTasks, finishPoll, type PollOutcome, type PollTask, releasePoll, restartTask, resumeAll, type SchedulerState, startPoll, syncTasks } from '../domain/live/scheduler';
import { type Capability, type ChainProviderId, type LiveBatch, type LiveError, type LivePrediction, type LiveProvider, type LiveVehicle, type ProviderId, ReusedRejection } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { ok, type Result } from '../lib/result';
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
 *    published as a new immutable snapshot through `onChange`.
 *  - mfix10 (fix rounds 2 and 3): how an ended poll counts (settle). A poll whose provider no longer
 *    stands keyed when it ends — a Swiftly gated off Wi-Fi meanwhile (the poll started while it was
 *    allowed, and leaving Wi-Fi may have cut the download) or a key removed meanwhile — leaves no
 *    trace: no lastError (so no 'offline' flash), nothing in the chain, and its task is released with
 *    its failures and interval as they were (scheduler.ts releasePoll). A poll whose provider's key
 *    CHANGED meanwhile leaves no trace either, and its task starts over, due at once. Any other poll
 *    ends its task (a failure backs off, R-b), and is recorded in the chain only if its result is its
 *    own: a failure or a bug `reused` from a download another poll started (Swiftly's 30 s share) is
 *    recorded by that poll alone, so one failed download is one failure however many stations read
 *    it, while every station's task still backs off. A batch a poll brought back is always shown:
 *    fresh data the phone has already fetched.
 *  - HOLD (mfix10 fix round 2): the runtime holds the poller while it waits for a fresh network
 *    reading on resume. A held poller is not ticked, and a poll that ends meanwhile is settled when
 *    `resume()` lifts the hold, on the standings then — so nothing moves until the reading is in.
 *  - When a capability's serving provider CHANGES (failover, a re-probe of the primary after 300 s,
 *    a better provider's key pasted), each idle task of it is due at once: the new provider owes
 *    nothing to the old one's backoff or cadence, so a failover never waits out a dead provider. The
 *    same holds when the serving provider's KEY changes (credentialsChanged): a new key is a new
 *    request, tried at the next heartbeat.
 *
 * A failed poll keeps the previous batch: stale data ages visibly (its fetchedAt) instead of
 * vanishing. A poll that fails by a bug still ends (as a failure, so its task backs off rather than
 * wedging in flight) and the bug goes to `onBug`. Polls in flight when the app goes to the
 * background finish normally (each is bounded by its 8 s abort); `dispose()` aborts them and
 * nothing after that is recorded.
 *
 * TIME: the scheduler and the chain need an instant that never runs backwards, so the wall clock is
 * read through a MonotonicClock: a backwards step (a clock correction) is absorbed, a forward step
 * just makes everything due. (Swiftly's 30 s floor runs on its own millisecond clock, which ignores
 * wall-clock corrections: providers/swiftly.ts.)
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

/** A poll's Result: on success, the step that shows its batch (the vehicles, or its station's predictions). */
type Polled = Result<() => void, LiveError>;

/**
 * A poll that has ended: its task, what it polled from whom under which credentials era, its Result
 * (null: it broke by a bug), and whether that failure or bug was `reused` from another poll's download.
 */
type EndedPoll = {
  readonly id: string;
  readonly capability: Capability;
  readonly provider: ProviderId;
  readonly era: number;
  readonly polled: Polled | null;
  readonly reused: boolean;
};

/** Instants from a source (in its unit: seconds or milliseconds) that never run backwards: a backwards step is absorbed into an offset. */
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
  /** Each provider's credentials era, bumped by credentialsChanged: a poll started in an earlier era counts for nothing. */
  private readonly eras: Record<ProviderId, number> = { swiftly: 0, transitland: 0 };
  /** Held by the runtime until a resume's network reading is in: not ticked, and ended polls wait in `ended`. */
  private held = false;
  private readonly ended: EndedPoll[] = [];

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
    invariant(!this.held, 'a held poller does not tick: nothing starts until the hold lifts');
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

  /**
   * Holds the poller (the runtime waits for a fresh network reading on resume): it is not ticked, and a
   * poll that ends meanwhile waits to be settled until `resume()`. Holding a held poller keeps it held.
   */
  hold(): void {
    invariant(!this.disposed, 'a disposed poller is not held');
    invariant(this.held || this.ended.length === 0, 'ended polls wait only while the poller is held');
    this.held = true;
  }

  /**
   * Back from the background (lifting a hold, if any): the polls that ended while held are settled on
   * the standings now, every task is due again (never sooner than one cadence after its last start),
   * then a tick.
   */
  resume(): void {
    invariant(!this.disposed, 'a disposed poller does not resume');
    this.held = false;
    for (const ended of this.ended.splice(0)) {
      this.settle(ended);
    }
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
   * chains, a new credentials era begins (a poll still in flight under the old one counts for nothing
   * when it ends, and its task then starts over), and each idle task the provider served starts over,
   * due at once (scheduler.ts restartTask). So a corrected key is tried at the next heartbeat, instead
   * of after a backoff, a cadence or a 300 s bench: a new key is a new request.
   */
  credentialsChanged(provider: ProviderId): void {
    invariant(!this.disposed, 'a disposed poller has no credentials');
    const clean = initialChainState();
    this.chain = Object.freeze({
      vehicles: Object.freeze({ ...this.chain.vehicles, [provider]: clean.vehicles[provider] }),
      predictions: Object.freeze({ ...this.chain.predictions, [provider]: clean.predictions[provider] }),
    });
    this.eras[provider] += 1;
    const nowS = this.clock.now();
    for (const [id, servedBy] of this.servedBy) {
      this.scheduler = servedBy === provider ? restartTask(this.scheduler, id, nowS) : this.scheduler;
    }
    invariant(this.chain.vehicles[provider].consecutive === 0 && this.chain.predictions[provider].consecutive === 0, `${provider} starts clean`);
  }

  /** Aborts every poll in flight; nothing is recorded or published afterwards. */
  dispose(): void {
    invariant(!this.disposed, 'a poller is disposed once');
    this.disposed = true;
    this.ended.splice(0); // nothing is settled after dispose()
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
    const era = this.eras[provider];
    let polled: Polled | null = null;
    let reusedBug = false;
    try {
      polled = capability === 'vehicles' ? await this.pollVehicles(provider) : await this.pollStation(provider, id.slice(STATION_TASK_PREFIX.length));
    } catch (error) {
      reusedBug = error instanceof ReusedRejection;
      throw error; // a bug, reused or not: detach.ts hands it to onBug
    } finally {
      this.end({ id, capability, provider, era, polled, reused: polled === null ? reusedBug : !polled.ok && polled.error.reused === true });
    }
  }

  private async pollVehicles(provider: ProviderId): Promise<Polled> {
    invariant(this.deps.providers[provider].capabilities.vehicles, `${provider} offers vehicles`);
    const result = await this.deps.providers[provider].fetchVehicles(this.abort.signal);
    invariant(!result.ok || result.value.provider === provider, 'the batch is the polled provider\'s');
    if (!result.ok) {
      return result;
    }
    const batch = result.value;
    return ok(() => {
      this.current = { ...this.current, vehicles: batch };
    });
  }

  private async pollStation(provider: ProviderId, stationKey: string): Promise<Polled> {
    invariant(this.deps.providers[provider].capabilities.predictions, `${provider} offers predictions`);
    const result = await this.deps.providers[provider].fetchPredictions(stationKey, this.abort.signal);
    invariant(!result.ok || result.value.provider === provider, 'the batch is the polled provider\'s');
    if (!result.ok) {
      return result;
    }
    const batch = result.value; // shown only while its station is still watched
    return ok(() => {
      this.current = this.stations.includes(stationKey) ? { ...this.current, predictions: new Map(this.current.predictions).set(stationKey, batch) } : this.current;
    });
  }

  /** A poll ended: it is settled now, or when the hold lifts if the poller is held. Ignored after dispose(). */
  private end(ended: EndedPoll): void {
    if (this.disposed) {
      return;
    }
    invariant(this.scheduler.get(ended.id)?.inFlight !== false, `task ${ended.id} ends once, from flight (or was dropped meanwhile)`);
    if (this.held) {
      this.ended.push(ended);
    } else {
      this.settle(ended);
    }
    invariant(this.held || this.ended.length === 0, 'ended polls wait only while the poller is held');
  }

  /**
   * Settles an ended poll in the scheduler and the chain, then publishes. A batch it brought back is
   * shown however it counts.
   *  - Its provider's key CHANGED since it started (a new era): it leaves no trace, and its task
   *    starts over, due at once — the new key owes nothing to the old key's answer.
   *  - Its provider no longer stands keyed (gated off Wi-Fi, or its key removed): it leaves no trace —
   *    no lastError, nothing in the chain, its task released with its failures and interval as they were.
   *  - Otherwise it is recorded (record()).
   */
  private settle(ended: EndedPoll): void {
    const nowS = this.clock.now();
    const standings = this.deps.standings();
    const { id, provider, polled } = ended;
    invariant(ended.era <= this.eras[provider], 'a poll ends in the credentials era it started in, or a later one');
    if (polled?.ok === true) {
      polled.value();
    }
    if (ended.era !== this.eras[provider]) {
      this.scheduler = restartTask(releasePoll(this.scheduler, id, nowS), id, nowS);
    } else if (!standings[provider].hasKey) {
      this.scheduler = releasePoll(this.scheduler, id, nowS);
    } else {
      this.record(ended, nowS);
    }
    invariant(this.scheduler.get(id)?.inFlight !== true, `task ${id} is no longer in flight`);
    this.publishStatus(this.resolve(nowS, standings), true);
  }

  /**
   * A poll that counts (mfix10 fix round 3, R3): its task ENDS, so a failure backs it off on R-b's
   * schedule whether it started the download or reused it; but only its OWN result goes into the
   * chain (failover, bench) and lastError — a failure or bug `reused` from a download another poll
   * started was recorded by that poll.
   */
  private record({ id, capability, provider, polled, reused }: EndedPoll, nowS: number): void {
    const outcome = polled === null ? 'failed' : outcomeOf(polled);
    invariant(!reused || outcome !== 'ok', 'only a failure or a bug is handed out reused');
    this.scheduler = finishPoll(this.scheduler, id, outcome, nowS);
    if (!reused) {
      this.chain = recordPoll(this.chain, capability, provider, outcome === 'ok' ? 'ok' : 'failed', nowS);
      this.lastError[capability] = polled === null ? this.lastError[capability] : polled.ok ? null : polled.error; // a bug leaves the last provider error as it was
    }
    invariant(reused || outcome !== 'ok' || this.chain[capability][provider].consecutive === 0, 'a recorded success clears the provider\'s failures');
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
function outcomeOf(result: Result<unknown, LiveError>): PollOutcome {
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
