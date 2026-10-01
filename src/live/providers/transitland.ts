import { transitlandDeparturesRequest, transitlandVehiclesRequest } from '../../domain/live/transports';
import type { Capabilities, LiveBatch, LivePrediction, LiveProvider, LiveResult, LiveVehicle } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { ok } from '../../lib/result';
import { combineBatches, departuresBatch, type ProviderDeps, vehiclesBatch } from './batches';

/**
 * Plan M4.9 / §3: Transitland (Interline), the day-one realtime source — 60 s cadence, 10,000 REST
 * calls a month on the Free plan, so every call is recorded in the quota meter BEFORE it is sent
 * (a call that times out still counts against the quota).
 *
 *  - Vehicles: the county feed's `vehicle_positions.pb` (about 56 KB), GTFS-realtime protobuf.
 *  - Predictions: per-STOP departures JSON for the next hour (about 18 KB each). A station is asked
 *    for stop by stop (Government Center rail = 9512 + 9513), one after another; the first failure
 *    fails the station's poll, so a half-answered station never looks complete. Its whole-agency
 *    trip-updates download (1 MB a poll, falsifier R19) is never fetched.
 */

export const TRANSITLAND_CAPABILITIES: Capabilities = Object.freeze({ vehicles: true, predictions: true });

export function createTransitlandProvider(deps: ProviderDeps): LiveProvider {
  invariant(typeof deps.get === 'function' && typeof deps.recordCall === 'function', 'the provider sends requests and meters them');
  const provider: LiveProvider = {
    id: 'transitland',
    capabilities: TRANSITLAND_CAPABILITIES,
    fetchVehicles: (signal) => fetchVehicles(deps, signal),
    fetchPredictions: (stationKey, signal) => fetchPredictions(deps, stationKey, signal),
  };
  invariant(provider.capabilities.vehicles && provider.capabilities.predictions, 'Transitland serves vehicles and predictions');
  return provider;
}

async function fetchVehicles(deps: ProviderDeps, signal: AbortSignal): Promise<LiveResult<LiveVehicle>> {
  invariant(!signal.aborted, 'a poll starts under a live runtime');
  const request = transitlandVehiclesRequest(deps.keys().transitland);
  if (!request.ok) {
    return request;
  }
  deps.recordCall('transitland');
  const body = await deps.get(request.value, signal);
  const batch = body.ok ? vehiclesBatch(body.value, deps.network) : body;
  invariant(!batch.ok || batch.value.provider === 'transitland', 'the batch is Transitland\'s');
  return batch;
}

async function fetchPredictions(deps: ProviderDeps, stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>> {
  const stops = deps.network.stopsOfStation(stationKey);
  invariant(stops.length > 0, `${stationKey} is a station of the schedule, with stops`);
  const batches: LiveBatch<LivePrediction>[] = [];
  for (const stopId of stops) {
    const request = transitlandDeparturesRequest(deps.keys().transitland, stopId);
    if (!request.ok) {
      return request;
    }
    deps.recordCall('transitland');
    const body = await deps.get(request.value, signal);
    const batch = body.ok ? departuresBatch(body.value, deps.network) : body;
    if (!batch.ok) {
      return batch;
    }
    batches.push(batch.value);
  }
  invariant(batches.length === stops.length, 'every stop of the station answered');
  return ok(combineBatches(batches));
}
