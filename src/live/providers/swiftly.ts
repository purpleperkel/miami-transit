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
 * SWIFTLY'S 30 s FLOOR, AT THE SOURCE (binding cache term, plan §3; mfix10 fix rounds 2 and 3): the
 * provider never STARTS a request to an endpoint less than FLOOR_MS (30 000 ms) after its previous
 * start there, whatever the scheduler or a provider switch asks.
 *  - PER ENDPOINT: the endpoint is the request URL (the agency key is in it). The provider remembers
 *    the last start at each endpoint, in a small map pruned of every entry past its floor, so agency
 *    A → B → A within 30 s downloads A once.
 *  - IN MILLISECONDS, ON A MONOTONIC CLOCK: `deps.monotonicMs` (the runtime injects performance.now()),
 *    never floored wall seconds. A start at x.95 s allows the next one at x.95 + 30.000 s, not at
 *    x + 30; and a wall-clock correction, forward or back, neither shortens nor stretches the floor.
 *    On iOS, React Native 0.86's performance.now() reads mach_absolute_time
 *    (ReactCommon/react/timing/primitives.h, machAbsoluteTimeToSteadyClockTimePoint), which does not
 *    advance while the phone sleeps: a floor started just before a sleep runs out its 30 s in awake
 *    time after the wake, so the first Swiftly poll after unlocking may be handed the previous download
 *    (its age shows) — never an extra request.
 *  - A NEW KEY IS A NEW REQUEST: `keyChanged()`, which the runtime calls when Swiftly's key changes,
 *    clears the map, so a corrected key is tried at the next heartbeat. (A new agency key
 *    needs no clearing: it is a new endpoint.)
 *  - SHARING: inside the floor a fetch gets the previous download's result — in flight or finished,
 *    success, failure or rejection — and meters no call. A failure handed out that way is marked
 *    `reused`, and a rejection (a bug, e.g. a mapper's broken invariant) is handed out as a
 *    ReusedRejection: the poll that started the download records it in the chain once, and every
 *    poll that gets it still backs off (poller.ts).
 */

export const SWIFTLY_CAPABILITIES: Capabilities = Object.freeze({ vehicles: true, predictions: true });

/** Swiftly's 30 s floor, in milliseconds. */
const FLOOR_MS = PROVIDER_CONFIG.swiftly.cadenceS * 1_000;

/** The Swiftly provider, as the runtime holds it: a LiveProvider whose remembered downloads a key change clears. */
export type SwiftlyLiveProvider = LiveProvider & {
  /**
   * Swiftly's key changed to `key` (null: removed), and it is in effect: every remembered download is
   * forgotten, so the next fetch of each endpoint downloads with the new key.
   */
  keyChanged(key: string | null): void;
};

/** One download from one endpoint, with the key it was made with, shared by every fetch of it within FLOOR_MS of its start. */
type Download<T> = { readonly key: string; readonly startedAtMs: number; readonly result: Promise<LiveResult<T>> };

/** The download a fetch reads: one it started, or one it reuses from inside the floor. */
type Taken<T> = { readonly download: Download<T>; readonly reused: boolean };

class SwiftlyProvider implements SwiftlyLiveProvider {
  readonly id: ChainProviderId = 'swiftly';
  readonly capabilities = SWIFTLY_CAPABILITIES;
  /** The last download from each endpoint, by URL, per feed — only while it is inside its floor. */
  private readonly vehicles = new Map<string, Download<LiveVehicle>>();
  private readonly tripUpdates = new Map<string, Download<LivePrediction>>();
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
    const batch = await handOut(this.take(this.vehicles, request.value, swiftly, signal, (body) => vehiclesBatch(body, this.deps.network)));
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
    const all = await handOut(this.take(this.tripUpdates, request.value, swiftly, signal, (body) => tripUpdatesBatch(body, this.deps.network)));
    invariant(!all.ok || all.value.provider === 'swiftly', 'the shared feed is Swiftly\'s');
    return all.ok ? ok(stationBatch(all.value, stationKey)) : all;
  }

  keyChanged(key: string | null): void {
    invariant(key === this.deps.keys().swiftly, 'the provider is told of the key in effect now');
    const remembered = [...this.vehicles.values(), ...this.tripUpdates.values()];
    invariant(remembered.every((download) => download.key !== key), 'downloads are forgotten only for a new key (a new agency key is a new endpoint and forgets nothing)');
    this.vehicles.clear();
    this.tripUpdates.clear();
  }

  /**
   * The download from `request`'s endpoint that started less than FLOOR_MS ago (reused), else one
   * started now; `downloads` is pruned of every entry past its floor first.
   */
  private take<T>(downloads: Map<string, Download<T>>, request: LiveRequest, key: string | null, signal: AbortSignal, map: (body: HttpBody) => LiveResult<T>): Taken<T> {
    const nowMs = this.clock.now();
    invariant(key !== null && request.url.startsWith('https://'), 'a keyed request to an https endpoint');
    for (const [url, download] of downloads) {
      if (nowMs - download.startedAtMs >= FLOOR_MS) {
        downloads.delete(url);
      }
    }
    const last = downloads.get(request.url);
    invariant(last === undefined || last.key === key, 'a download is shared only under the key it was made with (a key change forgets them all)');
    const taken: Taken<T> = last === undefined ? { download: { key, startedAtMs: nowMs, result: this.download(request, signal, map) }, reused: false } : { download: last, reused: true };
    downloads.set(request.url, taken.download);
    invariant([...downloads.values()].every((download) => nowMs - download.startedAtMs < FLOOR_MS), 'only downloads inside their floor are remembered');
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
}

/**
 * A download's result as one fetch gets it: the fetch that started the download gets it as it came;
 * a fetch that reuses it gets a failure marked `reused`, and a rejection (a bug) as a ReusedRejection.
 */
async function handOut<T>({ download, reused }: Taken<T>): Promise<LiveResult<T>> {
  let result: LiveResult<T>;
  try {
    result = await download.result;
  } catch (error) {
    throw reused ? new ReusedRejection(error) : error; // a bug either way: the poll reports it, and counts it only if it started the download
  }
  invariant(result.ok || result.error.reused !== true, 'a download\'s own result is never marked reused (the shared result stays as downloaded)');
  invariant(result.ok || result.error.kind !== 'no-key', 'a download fails by the network, the server or the body, never for want of a key');
  return reused && !result.ok ? err({ ...result.error, reused: true as const }) : result;
}

export function createSwiftlyProvider(deps: ProviderDeps): SwiftlyLiveProvider {
  const provider = new SwiftlyProvider(deps);
  invariant(provider.id === 'swiftly', 'the provider is Swiftly');
  invariant(provider.capabilities.vehicles && provider.capabilities.predictions, 'Swiftly serves vehicles and predictions');
  return provider;
}
