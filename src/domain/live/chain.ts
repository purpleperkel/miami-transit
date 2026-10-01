import { invariant } from '../../lib/invariant';
import { FAILOVER_AFTER_FAILURES, quotaSkipAt, REPROBE_AFTER_S } from './constants';
import { type Capabilities, type Capability, type ChainProviderId, PROVIDER_IDS, type ProviderId } from './types';

/**
 * Plan M4.4: the provider chain swiftly ▸ transitland ▸ none, resolved PER CAPABILITY — the vehicles
 * chain and the predictions chain are independent (e.g. Swiftly vehicles + Transitland predictions,
 * when Swiftly's predictions fail). Pure: the caller passes each provider's standing and the time.
 *
 * A provider is skipped for a capability when:
 *   - it has no key, or does not offer the capability;
 *   - its monthly quota is ≥ 95% used (Transitland: 9,500 of 10,000 calls);
 *   - it has failed FAILOVER_AFTER_FAILURES (3) times in a row for that capability, until
 *     REPROBE_AFTER_S (300 s) after its last failure. Then it is tried again (re-probed): one success
 *     clears its record, one more failure benches it for another 300 s.
 * The first provider not skipped serves the capability; when every one is skipped, `none` does
 * (the schedule alone).
 */

/** What the chain knows about one provider now: its key (Keychain), what it offers, its quota meter. */
export type ProviderStanding = {
  readonly hasKey: boolean;
  readonly capabilities: Capabilities;
  /** Calls made to it this calendar month (src/live/quota.ts); ignored for a provider without a quota. */
  readonly callsThisMonth: number;
};

export type Standings = Readonly<Record<ProviderId, ProviderStanding>>;

/** One provider's consecutive failures for one capability, and when the last one happened (epoch s). */
export type FailureRecord = { readonly consecutive: number; readonly lastFailureAt: number | null };
export type ChainState = Readonly<Record<Capability, Readonly<Record<ProviderId, FailureRecord>>>>;

export type SkipReason = 'no-key' | 'unsupported' | 'quota' | 'failing';
export type PollResult = 'ok' | 'failed';

const CLEAN: FailureRecord = Object.freeze({ consecutive: 0, lastFailureAt: null });

export function initialChainState(): ChainState {
  const records = Object.freeze({ swiftly: CLEAN, transitland: CLEAN });
  const state: ChainState = Object.freeze({ vehicles: records, predictions: records });
  invariant(PROVIDER_IDS.every((id) => state.vehicles[id] === CLEAN && state.predictions[id] === CLEAN), 'every provider starts clean');
  invariant(Object.isFrozen(state), 'chain state is immutable');
  return state;
}

/** Why `provider` is skipped for `capability` at `nowS`, or null when it may serve. */
export function skipReason(state: ChainState, capability: Capability, provider: ProviderId, standing: ProviderStanding, nowS: number): SkipReason | null {
  invariant(Number.isFinite(nowS), 'the chain is asked at an instant');
  invariant(Number.isSafeInteger(standing.callsThisMonth) && standing.callsThisMonth >= 0, `${provider}'s call count is a whole number`);
  if (!standing.hasKey) {
    return 'no-key';
  }
  if (!standing.capabilities[capability]) {
    return 'unsupported';
  }
  const skipAt = quotaSkipAt(provider);
  if (skipAt !== null && standing.callsThisMonth >= skipAt) {
    return 'quota';
  }
  const record = state[capability][provider];
  const benched = record.consecutive >= FAILOVER_AFTER_FAILURES && record.lastFailureAt !== null && nowS - record.lastFailureAt < REPROBE_AFTER_S;
  return benched ? 'failing' : null;
}

/** The provider that serves `capability` now: the first in chain order that is not skipped, else `none`. */
export function resolveProvider(state: ChainState, capability: Capability, standings: Standings, nowS: number): ChainProviderId {
  invariant(Number.isFinite(nowS), 'the chain is asked at an instant');
  invariant(PROVIDER_IDS.every((id) => standings[id] !== undefined), 'every provider has a standing');
  const chosen = PROVIDER_IDS.find((id) => skipReason(state, capability, id, standings[id], nowS) === null);
  return chosen ?? 'none';
}

/** The state after `provider` answered (or failed) a `capability` poll at `nowS`. Other capabilities are untouched. */
export function recordPoll(state: ChainState, capability: Capability, provider: ProviderId, result: PollResult, nowS: number): ChainState {
  invariant(Number.isFinite(nowS), 'a poll ends at an instant');
  const before = state[capability][provider];
  invariant(before.lastFailureAt === null || nowS >= before.lastFailureAt, 'polls are recorded in time order');
  const after: FailureRecord = result === 'ok' ? CLEAN : Object.freeze({ consecutive: before.consecutive + 1, lastFailureAt: nowS });
  const records = Object.freeze({ ...state[capability], [provider]: after });
  const next: ChainState = Object.freeze({ ...state, [capability]: records });
  const other: Capability = capability === 'vehicles' ? 'predictions' : 'vehicles';
  invariant(next[other] === state[other], 'the other capability\'s chain is independent');
  return next;
}
