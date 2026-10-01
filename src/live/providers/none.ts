import type { Capabilities, LiveError, LivePrediction, LiveProvider, LiveResult, LiveVehicle } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { err } from '../../lib/result';

/**
 * Plan §3: the end of the provider chain, swiftly ▸ transitland ▸ NONE. `none` is what the chain
 * resolves to when no provider is available (no key, or a quota spent): the app shows the schedule
 * alone. It sits in the runtime's provider table beside the real providers, and it offers no
 * capability — which is exactly why the poller (which polls a serving provider only for what it
 * offers) never polls while the chain is at its end. Asked for data anyway, it answers — honestly,
 * without a request — that no realtime provider is available.
 */

export const NONE_CAPABILITIES: Capabilities = Object.freeze({ vehicles: false, predictions: false });

const NO_PROVIDER: LiveError = Object.freeze({
  kind: 'no-key',
  message: 'no realtime provider is available (no key, or its monthly quota is spent) — showing the schedule',
});

function unavailable<T>(): Promise<LiveResult<T>> {
  invariant(NO_PROVIDER.kind === 'no-key', 'the chain end reports a missing provider');
  const result = err(NO_PROVIDER);
  invariant(!result.ok, 'the chain end never returns data');
  return Promise.resolve(result);
}

export const NONE_PROVIDER: LiveProvider = Object.freeze({
  id: 'none',
  capabilities: NONE_CAPABILITIES,
  fetchVehicles: () => unavailable<LiveVehicle>(),
  fetchPredictions: () => unavailable<LivePrediction>(),
});
