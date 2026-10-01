import { initialChainState, resolveProvider } from '../../domain/live/chain';
import { InvariantError } from '../../lib/invariant';
import { callsThisMonth, type QuotaStore, quotaKey, recordCall } from '../quota';

/**
 * M4.4: the monthly quota meter over an in-memory QuotaStore (the runtime's store is
 * expo-sqlite/kv-store, arbiter ruling R-a). Instants are built with Date.UTC, independently of
 * the meter's own month arithmetic.
 */

const OCT_1 = Date.UTC(2026, 9, 1, 12, 0, 0) / 1000;
const OCT_31_LAST_SECOND = Date.UTC(2026, 9, 31, 23, 59, 59) / 1000;
const NOV_1_FIRST_SECOND = Date.UTC(2026, 10, 1, 0, 0, 0) / 1000;

/** A QuotaStore over a Map, exposing its contents for assertions. */
function memoryStore(initial: readonly (readonly [string, number])[] = []): QuotaStore & { readonly entries: Map<string, number> } {
  const entries = new Map<string, number>(initial);
  const store = { entries, get: (key: string) => entries.get(key) ?? null, set: (key: string, count: number) => void entries.set(key, count) };
  expect(store.get('absent')).toBeNull();
  expect(entries.size).toBe(initial.length);
  return store;
}

describe('quota meter (M4.4)', () => {
  it('counts calls: each recorded call adds one to this month\'s count, per provider', () => {
    const store = memoryStore();
    expect(callsThisMonth(store, 'transitland', OCT_1)).toBe(0);
    expect([1, 2, 3].map(() => recordCall(store, 'transitland', OCT_1))).toEqual([1, 2, 3]);
    expect(recordCall(store, 'swiftly', OCT_1)).toBe(1);
    expect(callsThisMonth(store, 'transitland', OCT_1 + 86_400)).toBe(3);
    expect([...store.entries]).toEqual([
      ['quota.transitland.202610', 3],
      ['quota.swiftly.202610', 1],
    ]);
  });

  it('counts calls: the count lives in the store (so it survives a restart) and the chain reads it — 9499 kept, 9500 skipped', () => {
    const store = memoryStore([['quota.transitland.202610', 9_498]]);
    expect(recordCall(store, 'transitland', OCT_1)).toBe(9_499);
    expect(resolveProvider(initialChainState(), 'vehicles', standingsAt(callsThisMonth(store, 'transitland', OCT_1)), OCT_1)).toBe('transitland');
    expect(recordCall(store, 'transitland', OCT_1)).toBe(9_500);
    expect(resolveProvider(initialChainState(), 'vehicles', standingsAt(callsThisMonth(store, 'transitland', OCT_1)), OCT_1)).toBe('none');
  });

  it('resets on the 1st of the month (UTC): 23:59:59 on Oct 31 counts in October, 00:00:00 on Nov 1 starts at 0', () => {
    const store = memoryStore([['quota.transitland.202610', 9_600]]);
    expect(recordCall(store, 'transitland', OCT_31_LAST_SECOND)).toBe(9_601);
    expect(callsThisMonth(store, 'transitland', NOV_1_FIRST_SECOND)).toBe(0);
    expect(recordCall(store, 'transitland', NOV_1_FIRST_SECOND)).toBe(1);
    expect(store.entries.get('quota.transitland.202610')).toBe(9_601);
  });

  it('resets on the 1st across a year: December 2026 and January 2027 are separate months', () => {
    expect(quotaKey('transitland', Date.UTC(2026, 11, 31, 23, 59, 59) / 1000)).toBe('quota.transitland.202612');
    expect(quotaKey('transitland', Date.UTC(2027, 0, 1, 0, 0, 0) / 1000)).toBe('quota.transitland.202701');
  });

  it('a store that does not keep what was written fails loudly instead of under-counting', () => {
    const forgetful: QuotaStore = { get: () => null, set: () => undefined };
    expect(() => recordCall(forgetful, 'transitland', OCT_1)).toThrow(InvariantError);
    expect(() => callsThisMonth({ get: () => -1, set: () => undefined }, 'transitland', OCT_1)).toThrow(InvariantError);
  });
});

/** Transitland the only keyed provider, at `calls` this month. */
function standingsAt(calls: number) {
  const ready = { hasKey: true, capabilities: { vehicles: true, predictions: true }, callsThisMonth: calls };
  expect(calls).toBeGreaterThanOrEqual(0);
  expect(ready.callsThisMonth).toBe(calls);
  return { swiftly: { ...ready, hasKey: false, callsThisMonth: 0 }, transitland: ready };
}
