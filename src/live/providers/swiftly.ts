import { PROVIDER_CONFIG } from '../../domain/live/constants';
import { type LiveRequest, swiftlyTripUpdatesRequest, swiftlyVehiclesRequest } from '../../domain/live/transports';
import type { Capabilities, ChainProviderId, LivePrediction, LiveProvider, LiveResult, LiveVehicle } from '../../domain/live/types';
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
 * SWIFTLY'S 30 s FLOOR, AT THE SOURCE (binding cache term, plan §3; mfix10 fix round 2): the provider
 * never STARTS a request to an endpoint less than PROVIDER_CONFIG.swiftly.cadenceS after its previous
 * start there, whatever the scheduler or a provider switch asks. Inside the floor a fetch returns the
 * previous download's result — in flight or finished, success or failure — and meters no call. A
 * failure handed out that way is marked `reused`: the poll that started the download records it, the
 * polls that reuse it do not (poller.ts), so one cut download is one failure, however many stations
 * read it. The endpoint is the request URL (the agency key is in it, so a new agency key downloads at
 * once). The floor is measured on a clock that never runs backwards, so a wall-clock correction
 * neither shortens it nor stretches it.
 */

export const SWIFTLY_CAPABILITIES: Capabilities = Object.freeze({ vehicles: true, predictions: true });

/** One download from one endpoint, shared by every fetch of it within one cadence of its start. */
type Download<T> = { readonly url: string; readonly startedAt: number; readonly result: Promise<LiveResult<T>> };

class SwiftlyProvider implements LiveProvider {
  readonly id: ChainProviderId = 'swiftly';
  readonly capabilities = SWIFTLY_CAPABILITIES;
  private vehicles: Download<LiveVehicle> | null = null;
  private tripUpdates: Download<LivePrediction> | null = null;
  private readonly clock: MonotonicClock;

  constructor(private readonly deps: ProviderDeps) {
    invariant(typeof deps.get === 'function' && typeof deps.recordCall === 'function', 'the provider sends requests and meters them');
    invariant(PROVIDER_CONFIG.swiftly.cadenceS >= 30, 'Swiftly\'s docs bind a cache of at least 30 s');
    this.clock = new MonotonicClock(deps.nowS);
  }

  async fetchVehicles(signal: AbortSignal): Promise<LiveResult<LiveVehicle>> {
    invariant(!signal.aborted, 'a poll starts under a live runtime');
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyVehiclesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    const download = this.downloadOf(this.vehicles, request.value, signal, (body) => vehiclesBatch(body, this.deps.network));
    const reused = download === this.vehicles;
    this.vehicles = download;
    const batch = await download.result;
    invariant(!batch.ok || batch.value.provider === 'swiftly', 'the batch is Swiftly\'s');
    return handedOut(batch, reused);
  }

  async fetchPredictions(stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
    invariant(this.deps.network.stopsOfStation(stationKey).length > 0, `${stationKey} is a station of the schedule, with stops`);
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyTripUpdatesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    const download = this.downloadOf(this.tripUpdates, request.value, signal, (body) => tripUpdatesBatch(body, this.deps.network));
    const reused = download === this.tripUpdates;
    this.tripUpdates = download;
    const all = await download.result;
    invariant(!all.ok || all.value.provider === 'swiftly', 'the shared feed is Swiftly\'s');
    return all.ok ? ok(stationBatch(all.value, stationKey)) : handedOut(all, reused);
  }

  /** `last`, when it downloaded the same endpoint less than one cadence ago (the 30 s floor); else a download started now. */
  private downloadOf<T>(last: Download<T> | null, request: LiveRequest, signal: AbortSignal, map: (body: HttpBody) => LiveResult<T>): Download<T> {
    const nowS = this.clock.now();
    invariant(last === null || nowS >= last.startedAt, 'the floor is measured on a clock that never runs backwards');
    invariant(request.url.startsWith('https://'), 'an endpoint is an https URL');
    if (last !== null && last.url === request.url && nowS - last.startedAt < PROVIDER_CONFIG.swiftly.cadenceS) {
      return last;
    }
    return { url: request.url, startedAt: nowS, result: this.download(request, signal, map) };
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

/** A download's result as one fetch gets it: a failure handed out again from another poll's download is marked `reused`. */
function handedOut<T>(result: LiveResult<T>, reused: boolean): LiveResult<T> {
  invariant(result.ok || result.error.reused !== true, 'a download\'s own result is never marked reused (the shared result stays as downloaded)');
  invariant(result.ok || result.error.kind !== 'no-key', 'a download fails by the network, the server or the body, never for want of a key');
  return reused && !result.ok ? err({ ...result.error, reused: true as const }) : result;
}

export function createSwiftlyProvider(deps: ProviderDeps): LiveProvider {
  const provider = new SwiftlyProvider(deps);
  invariant(provider.id === 'swiftly', 'the provider is Swiftly');
  invariant(provider.capabilities.vehicles && provider.capabilities.predictions, 'Swiftly serves vehicles and predictions');
  return provider;
}
