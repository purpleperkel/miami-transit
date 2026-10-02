import { PROVIDER_CONFIG, QUOTA_SKIP_PERCENT, quotaSkipAt } from '@/domain/live/constants';
import { type Capability, type ChainProviderId, PROVIDER_IDS, type ProviderId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import type { LiveState } from '@/live/runtime';

import { formatAge, formatBytes, PROVIDER_NAMES } from './settings-text';

/**
 * Plan M8b.1 "A status row shows live / failing / stale, the last update age, bytes per poll": one
 * provider's health, read from the live state alone.
 *
 *   starting  the runtime has not published yet
 *   off       no key in the Keychain
 *   gated     Swiftly, held back by "Use Swiftly only on Wi-Fi" while the phone is off Wi-Fi (mfix10):
 *             by design, not a failure, so nothing is appended (the chain passes it over as if it had no key)
 *   paused    its monthly quota is 95% used, so the chain skips it until the month turns
 *   failing   it failed 3+ polls in a row (chain.ts): either it still serves and its data is stale,
 *             or the chain benched it and a provider after it serves instead
 *   standby   keyed and well, but a provider ahead of it in the chain serves everything
 *   waiting   it serves, but no answer has arrived yet
 *   live      it serves, and its latest data is within its fresh threshold (§3)
 *   stale     it serves, and its latest data is older than that
 *
 * "Benched" is read from the chain order: the chain passes over a keyed, ungated provider with quota
 * left only when it is benched for failing (both providers offer vehicles and predictions — their own
 * modules assert it), so a provider AFTER it serving a capability means it is failing there. A gated
 * Swiftly is passed over too, which is why `gated` is decided before `failing`.
 */

export type HealthKind = 'starting' | 'off' | 'gated' | 'paused' | 'failing' | 'standby' | 'waiting' | 'live' | 'stale';
export type ProviderHealth = { readonly kind: HealthKind; readonly text: string };

const CAPABILITIES: readonly Capability[] = ['vehicles', 'predictions'];

const HEADLINES: Readonly<Record<HealthKind, string>> = Object.freeze({
  starting: 'Starting…',
  off: 'Off · no key',
  gated: 'Paused · not on Wi-Fi',
  paused: `Paused · ${QUOTA_SKIP_PERCENT}% of the monthly quota used`,
  failing: 'Failing',
  standby: 'Standby',
  waiting: 'Waiting for the first update',
  live: 'Live',
  stale: 'Stale',
});

/** `provider`'s health at `nowS` (epoch s): its state, the age of its latest data, and its bytes per poll. */
export function providerHealth(state: LiveState | null, provider: ProviderId, nowS: number): ProviderHealth {
  invariant(Number.isFinite(nowS), 'health is judged at an instant');
  const kind = state === null ? 'starting' : healthKind(state, provider, nowS);
  const details = state === null || kind === 'off' || kind === 'gated' ? [] : healthDetails(state, provider, kind, nowS);
  const health = { kind, text: [HEADLINES[kind], ...details].join(' · ') };
  invariant(health.text.startsWith(HEADLINES[kind]), 'a status row leads with the state');
  return health;
}

/** What follows the state: why (failing, standby), how old the latest data is, and the bytes per poll this session. */
function healthDetails(state: LiveState, provider: ProviderId, kind: HealthKind, nowS: number): string[] {
  const updatedAt = lastUpdateAt(state, provider);
  const tally = state.bytes[provider];
  invariant(tally.responses >= 0 && tally.bytes >= 0, 'the byte counter never runs negative');
  const details = [
    reason(state, provider, kind),
    updatedAt === null ? null : `updated ${formatAge(nowS - updatedAt)}`,
    tally.responses === 0 ? null : `${formatBytes(tally.bytes / tally.responses)} per poll`,
  ].filter((detail): detail is string => detail !== null);
  invariant(details.length <= 3, 'at most a reason, an age and a size follow the state');
  return details;
}

function healthKind(state: LiveState, provider: ProviderId, nowS: number): HealthKind {
  invariant(PROVIDER_IDS.includes(provider), `"${provider}" is a realtime provider`);
  const skipAt = quotaSkipAt(provider);
  const serving = CAPABILITIES.filter((capability) => state.status[capability].provider === provider);
  const updatedAt = lastUpdateAt(state, provider);
  let kind: HealthKind;
  if (!state.hasKey[provider]) {
    kind = 'off';
  } else if (provider === 'swiftly' && state.swiftlyGated) {
    kind = 'gated';
  } else if (skipAt !== null && state.callsThisMonth[provider] >= skipAt) {
    kind = 'paused';
  } else if (failingCapabilities(state, provider).length > 0) {
    kind = 'failing';
  } else if (serving.length === 0) {
    // Before the first heartbeat every capability still reads `none`; after it, someone else serves.
    kind = CAPABILITIES.every((capability) => state.status[capability].provider === 'none') ? 'waiting' : 'standby';
  } else if (updatedAt === null) {
    kind = 'waiting';
  } else {
    kind = nowS - updatedAt <= PROVIDER_CONFIG[provider].freshS ? 'live' : 'stale';
  }
  invariant(kind !== 'live' || serving.length > 0, 'only a serving provider is live');
  return kind;
}

/** The capabilities `provider` is failing: it serves and has failed 3+ times, or the chain benched it for one after it. */
function failingCapabilities(state: LiveState, provider: ProviderId): Capability[] {
  invariant(state.hasKey[provider], 'only a keyed provider can fail');
  const failing = CAPABILITIES.filter((capability) => {
    const status = state.status[capability];
    return (status.provider === provider && status.failing) || chainRank(status.provider) > chainRank(provider);
  });
  invariant(failing.length <= CAPABILITIES.length, 'a provider fails at most every capability');
  return failing;
}

/** A provider's place in the chain (swiftly 0, transitland 1); `none` serves nothing, so it ranks first (never after). */
function chainRank(provider: ChainProviderId): number {
  const rank = provider === 'none' ? -1 : PROVIDER_IDS.indexOf(provider);
  invariant(rank >= -1 && rank < PROVIDER_IDS.length, `"${provider}" is in the chain`);
  invariant(provider !== 'none' || rank === -1, 'none ranks before every provider');
  return rank;
}

/** When `provider`'s latest batch (vehicles or any watched station's predictions) arrived, or null if none has. */
function lastUpdateAt(state: LiveState, provider: ProviderId): number | null {
  invariant(state.predictions instanceof Map, 'predictions are kept per station');
  let latest: number | null = null;
  for (const batch of [state.vehicles, ...state.predictions.values()]) {
    if (batch !== null && batch.provider === provider) {
      latest = latest === null ? batch.fetchedAt : Math.max(latest, batch.fetchedAt);
    }
  }
  invariant(latest === null || Number.isFinite(latest), 'an update happened at an instant');
  return latest;
}

/** Why a provider is failing (its latest error, else the capabilities it was benched for) or on standby (who serves); else null. */
function reason(state: LiveState, provider: ProviderId, kind: HealthKind): string | null {
  invariant(kind !== 'starting', 'a published state is past starting');
  let why: string | null = null;
  if (kind === 'failing') {
    const failing = failingCapabilities(state, provider);
    const lastError = failing.map((capability) => state.status[capability].lastError).find((error) => error !== null) ?? null;
    why = lastError !== null ? lastError.message : `benched for ${failing.join(' and ')}`;
  } else if (kind === 'standby') {
    const others = PROVIDER_IDS.filter((id) => id !== provider && CAPABILITIES.some((capability) => state.status[capability].provider === id));
    invariant(others.length > 0, 'a provider on standby stands behind one that serves');
    why = `${others.map((id) => PROVIDER_NAMES[id]).join(' and ')} serves`;
  }
  invariant(why === null || why.length > 0, 'a reason says something');
  return why;
}
