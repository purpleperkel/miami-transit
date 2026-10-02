import { PROVIDER_CONFIG } from '../../domain/live/constants';
import { type LiveRequest, swiftlyTripUpdatesRequest, swiftlyVehiclesRequest } from '../../domain/live/transports';
import { type Capabilities, type ChainProviderId, type LivePrediction, type LiveProvider, type LiveResult, type LiveVehicle, ReusedRejection } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { err, ok } from '../../lib/result';
import type { HttpBody } from '../http';
import { MonotonicClock } from '../poller';
import { type ProviderDeps, stationBatch, tripUpdatesBatch, vehiclesBatch } from './batches';

/**
 * Plan M4.9 / §3: Swiftly, the county's official realtime source (primary once its key arrives) —
 * GTFS-realtime protobuf at https://api.goswift.ly/real-time/<agencyKey>/…, header
 * `Authorization: <key>`, 30 s cadence.
 *
 *  - Vehicles: `gtfs-rt-vehicle-positions`.
 *  - Predictions: `gtfs-rt-trip-updates` is ONE whole-agency feed, but the LiveProvider contract asks
 *    station by station, so every watched station reads the same download.
 *
 * SWIFTLY'S 30 s FLOOR, AT THE SOURCE (binding cache term, plan §3; mfix10 fix rounds 2 to 4): the
 * provider never STARTS a request less than FLOOR_MS (30 000 ms) after its previous start of the same
 * request, whatever the scheduler or a provider switch asks.
 *  - A REQUEST IS ITS (URL, KEY) (fix round 4, S3): the URL names the endpoint (the agency key is in
 *    it), the Authorization key completes the request. The provider remembers the last start of each,
 *    in a small map pruned of every entry past its floor, so agency A → B → A, or key A → B → A,
 *    within 30 s downloads A once, while a new agency or a new key downloads at once. The key is used
 *    only inside that in-memory map key: never logged, printed, or put in an invariant message.
 *    `keyChanged()` (the runtime calls it when Swiftly's key changes) only prunes the entries past their
 *    floor; it forgets nothing still inside one.
 *  - IN MILLISECONDS, ON THE FLOOR CLOCK: `deps.monotonicMs`, never floored wall seconds. A start at
 *    x.95 s allows the next one at x.95 + 30.000 s, not at x + 30; and a wall-clock correction while
 *    the app is open neither shortens nor stretches the floor. The runtime's floor clock
 *    (floor-clock.ts) is performance.now() — on iOS mach_absolute_time, which stops while the phone
 *    sleeps — plus the sleep inside every spell out of the foreground, so a floor started before a lock
 *    is over after a lock longer than 30 s (fix round 4, S1).
 *  - SHARING: inside the floor a fetch gets the previous download's result — in flight or finished,
 *    success, failure or rejection — and meters no call. A SUCCESS handed out that way carries
 *    `floorEndsInMs`, the time left on the floor, and the poller makes its task due the moment the
 *    floor ends (fix round 4, S2). A FAILURE handed out that way is marked `reused`, and a rejection (a
 *    bug, e.g. a mapper's broken invariant) is handed out as a ReusedRejection: the poll that started
 *    the download records it in the chain once, and every poll that gets it still backs off (poller.ts).
 *  - An ABORTED download is a start like any other: when Swiftly's credentials change, the poller
 *    aborts the requests out under the old ones (fix round 4, S4), and when the app leaves the
 *    foreground it aborts every request in flight (fix round 5, T1: poller.ts pauseAll). The aborted
 *    download stays remembered, as a failure, until its floor ends, so the polls a resume starts over
 *    are held to that floor: a trip to another app never buys an early request.
 *
 * ACCEPTED RESIDUALS (arbiter, mfix10 fix rounds 4 and 5):
 *  - S5: agency A → B → A while A's failing download is in flight counts that failure ZERO times: the
 *    change to B aborts it and its poll ends in an earlier credentials era, which leaves no trace; back
 *    on A inside its floor, every fetch reads it reused, which the chain does not count. (Any download
 *    of A in flight at the change ends the same way: read back as a cancelled failure, unrecorded,
 *    its tasks backing off as after any failure.)
 *  - R5: every poll that reads a broken download (a rejection, a bug) reports it through onBug, so one
 *    broken download is one report per poll that read it, all with the same text.
 *  - S2 (fix round 5, T3): a poll turned away MID-DOWNLOAD (the download it reads still in flight) ends
 *    when that download does, between heartbeats, and the poller rounds the floor's time left UP to
 *    its whole-second clock: so the poll is due up to one heartbeat after the floor ends, never early.
 *    On the wall clock, with the heartbeat's phase against the second, its request comes up to two
 *    heartbeats after the floor ends; and a heartbeat that finds it due inside the floor's last second
 *    is turned away once more, at no request (a model of 2 000 000 random phases, 2026-10-02: no early
 *    request, at most 1.98 s late, about one in six turned away twice). A poll turned away AT a
 *    heartbeat (the download already in) is due less than one heartbeat after the floor ends.
 *  - T1 (fix round 5): a poll the resume starts over inside the floor of a download that leaving the
 *    foreground aborted reads that download as a cancelled failure, reused: unrecorded, and its task
 *    backs off one cadence (R-b) like any failed poll. So after a short trip to another app the next
 *    request comes a cadence after the first poll back, not at the floor's end; after a lock longer
 *    than 30 s the floor is over and the first poll back downloads afresh.
 */

