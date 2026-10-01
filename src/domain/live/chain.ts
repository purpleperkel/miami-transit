import { invariant } from '../../lib/invariant';
import { FAILOVER_AFTER_FAILURES, quotaSkipAt, REPROBE_AFTER_S } from './constants';
import { type Capabilities, type Capability, type ChainProviderId, PROVIDER_IDS, type ProviderId } from './types';

/**
 * Plan M4.4: the provider chain swiftly ▸ transitland ▸ none, resolved PER CAPABILITY — the vehicles
 * chain and the predictions chain are independent (e.g. Swiftly vehicles + Transitland predictions,
 * when Swiftly's predictions fail). Pure: the caller passes each provider's standing and the time.
 *
 * A provider is AVAILABLE for a capability when it has a key, offers the capability, and has used
 * under 95% of its monthly quota (Transitland: skipped at 9,500 of 10,000 calls). Among the available
 * providers, in chain order:
 *   - A provider that has failed FAILOVER_AFTER_FAILURES (3) times in a row is BENCHED until
 *     REPROBE_AFTER_S (300 s) after its last failure, and the next available, unbenched provider
 *     serves. Then it is tried again (re-probed): one success clears its record, one more failure
 *     benches it for another 300 s.
 *   - Arbiter follow-up (2026-10-01): the 300 s bench applies ONLY when another available provider
 *     can take over. With nothing to fail over to, the failing provider stays active and keeps
 *     retrying on the scheduler's clamped backoff (Transitland 60, 60, 60, 120, … s), reported as
 *     `failing` so the UI says its data is stale ("Live · N min old", "Live data unavailable") and
 *     never shows it as fresh. Realtime is the requirement: the chain never parks on `none` while an
 *     available provider exists.
 * `none` (the schedule alone) serves only when no provider is available at all.
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

/** Who serves a capability now, and whether that provider is failing (its data is stale, never fresh). */
export type ChainResolution = {
  readonly provider: ChainProviderId;
  /** The serving provider has failed FAILOVER_AFTER_FAILURES or more times in a row (false for `none`). */
  readonly failing: boolean;
  /** The serving provider's consecutive failures for this capability (0 for `none`). */
  readonly consecutiveFailures: number;
};

const CLEAN: FailureRecord = Object.freeze({ consecutive: 0, lastFailureAt: null });

export function initialChainState(): ChainState {
  const records = Object.freeze({ swiftly: CLEAN, transitland: CLEAN });
  const state: ChainState = Object.freeze({ vehicles: records, predictions: records });
  invariant(PROVIDER_IDS.every((id) => state.vehicles[id] === CLEAN && state.predictions[id] === CLEAN), 'every provider starts clean');
  invariant(Object.isFrozen(state), 'chain state is immutable');
  return state;
}

/** Who serves `capability` at `nowS`: the first available unbenched provider, else the first available one (failing), else `none`. */
export function resolveChain(state: ChainState, capability: Capability, standings: Standings, nowS: number): ChainResolution {
  invariant(Number.isFinite(nowS), 'the chain is asked at an instant');
  invariant(PROVIDER_IDS.every((id) => standings[id] !== undefined), 'every provider has a standing');
  const available = PROVIDER_IDS.filter((id) => unavailableReason(capability, id, standings[id]) === null);
  const unbenched = available.filter((id) => !isBenched(state, capability, id, nowS));
  const provider: ChainProviderId = unbenched[0] ?? available[0] ?? 'none';
  const consecutiveFailures = provider === 'none' ? 0 : state[capability][provider].consecutive;
  const resolution = { provider, failing: consecutiveFailures >= FAILOVER_AFTER_FAILURES, consecutiveFailures };
  invariant(provider !== 'none' || available.length === 0, 'the chain never falls back to none while a provider is available');
  return resolution;
}

/** The provider that serves `capability` now (resolveChain's provider). */
export function resolveProvider(state: ChainState, capability: Capability, standings: Standings, nowS: number): ChainProviderId {
  const { provider } = resolveChain(state, capability, standings, nowS);
  invariant(provider === 'none' || standings[provider].hasKey, 'only a keyed provider serves');
  invariant(provider === 'none' || standings[provider].capabilities[capability], `the serving provider offers ${capability}`);
  return provider;
}

/**
 * Why `provider` is passed over for `capability` at `nowS`, or null when it serves or would serve
 * after the providers ahead of it. `failing` means benched while another available provider serves.
 */
export function skipReason(state: ChainState, capability: Capability, provider: ProviderId, standings: Standings, nowS: number): SkipReason | null {
  invariant(Number.isFinite(nowS), 'the chain is asked at an instant');
  const unavailable = unavailableReason(capability, provider, standings[provider]);
  if (unavailable !== null) {
    return unavailable;
  }
  const passedOver = isBenched(state, capability, provider, nowS) && resolveChain(state, capability, standings, nowS).provider !== provider;
  invariant(!passedOver || resolveChain(state, capability, standings, nowS).provider !== 'none', 'a benched provider is passed over only for another provider');
  return passedOver ? 'failing' : null;
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

/** Why the provider cannot serve the capability at all — no key, not offered, quota spent — failures aside. */
function unavailableReason(capability: Capability, provider: ProviderId, standing: ProviderStanding): Exclude<SkipReason, 'failing'> | null {
  invariant(standing !== undefined, `${provider} has a standing`);
  invariant(Number.isSafeInteger(standing.callsThisMonth) && standing.callsThisMonth >= 0, `${provider}'s call count is a whole number`);
  if (!standing.hasKey) {
    return 'no-key';
  }
  if (!standing.capabilities[capability]) {
    return 'unsupported';
  }
  const skipAt = quotaSkipAt(provider);
  return skipAt !== null && standing.callsThisMonth >= skipAt ? 'quota' : null;
}

/** Three failures in a row, the last under 300 s ago. Benched providers serve only when no other provider can. */
function isBenched(state: ChainState, capability: Capability, provider: ProviderId, nowS: number): boolean {
  const record = state[capability][provider];
  invariant(record.consecutive >= 0, 'a failure count is never negative');
  invariant(record.consecutive === 0 || record.lastFailureAt !== null, 'a failure has a time');
  return record.consecutive >= FAILOVER_AFTER_FAILURES && record.lastFailureAt !== null && nowS - record.lastFailureAt < REPROBE_AFTER_S;
}
