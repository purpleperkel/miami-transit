import type { Standings } from '../../domain/live/chain';
import type { LiveBatch, LiveError, LivePrediction, LiveProvider, LiveResult, LiveVehicle, ProviderId } from '../../domain/live/types';
import { err, ok } from '../../lib/result';
import { LivePoller, type LiveSnapshot, MonotonicClock } from '../poller';
import { NONE_PROVIDER } from '../providers/none';

/**
 * M4.9: the poller over scripted fake providers and a manual clock — the m4a scheduler and chain
 * driven for real: cadence, no overlap, backoff, the lone-provider rule, per-capability failover,
 * watched stations, stale batches, resume, dispose.
 */

const T0 = 1_790_872_200;
const NETWORK_DOWN: LiveError = { kind: 'network', message: 'offline' };
const RATE_LIMITED: LiveError = { kind: 'http', status: 429, message: 'HTTP 429' };

/** ok, a provider error, or 'reject' — a broken provider that rejects, which the LiveProvider contract forbids. */
type Answer = 'ok' | 'reject' | LiveError;

/**
 * A provider that answers each fetch — immediately, or when released if `hold` — with `script`'s
 * answer for what was asked ('vehicles' or a station key), else `next` (ok by default).
 */
class FakeProvider implements LiveProvider {
  readonly capabilities = { vehicles: true, predictions: true };
  readonly calls: { readonly what: string; readonly at: number; readonly signal: AbortSignal }[] = [];
  readonly script = new Map<string, Answer>();
  next: Answer = 'ok';
  hold = false;
  private readonly held: (() => void)[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly clock: () => number,
  ) {
    expect(this.calls).toEqual([]);
    expect(['swiftly', 'transitland']).toContain(id);
  }

  fetchVehicles(signal: AbortSignal): Promise<LiveResult<LiveVehicle>> {
    expect(signal).toBeDefined();
    expect(this.capabilities.vehicles).toBe(true);
    return this.answer<LiveVehicle>('vehicles', signal);
  }

  fetchPredictions(stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
    expect(stationKey).toContain(':');
    expect(this.capabilities.predictions).toBe(true);
    return this.answer<LivePrediction>(stationKey, signal);
  }

  /** Lets every held fetch answer. */
  release(): void {
    expect(this.held.length).toBeGreaterThan(0);
    this.held.splice(0).forEach((go) => go());
    expect(this.held).toEqual([]);
  }

  private answer<T>(what: string, signal: AbortSignal): Promise<LiveResult<T>> {
    this.calls.push({ what, at: this.clock(), signal });
    const answer = this.script.get(what) ?? this.next;
    expect(typeof answer === 'string' || answer.kind.length > 0).toBe(true);
    expect(this.calls.length).toBeGreaterThan(0);
    if (answer === 'reject') {
      return Promise.reject(new Error('fake provider bug'));
    }
    return this.hold ? new Promise((resolve) => this.held.push(() => resolve(this.result<T>(answer)))) : Promise.resolve(this.result<T>(answer));
  }

  private result<T>(answer: Exclude<Answer, 'reject'>): LiveResult<T> {
    const result: LiveResult<T> = answer === 'ok' ? ok(this.batch<T>()) : err(answer);
    expect(result.ok).toBe(answer === 'ok');
    expect(this.calls.length).toBeGreaterThan(0);
    return result;
  }

  private batch<T>(): LiveBatch<T> {
    const batch: LiveBatch<T> = { provider: this.id, items: [], feedTimestamp: null, dropped: {}, fetchedAt: this.clock(), bytes: 100 };
    expect(batch.provider).toBe(this.id);
    expect(batch.fetchedAt).toBeGreaterThanOrEqual(T0);
    return batch;
  }
}

/** A poller over two fake providers; `keys` decides who is keyed; `step(s)` ticks once per second up to T0 + s. */
class Harness {
  now = T0;
  private lastTick = T0 - 1;
  readonly keys: Record<ProviderId, boolean> = { swiftly: false, transitland: true };
  readonly snapshots: LiveSnapshot[] = [];
  readonly bugs: string[] = [];
  readonly swiftly = new FakeProvider('swiftly', () => this.now);
  readonly transitland = new FakeProvider('transitland', () => this.now);
  readonly poller: LivePoller;