export const SWIFTLY_CAPABILITIES: Capabilities = Object.freeze({ vehicles: true, predictions: true });

/** Swiftly's 30 s floor, in milliseconds. */
const FLOOR_MS = PROVIDER_CONFIG.swiftly.cadenceS * 1_000;

/** The Swiftly provider, as the runtime holds it: a LiveProvider told when Swiftly's key changes. */
export type SwiftlyLiveProvider = LiveProvider & {
  /**
   * Swiftly's key changed to `key` (null: removed), and it is in effect: every remembered download
   * past its floor is forgotten. One still inside its floor is kept: going back to its key within
   * the floor must not repeat its request, and a new key is a new request anyway.
   */
  keyChanged(key: string | null): void;
};

/** One download of one request (URL, key), shared by every fetch of that request within FLOOR_MS of its start. */
type Download<T> = { readonly startedAtMs: number; readonly result: Promise<LiveResult<T>> };

/** The downloads of one feed inside their floor, by request identity (identityOf). */
type Downloads<T> = Map<string, Download<T>>;

/** The download a fetch reads: one it started, or one it reuses from inside the floor. */
type Taken<T> = { readonly download: Download<T>; readonly reused: boolean };

class SwiftlyProvider implements SwiftlyLiveProvider {
  readonly id: ChainProviderId = 'swiftly';
  readonly capabilities = SWIFTLY_CAPABILITIES;
  /** The last download of each request (URL, key), per feed — only while it is inside its floor. */
  private readonly vehicles: Downloads<LiveVehicle> = new Map();
  private readonly tripUpdates: Downloads<LivePrediction> = new Map();
  private readonly clock: MonotonicClock;

  constructor(private readonly deps: ProviderDeps) {
    invariant(typeof deps.get === 'function' && typeof deps.recordCall === 'function', 'the provider sends requests and meters them');
    invariant(PROVIDER_CONFIG.swiftly.cadenceS >= 30, 'Swiftly\'s docs bind a cache of at least 30 s');
    this.clock = new MonotonicClock(deps.monotonicMs);
  }

  async fetchVehicles(signal: AbortSignal): Promise<LiveResult<LiveVehicle>> {
    invariant(!signal.aborted, 'a poll starts under a live runtime');
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyVehiclesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    const batch = await this.handOut(this.take(this.vehicles, request.value, swiftly, signal, (body) => vehiclesBatch(body, this.deps.network)));
    invariant(!batch.ok || batch.value.provider === 'swiftly', 'the batch is Swiftly\'s');
    return batch;
  }

  async fetchPredictions(stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
    invariant(this.deps.network.stopsOfStation(stationKey).length > 0, `${stationKey} is a station of the schedule, with stops`);
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyTripUpdatesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    const all = await this.handOut(this.take(this.tripUpdates, request.value, swiftly, signal, (body) => tripUpdatesBatch(body, this.deps.network)));
    invariant(!all.ok || all.value.provider === 'swiftly', 'the shared feed is Swiftly\'s');
    return all.ok ? ok(stationBatch(all.value, stationKey)) : all;
  }

