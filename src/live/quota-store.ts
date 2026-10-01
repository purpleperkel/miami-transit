import Storage from 'expo-sqlite/kv-store';

import { invariant } from '../lib/invariant';
import type { QuotaStore } from './quota';

/**
 * The quota meter's runtime store (arbiter ruling R-a, wiring note 1, 2026-10-01): expo-sqlite's
 * key-value store, bundled in Expo Go, through its SYNCHRONOUS getItemSync / setItemSync, under the
 * meter's keys `quota.<provider>.<YYYYMM>`. Counts are stored as decimal text.
 */

/** The synchronous part of expo-sqlite/kv-store this adapter uses (tests pass an in-memory one). */
export type SyncKeyValue = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

const QUOTA_KEY = /^quota\.[a-z]+\.\d{6}$/;

export class KvQuotaStore implements QuotaStore {
  constructor(private readonly storage: SyncKeyValue = Storage) {
    invariant(typeof storage.getItemSync === 'function', 'the store reads synchronously');
    invariant(typeof storage.setItemSync === 'function', 'the store writes synchronously');
  }

  /** The stored count; a value that is not a whole number is returned as NaN, which the meter's invariants reject. */
  get(key: string): number | null {
    invariant(QUOTA_KEY.test(key), `"${key}" is a quota key`);
    const raw = this.storage.getItemSync(key);
    const count = raw === null ? null : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    invariant(count === null || typeof count === 'number', 'a count is a number or absent');
    return count;
  }

  set(key: string, count: number): void {
    invariant(QUOTA_KEY.test(key), `"${key}" is a quota key`);
    invariant(Number.isSafeInteger(count) && count >= 0, `a call count is a whole number, got ${count}`);
    this.storage.setItemSync(key, String(count));
  }
}