  constructor() {
    this.poller = new LivePoller({
      providers: { swiftly: this.swiftly, transitland: this.transitland, none: NONE_PROVIDER },
      standings: () => this.standings(),
      nowS: () => this.now,
      onChange: (snapshot) => void this.snapshots.push(snapshot),
      onBug: (message) => void this.bugs.push(message),
    });
    expect(this.poller.snapshot.vehicles).toBeNull();
    expect(this.snapshots).toEqual([]);
  }

  /** The poller's current snapshot — the last one published, when any was. */
  get latest(): LiveSnapshot {
    const latest = this.poller.snapshot;
    expect(this.snapshots.length === 0 || this.snapshots[this.snapshots.length - 1] === latest).toBe(true);
    expect(latest.status).toBeDefined();
    return latest;
  }

  /** Ticks once a second, from the second after the last tick through T0 + `untilS`, letting each started poll finish. */
  async step(untilS: number): Promise<void> {
    expect(T0 + untilS).toBeGreaterThan(this.lastTick);
    for (let at = Math.max(this.lastTick + 1, this.now); at <= T0 + untilS; at += 1) {
      this.now = at;
      this.poller.tick();
      this.lastTick = at;
      await settle();
    }
    expect(this.now).toBe(T0 + untilS);
  }

  private standings(): Standings {
    const capabilities = { vehicles: true, predictions: true };
    expect(this.keys).toBeDefined();
    expect(Object.keys(this.keys)).toHaveLength(2);
    return {
      swiftly: { hasKey: this.keys.swiftly, capabilities, callsThisMonth: 0 },
      transitland: { hasKey: this.keys.transitland, capabilities, callsThisMonth: 0 },
    };
  }
}

/** Lets resolved fetches and the poller's bookkeeping run. */
async function settle(): Promise<void> {
  const before = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(Date.now()).toBeGreaterThanOrEqual(before);
  expect(typeof before).toBe('number');
}

/** Seconds after T0 of each call `provider` received for `what`. */
function callTimes(provider: FakeProvider, what = 'vehicles'): number[] {
  const times = provider.calls.filter((call) => call.what === what).map((call) => call.at - T0);
  expect(times.every((t) => t >= 0)).toBe(true);
  expect(times).toEqual([...times].sort((a, b) => a - b));
  return times;
}

describe('LivePoller (M4.9): cadence', () => {
  it('polls nothing while no provider has a key, then at the next tick once a key appears', async () => {
    const h = new Harness();
    h.keys.transitland = false;
    await h.step(10);
    expect(h.transitland.calls).toEqual([]);
    expect(h.latest.status.vehicles.provider).toBe('none');
    h.keys.transitland = true;
    await h.step(11);
    expect(callTimes(h.transitland)).toEqual([11]);
    expect(h.latest.status.vehicles).toEqual({ provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null });
  });

  it('polls vehicles at the serving provider\'s cadence: Transitland every 60 s; once Swiftly is keyed it takes over at once, every 30 s', async () => {
    const h = new Harness();
    await h.step(130);
    expect(callTimes(h.transitland)).toEqual([0, 60, 120]);
    h.keys.swiftly = true;
    await h.step(200);
    expect(callTimes(h.swiftly)).toEqual([131, 161, 191]);
    expect(callTimes(h.transitland)).toEqual([0, 60, 120]);
    expect(h.latest.vehicles?.provider).toBe('swiftly');
  });

  it('never overlaps: a poll still in flight is not started again, however long it takes', async () => {
    const h = new Harness();
    h.transitland.hold = true;
    await h.step(200);
    expect(callTimes(h.transitland)).toEqual([0]);
    h.transitland.release();
    await settle();
    await h.step(261);
    expect(callTimes(h.transitland)).toEqual([0, 260]);
  });

});