  keyChanged(key: string | null): void {
    invariant(key === this.deps.keys().swiftly, 'the provider is told of the key in effect now');
    const nowMs = this.clock.now();
    prune(this.vehicles, nowMs);
    prune(this.tripUpdates, nowMs);
    invariant([...this.vehicles.values(), ...this.tripUpdates.values()].every((download) => download.startedAtMs <= nowMs), 'every download kept started at or before now: the floor clock never runs backwards');
  }

  /**
   * The download of `request` under `key` that started less than FLOOR_MS ago (reused), else one
   * started now; `downloads` is pruned of every entry past its floor first.
   */
  private take<T>(downloads: Downloads<T>, request: LiveRequest, key: string | null, signal: AbortSignal, map: (body: HttpBody) => LiveResult<T>): Taken<T> {
    const nowMs = this.clock.now();
    invariant(key !== null && request.url.startsWith('https://'), 'a keyed request to an https endpoint');
    prune(downloads, nowMs);
    const identity = identityOf(request.url, key);
    const last = downloads.get(identity);
    const taken: Taken<T> = last === undefined ? { download: { startedAtMs: nowMs, result: this.download(request, signal, map) }, reused: false } : { download: last, reused: true };
    downloads.set(identity, taken.download);
    invariant(taken.reused ? nowMs - taken.download.startedAtMs < FLOOR_MS : taken.download.startedAtMs === nowMs, 'a fetch reuses only a download inside its floor; any other starts one now');
    return taken;
  }

  /** One request, metered against the quota before it is sent, its body mapped to a batch. */
  private async download<T>(request: LiveRequest, signal: AbortSignal, map: (body: HttpBody) => LiveResult<T>): Promise<LiveResult<T>> {
    invariant(request.provider === 'swiftly', 'Swiftly downloads only its own requests');
    invariant(!signal.aborted, 'a download starts under a live runtime');
    this.deps.recordCall('swiftly');
    const body = await this.deps.get(request, signal);
    return body.ok ? map(body.value) : body;
  }

  /**
   * A download's result as one fetch gets it: the fetch that started the download gets it as it came.
   * A fetch that reuses it gets a success carrying `floorEndsInMs` (the floor's time left now), a
   * failure marked `reused`, and a rejection (a bug) as a ReusedRejection.
   */
  private async handOut<T>({ download, reused }: Taken<T>): Promise<LiveResult<T>> {
    let result: LiveResult<T>;
    try {
      result = await download.result;
    } catch (error) {
      throw reused ? new ReusedRejection(error) : error; // a bug either way: the poll reports it, and counts it only if it started the download
    }
    invariant(result.ok ? result.value.floorEndsInMs === undefined : result.error.reused !== true, 'a download\'s own result is never marked as handed out again (the shared result stays as downloaded)');
    invariant(result.ok || result.error.kind !== 'no-key', 'a download fails by the network, the server or the body, never for want of a key');
    if (!reused) {
      return result;
    }
    return result.ok ? ok({ ...result.value, floorEndsInMs: Math.max(0, download.startedAtMs + FLOOR_MS - this.clock.now()) }) : err({ ...result.error, reused: true as const });
  }
}

/** A request's identity as an in-memory map key: its URL and its key. Never logged or printed. */
function identityOf(url: string, key: string): string {
  invariant(url.startsWith('https://'), 'a request goes to an https endpoint');
  invariant(key.length > 0, 'a request carries a key');
  return JSON.stringify([url, key]);
}

/** Forgets every download in `downloads` that started FLOOR_MS or more before `nowMs`. */
function prune<T>(downloads: Downloads<T>, nowMs: number): void {
  invariant(Number.isFinite(nowMs), 'the floor is measured at an instant');
  for (const [identity, download] of downloads) {
    if (nowMs - download.startedAtMs >= FLOOR_MS) {
      downloads.delete(identity);
    }
  }
  invariant([...downloads.values()].every((download) => nowMs - download.startedAtMs < FLOOR_MS), 'only downloads inside their floor are remembered');
}

export function createSwiftlyProvider(deps: ProviderDeps): SwiftlyLiveProvider {
  const provider = new SwiftlyProvider(deps);
  invariant(provider.id === 'swiftly', 'the provider is Swiftly');
  invariant(provider.capabilities.vehicles && provider.capabilities.predictions, 'Swiftly serves vehicles and predictions');
  return provider;
}
