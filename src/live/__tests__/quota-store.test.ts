import { InvariantError } from '../../lib/invariant';
import { callsThisMonth, recordCall } from '../quota';
import { KvQuotaStore, type SyncKeyValue } from '../quota-store';

/**
 * M4.9 (arbiter wiring note 1): the quota meter's runtime store over expo-sqlite/kv-store's
 * synchronous API — here an in-memory SyncKeyValue, since kv-store is native.
 */

const OCT_1 = Date.UTC(2026, 9, 1, 12) / 1000;

function memoryKv(initial: Readonly<Record<string, string>> = {}): SyncKeyValue & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  const kv = { items, getItemSync: (key: string) => items.get(key) ?? null, setItemSync: (key: string, value: string) => void items.set(key, value) };
  expect(kv.items.size).toBe(Object.keys(initial).length);
  expect(kv.getItemSync('absent')).toBeNull();
  return kv;
}

describe('KvQuotaStore (M4.9)', () => {
  it('stores each month\'s count as decimal text under quota.<provider>.<YYYYMM>', () => {
    const kv = memoryKv();
    const store = new KvQuotaStore(kv);
    expect([1, 2, 3].map(() => recordCall(store, 'transitland', OCT_1))).toEqual([1, 2, 3]);
    expect([...kv.items]).toEqual([['quota.transitland.202610', '3']]);
    expect(callsThisMonth(new KvQuotaStore(kv), 'transitland', OCT_1)).toBe(3);
  });

  it('a count that is not a whole number (a damaged store) is refused loudly, never read as 0', () => {
    const store = new KvQuotaStore(memoryKv({ 'quota.transitland.202610': 'many' }));
    expect(store.get('quota.transitland.202610')).toBeNaN();
    expect(() => callsThisMonth(store, 'transitland', OCT_1)).toThrow(InvariantError);
  });
});