describe('LivePoller (M4.9): failures and failover', () => {
  it('a lone keyed provider that keeps failing is never parked on none: failing after 3, retried at 60, 60, 60, 120 s', async () => {
    const h = new Harness();
    h.transitland.next = NETWORK_DOWN;
    await h.step(400);
    expect(callTimes(h.transitland)).toEqual([0, 60, 120, 180, 300]);
    expect(h.latest.status.vehicles).toEqual({ provider: 'transitland', failing: true, consecutiveFailures: 5, lastError: NETWORK_DOWN });
  });

  it('fails over per capability: Swiftly vehicles failing 3 times → Transitland serves vehicles at once, Swiftly keeps predictions; the primary is re-probed 300 s later', async () => {
    const h = new Harness();
    h.keys.swiftly = true;
    h.poller.watchStations(['rail:government-ctr']);
    h.swiftly.script.set('vehicles', NETWORK_DOWN);
    await h.step(90);
    expect(callTimes(h.swiftly)).toEqual([0, 30, 60]);
    expect(callTimes(h.transitland)).toEqual([61]);
    expect(h.latest.status.vehicles).toEqual({ provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null });
    expect(h.latest.status.predictions.provider).toBe('swiftly');
    expect(callTimes(h.swiftly, 'rail:government-ctr')).toEqual([0, 30, 60, 90]);
    h.swiftly.script.set('vehicles', 'ok');
    await h.step(400);
    expect(callTimes(h.swiftly)).toEqual([0, 30, 60, 360, 390]);
  });

  it('a 429 doubles the interval (Transitland 60 → 120 s)', async () => {
    const h = new Harness();
    await h.step(0);
    h.transitland.next = RATE_LIMITED;
    await h.step(60);
    h.transitland.next = 'ok';
    await h.step(200);
    expect(callTimes(h.transitland)).toEqual([0, 60, 180]);
    expect(h.latest.status.vehicles.lastError).toBeNull();
  });
});

describe('LivePoller (M4.9): watched stations', () => {
  it('each watched station is its own task, due at once; unwatching drops its batch', async () => {
    const h = new Harness();
    await h.step(5);
    h.poller.watchStations(['rail:government-ctr', 'mover:government-center']);
    await h.step(6);
    expect(callTimes(h.transitland, 'rail:government-ctr')).toEqual([6]);
    expect([...h.latest.predictions.keys()].sort()).toEqual(['mover:government-center', 'rail:government-ctr']);
    h.poller.watchStations(['mover:government-center']);
    expect([...h.latest.predictions.keys()]).toEqual(['mover:government-center']);
    await h.step(70);
    expect(callTimes(h.transitland, 'rail:government-ctr')).toEqual([6]);
    expect(callTimes(h.transitland, 'mover:government-center')).toEqual([6, 66]);
  });

});

describe('LivePoller (M4.9): staleness and bugs', () => {
  it('a failed poll keeps the previous batch, so stale data ages instead of vanishing', async () => {
    const h = new Harness();
    await h.step(0);
    const first = h.latest.vehicles;
    h.transitland.next = NETWORK_DOWN;
    await h.step(60);
    expect(first?.fetchedAt).toBe(T0);
    expect(h.latest.vehicles).toBe(first);
    expect(h.latest.status.vehicles.lastError).toEqual(NETWORK_DOWN);
  });

  it('resume after the background: every task due again, never sooner than one cadence after its last start', async () => {
    const h = new Harness();
    await h.step(0);
    h.now = T0 + 10;
    h.poller.resume();
    await settle();
    expect(callTimes(h.transitland)).toEqual([0]);
    h.now = T0 + 500;
    h.poller.resume();
    await settle();
    expect(callTimes(h.transitland)).toEqual([0, 500]);
  });

  it('a poll that fails by a BUG (a provider rejecting) is reported to onBug, and its task backs off instead of wedging in flight', async () => {
    const h = new Harness();
    h.transitland.next = 'reject';
    await h.step(60);
    expect(h.bugs).toEqual(['Error: fake provider bug', 'Error: fake provider bug']);
    expect(callTimes(h.transitland)).toEqual([0, 60]);
    expect(h.latest.status.vehicles.consecutiveFailures).toBe(2);
  });

});

describe('LivePoller (M4.9): lifecycle', () => {
  it('dispose aborts the polls in flight and nothing is published afterwards', async () => {
    const h = new Harness();
    h.transitland.hold = true;
    await h.step(0);
    const published = h.snapshots.length;
    h.poller.dispose();
    expect(h.transitland.calls[0]?.signal.aborted).toBe(true);
    h.transitland.release();
    await settle();
    expect(h.snapshots).toHaveLength(published);
    h.poller.watchStations(['rail:brickell']);
    expect(h.snapshots).toHaveLength(published);
  });

  it('credentialsChanged gives a failing provider a clean slate and makes its task due again', async () => {
    const h = new Harness();
    h.transitland.next = NETWORK_DOWN;
    await h.step(180);
    expect(h.latest.status.vehicles.failing).toBe(true);
    h.transitland.next = 'ok';
    h.poller.credentialsChanged('transitland');
    await h.step(240);
    expect(callTimes(h.transitland)).toEqual([0, 60, 120, 180, 240]);
    expect(h.latest.status.vehicles).toEqual({ provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null });
  });
});

