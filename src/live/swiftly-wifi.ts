import Storage from 'expo-sqlite/kv-store';

import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import type { SyncKeyValue } from './quota-store';

/**
 * mfix10 (Jamie, 2026-10-02: "have a setting in app that's like use swiftly only on wifi"): the
 * rider's "Use Swiftly only on Wi-Fi", kept in expo-sqlite/kv-store under ONE item, as `true` or
 * `false`, read synchronously (like walking-pace.ts and the quota meter). It is ON by default:
 * Swiftly's predictions come from its whole-agency trip-updates feed, hundreds of KB per poll (plan
 * risk R19). Nothing is written until the rider toggles, and an item this module would not have
 * written reads as the default. The live runtime owns the setting and reads it at every poll tick
 * (runtime.ts); Data & Settings shows it and saves the rider's toggle.
 */

export type WifiOnlyError = { readonly kind: 'storage'; readonly message: string };

export const DEFAULT_SWIFTLY_WIFI_ONLY = true;

/** The kv-store item holding the setting. */
export const SWIFTLY_WIFI_ONLY_ITEM = 'settings.swiftly-wifi-only';

/** The setting in effect: the stored value, or the default (ON) when nothing readable is stored. */
export function readSwiftlyWifiOnly(store: SyncKeyValue = Storage): boolean {
  invariant(typeof store.getItemSync === 'function', 'the setting is read synchronously from the kv store');
  const stored = store.getItemSync(SWIFTLY_WIFI_ONLY_ITEM);
  invariant(stored === null || typeof stored === 'string', 'the kv store answers a string, or null for no item');
  return stored === 'true' ? true : stored === 'false' ? false : DEFAULT_SWIFTLY_WIFI_ONLY;
}

/** Stores the setting in its one item and returns it as read back; a kv-store failure is a `storage` error and stores nothing. */
export function saveSwiftlyWifiOnly(value: boolean, store: SyncKeyValue = Storage): Result<boolean, WifiOnlyError> {
  invariant(typeof value === 'boolean', 'the setting is on or off');
  invariant(typeof store.setItemSync === 'function', 'the setting is written synchronously to the kv store');
  try {
    store.setItemSync(SWIFTLY_WIFI_ONLY_ITEM, String(value));
  } catch (error) {
    return err({ kind: 'storage', message: `could not save the Wi-Fi only setting: ${error instanceof Error ? error.message : String(error)}` });
  }
  const back = readSwiftlyWifiOnly(store);
  invariant(back === value, 'the saved setting reads back');
  return ok(back);
}
