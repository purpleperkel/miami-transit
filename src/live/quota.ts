import { PROVIDER_IDS, type ProviderId } from '../domain/live/types';
import { invariant } from '../lib/invariant';

/**
 * Plan M4.4: the monthly quota meter. Every REST call to a provider is recorded here, and the
 * provider chain reads `callsThisMonth` to skip Transitland at 95% of its 10,000 free calls.
 *
 * STORE (arbiter ruling R-a, 2026-10-01): the meter writes through an injected, SYNCHRONOUS
 * `QuotaStore`. At runtime (M4.9) that is `expo-sqlite/kv-store` — bundled in Expo Go — through its
 * `getItemSync` / `setItemSync` API, under keys `quota.<provider>.<YYYYMM>`. That is the meter's
 * permanent home; user.db (M7.3) is not involved. Tests use an in-memory store.
 *
 * MONTH: the UTC calendar month of the call. Nothing is ever reset or deleted: a new month is a new
 * key, which starts at 0 — so the count "resets on the 1st" by construction, and an old month's
 * count stays readable for Diagnostics. (UTC is assumed to be the provider's billing month; the
 * 95% threshold leaves 500 calls of slack for the hours either side of a month boundary.)
 */

export type QuotaStore = {
  /** The count stored under `key`, or null when nothing has been stored there. */
  get(key: string): number | null;
  set(key: string, count: number): void;
};

/** The store key for `provider`'s calls in the UTC month containing `epochS`, e.g. `quota.transitland.202610`. */
export function quotaKey(provider: ProviderId, epochS: number): string {
  invariant((PROVIDER_IDS as readonly string[]).includes(provider), `"${provider}" is a realtime provider`);
  invariant(Number.isFinite(epochS) && epochS > 0, `a quota month is taken from an instant, got ${epochS}`);
  const at = new Date(epochS * 1000);
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `quota.${provider}.${at.getUTCFullYear()}${month}`;
}

/** Calls recorded for `provider` in the current (UTC) month: 0 in a month with none yet. */
export function callsThisMonth(store: QuotaStore, provider: ProviderId, nowS: number): number {
  const key = quotaKey(provider, nowS);
  const stored = store.get(key);
  invariant(stored === null || (Number.isSafeInteger(stored) && stored >= 0), `the store holds a whole call count under ${key}, got ${String(stored)}`);
  const count = stored ?? 0;
  invariant(count >= 0, 'a call count is never negative');
  return count;
}

/** Records one call to `provider` at `nowS` and returns the month's new count. */
export function recordCall(store: QuotaStore, provider: ProviderId, nowS: number): number {
  invariant(typeof store.get === 'function' && typeof store.set === 'function', 'calls are recorded in a QuotaStore');
  const before = callsThisMonth(store, provider, nowS);
  const key = quotaKey(provider, nowS);
  store.set(key, before + 1);
  const after = callsThisMonth(store, provider, nowS);
  invariant(after === before + 1, `the store kept the new count under ${key} (read back ${after}, expected ${before + 1})`);
  return after;
}