/** A Swiftly failure handed out again from a download another poll started (providers/swiftly.ts). */
const REUSED_NETWORK_DOWN: LiveError = { ...NETWORK_DOWN, reused: true };

describe('LivePoller (mfix10): polls that count for nothing', () => {
  it('a poll whose provider is gated when it ends leaves no trace: no lastError, no failure, its task not backed off', async () => {
    const h = new Harness();
    [h.keys.swiftly, h.swiftly.next, h.swiftly.hold] = [true, NETWORK_DOWN, true];
    for (const atS of [0, 30, 60]) {
      await h.step(atS); // Swiftly's poll starts, and hangs
      h.keys.swiftly = false; // gated off Wi-Fi while it is in flight: it fails
      h.swiftly.release();
      await settle();
      h.keys.swiftly = true; // back before the next tick, so the task is still Swiftly's
    }
    [h.swiftly.next, h.swiftly.hold] = ['ok', false];
    await h.step(100);
    expect(callTimes(h.swiftly)).toEqual([0, 30, 60, 90]); // at its cadence: 3 counted failures would have backed it off to 60 s
    expect(h.snapshots.filter((snapshot) => snapshot.status.vehicles.lastError !== null || snapshot.status.vehicles.consecutiveFailures > 0)).toEqual([]);
  });

  it('a failure reused from another poll\'s download is recorded nowhere: no failure count, no backoff, no lastError', async () => {
    const h = new Harness();
    h.keys.swiftly = true;
    h.swiftly.next = REUSED_NETWORK_DOWN;
    await h.step(150);
    expect(callTimes(h.swiftly)).toEqual([0, 30, 60, 90, 120, 150]); // never backed off, never benched
    expect(h.latest.status.vehicles).toEqual({ provider: 'swiftly', failing: false, consecutiveFailures: 0, lastError: null });
    h.swiftly.next = NETWORK_DOWN; // its own failure counts
    await h.step(180);
    expect(h.latest.status.vehicles).toEqual({ provider: 'swiftly', failing: false, consecutiveFailures: 1, lastError: NETWORK_DOWN });
  });
});

describe('LivePoller (mfix10): the resume hold', () => {
  it('a held poller is not ticked, and a poll that ended meanwhile is settled when the hold lifts, on the standings then', async () => {
    const h = new Harness();
    h.keys.swiftly = true;
    h.swiftly.next = NETWORK_DOWN;
    h.swiftly.hold = true;
    await h.step(0);
    h.poller.hold();
    expect(() => h.poller.tick()).toThrow('a held poller does not tick');
    h.swiftly.release();
    await settle();
    const published = h.snapshots.length;
    expect(h.latest.status.vehicles).toEqual({ provider: 'swiftly', failing: false, consecutiveFailures: 0, lastError: null }); // nothing moved yet
    h.keys.swiftly = false; // the fresh reading: off Wi-Fi
    h.now = T0 + 2;
    h.poller.resume();
    await settle();
    expect(h.snapshots.slice(published).filter((snapshot) => snapshot.status.vehicles.lastError !== null || snapshot.status.vehicles.provider === 'swiftly')).toEqual([]);
    expect(callTimes(h.transitland)).toEqual([2]);
  });
});

describe('MonotonicClock (M4.9)', () => {
  it('never runs backwards: a backwards wall-clock step is absorbed, a forward one passes through', () => {
    const wall = { now: 1_000 };
    const clock = new MonotonicClock(() => wall.now);
    const readings: number[] = [];
    for (const step of [1_000, 990, 995, 2_000]) {
      wall.now = step;
      readings.push(clock.now());
    }
    expect(readings).toEqual([1_000, 1_000, 1_005, 2_010]);
    expect(readings).toEqual([...readings].sort((a, b) => a - b));
  });
});
