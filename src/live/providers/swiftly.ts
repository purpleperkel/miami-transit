import { PROVIDER_CONFIG } from '../../domain/live/constants';
import { swiftlyTripUpdatesRequest, swiftlyVehiclesRequest } from '../../domain/live/transports';
import type { Capabilities, ChainProviderId, LivePrediction, LiveProvider, LiveResult, LiveVehicle } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { ok } from '../../lib/result';
import { type ProviderDeps, stationBatch, tripUpdatesBatch, vehiclesBatch } from './batches';

/**
 * Plan M4.9 / §3: Swiftly, the county's official realtime source (primary once its key arrives) —
 * GTFS-realtime protobuf at https://api.goswift.ly/real-time/<agencyKey>/…, header
 * `Authorization: <key>`, 30 s cadence.
 *
 *  - Vehicles: `gtfs-rt-vehicle-positions`.
 *  - Predictions: `gtfs-rt-trip-updates` is ONE whole-agency feed, but the LiveProvider contract asks
 *    station by station. So the feed is fetched once and SHARED: every station asked within one
 *    cadence (30 s) of a fetch's start reads that same fetch — in flight or finished, success or
 *    failure. That is exactly Swiftly's binding "cache GTFS-rt for at least 30 s" rule, and it keeps
 *    several watched stations from multiplying the download.
 */

export const SWIFTLY_CAPABILITIES: Capabilities = Object.freeze({ vehicles: true, predictions: true });

type SharedFetch = { readonly startedAt: number; readonly result: Promise<LiveResult<LivePrediction>> };

class SwiftlyProvider implements LiveProvider {
  readonly id: ChainProviderId = 'swiftly';
  readonly capabilities = SWIFTLY_CAPABILITIES;
  private shared: SharedFetch | null = null;

  constructor(private readonly deps: ProviderDeps) {
    invariant(typeof deps.get === 'function' && typeof deps.recordCall === 'function', 'the provider sends requests and meters them');
    invariant(PROVIDER_CONFIG.swiftly.cadenceS >= 30, 'Swiftly\'s docs bind a cache of at least 30 s');
  }

  async fetchVehicles(signal: AbortSignal): Promise<LiveResult<LiveVehicle>> {
    invariant(!signal.aborted, 'a poll starts under a live runtime');
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyVehiclesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    this.deps.recordCall('swiftly');
    const body = await this.deps.get(request.value, signal);
    const batch = body.ok ? vehiclesBatch(body.value, this.deps.network) : body;
    invariant(!batch.ok || batch.value.provider === 'swiftly', 'the batch is Swiftly\'s');
    return batch;
  }

  async fetchPredictions(stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
    invariant(this.deps.network.stopsOfStation(stationKey).length > 0, `${stationKey} is a station of the schedule, with stops`);
    const nowS = this.deps.nowS();
    const reuse = this.shared !== null && nowS - this.shared.startedAt < PROVIDER_CONFIG.swiftly.cadenceS;
    const shared = reuse && this.shared !== null ? this.shared : { startedAt: nowS, result: this.fetchTripUpdates(signal) };
    this.shared = shared;
    const all = await shared.result;
    invariant(!all.ok || all.value.provider === 'swiftly', 'the shared feed is Swiftly\'s');
    return all.ok ? ok(stationBatch(all.value, stationKey)) : all;
  }

  /** One whole-agency trip-updates fetch, mapped to predictions for every in-scope stop. */
  private async fetchTripUpdates(signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
    invariant(!signal.aborted, 'a poll starts under a live runtime');
    const { swiftly, swiftlyAgency } = this.deps.keys();
    const request = swiftlyTripUpdatesRequest(swiftly, swiftlyAgency);
    if (!request.ok) {
      return request;
    }
    this.deps.recordCall('swiftly');
    const body = await this.deps.get(request.value, signal);
    const batch = body.ok ? tripUpdatesBatch(body.value, this.deps.network) : body;
    invariant(!batch.ok || batch.value.provider === 'swiftly', 'the batch is Swiftly\'s');
    return batch;
  }
}

export function createSwiftlyProvider(deps: ProviderDeps): LiveProvider {
  const provider = new SwiftlyProvider(deps);
  invariant(provider.id === 'swiftly', 'the provider is Swiftly');
  invariant(provider.capabilities.vehicles && provider.capabilities.predictions, 'Swiftly serves vehicles and predictions');
  return provider;
}
