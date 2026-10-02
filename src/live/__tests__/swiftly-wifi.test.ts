import type { KvStoreFake } from '../../ui/settings/__tests__/native-fakes';
import type { SyncKeyValue } from '../quota-store';
import { DEFAULT_SWIFTLY_WIFI_ONLY, readSwiftlyWifiOnly, saveSwiftlyWifiOnly, SWIFTLY_WIFI_ONLY_ITEM } from '../swiftly-wifi';

// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../ui/settings/__tests__/native-fakes').kvStoreModule());

/**
 * mfix10: "Use Swiftly only on Wi-Fi", kept in expo-sqlite/kv-store (mocked here: it is a native module)
 * under ONE item. ON by default, and ON for any stored value the setting would not have written.
 */

const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');

beforeEach(() => kv.map.clear());

describe('the Wi-Fi only setting (mfix10): its default', () => {
  it('the wi-fi only setting is on when its item is empty or unreadable', () => {
    expect(DEFAULT_SWIFTLY_WIFI_ONLY).toBe(true);
    expect(readSwiftlyWifiOnly()).toBe(true);
    expect(readSwiftlyWifiOnly({ getItemSync: () => null, setItemSync: () => undefined })).toBe(true); // a store given in place of kv-store, holding nothing
    for (const junk of ['', 'garbage', '{"wifiOnly":', 'yes please', '[]', '2', '0', 'False', ' false', 'null']) {
      kv.map.set(SWIFTLY_WIFI_ONLY_ITEM, junk);
      expect([junk, readSwiftlyWifiOnly()]).toEqual([junk, true]);
    }
  });
});

describe('the Wi-Fi only setting (mfix10): saving it', () => {
  it('the wi-fi only setting round-trips through one kv item', () => {
    for (const value of [false, true, false]) {
      expect(saveSwiftlyWifiOnly(value)).toEqual({ ok: true, value });
      expect([...kv.map]).toEqual([[SWIFTLY_WIFI_ONLY_ITEM, String(value)]]);
      expect(readSwiftlyWifiOnly()).toBe(value);
    }
    expect(SWIFTLY_WIFI_ONLY_ITEM).toBe('settings.swiftly-wifi-only');
    const map = new Map<string, string>(); // a store given in place of kv-store
    expect(saveSwiftlyWifiOnly(false, { getItemSync: (key) => map.get(key) ?? null, setItemSync: (key, value) => void map.set(key, value) })).toEqual({ ok: true, value: false });
    expect([...map]).toEqual([[SWIFTLY_WIFI_ONLY_ITEM, 'false']]);
  });

  it('a kv store that refuses the write keeps the setting as it was and says why', () => {
    const store: SyncKeyValue = {
      getItemSync: () => null,
      setItemSync: () => {
        throw new Error('disk full');
      },
    };
    expect(saveSwiftlyWifiOnly(false, store)).toEqual({ ok: false, error: { kind: 'storage', message: 'could not save the Wi-Fi only setting: disk full' } });
    expect(readSwiftlyWifiOnly(store)).toBe(true);
  });
});
