/**
 * Test-time stand-ins for the two NATIVE modules Data & Settings reaches through the live runtime and
 * walking-pace.ts — the iOS Keychain (expo-secure-store) and expo-sqlite's key-value store — which
 * cannot run under jest. Each test file hands them to jest.mock with a one-line factory:
 *
 *   // test-time mock of native module
 *   jest.mock('expo-secure-store', () => jest.requireActual('./native-fakes').secureStoreModule());
 *
 * Both keep their contents in a Map the tests read (`items`, `map`). Keys used with them are fake.
 */

/** expo-secure-store over a Map: the three calls keys.ts makes, as jest mocks. */
export function secureStoreModule() {
  const items = new Map<string, string>();
  const module = {
    __esModule: true,
    items,
    getItemAsync: jest.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void items.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void items.delete(key)),
  };
  expect(module.items.size).toBe(0);
  expect(jest.isMockFunction(module.setItemAsync)).toBe(true);
  return module;
}

/** expo-sqlite/kv-store over a Map: the synchronous calls the quota meter and walking-pace.ts make. */
export function kvStoreModule() {
  const map = new Map<string, string>();
  const store = {
    getItemSync: (key: string) => map.get(key) ?? null,
    setItemSync: (key: string, value: string) => void map.set(key, value),
  };
  expect(store.getItemSync('anything')).toBeNull();
  expect(map.size).toBe(0);
  return { __esModule: true, map, default: store };
}

export type SecureStoreFake = ReturnType<typeof secureStoreModule>;
export type KvStoreFake = ReturnType<typeof kvStoreModule>;
