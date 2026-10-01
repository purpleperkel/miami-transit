import { clearKey, keyItem, readKey, readLiveKeys, readSwiftlyAgency, saveKey, saveSwiftlyAgency, type SecretStore, SWIFTLY_AGENCY_ITEM } from '../keys';

/**
 * M4.8: keys.ts over an in-memory SecretStore standing in for the iOS Keychain (expo-secure-store
 * is the runtime store). Keys are obviously fake test strings.
 */

/** A SecretStore over a Map, exposing its items for assertions. */
function memoryKeychain(initial: Readonly<Record<string, string>> = {}): SecretStore & { readonly items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  const store = {
    items,
    getItemAsync: (key: string) => Promise.resolve(items.get(key) ?? null),
    setItemAsync: (key: string, value: string) => Promise.resolve(void items.set(key, value)),
    deleteItemAsync: (key: string) => Promise.resolve(void items.delete(key)),
  };
  expect(store.items.size).toBe(Object.keys(initial).length);
  expect(typeof store.getItemAsync).toBe('function');
  return store;
}

/** A Keychain whose every call rejects, as expo-secure-store does when the item is not accessible. */
function lockedKeychain(): SecretStore {
  const locked = new Error('User interaction is not allowed.');
  const store = {
    getItemAsync: () => Promise.reject(locked),
    setItemAsync: () => Promise.reject(locked),
    deleteItemAsync: () => Promise.reject(locked),
  };
  expect(locked.message.length).toBeGreaterThan(0);
  expect(typeof store.setItemAsync).toBe('function');
  return store;
}

describe('keys (M4.8, Keychain only)', () => {
  it('stores each provider\'s key under live.key.<provider>', async () => {
    const keychain = memoryKeychain();
    expect(keyItem('swiftly')).toBe('live.key.swiftly');
    expect(keyItem('transitland')).toBe('live.key.transitland');
    await expect(saveKey('transitland', 'fake-transitland-key', keychain)).resolves.toEqual({ ok: true, value: 'fake-transitland-key' });
    expect([...keychain.items]).toEqual([['live.key.transitland', 'fake-transitland-key']]);
    await expect(readKey('transitland', keychain)).resolves.toEqual({ ok: true, value: 'fake-transitland-key' });
    await expect(readKey('swiftly', keychain)).resolves.toEqual({ ok: true, value: null });
  });

  it('a pasted key is trimmed; a blank paste or one with inner whitespace is refused and stores nothing', async () => {
    const keychain = memoryKeychain({ 'live.key.swiftly': 'fake-good-key' });
    await expect(saveKey('swiftly', '  fake-new-key\n', keychain)).resolves.toEqual({ ok: true, value: 'fake-new-key' });
    const blank = await saveKey('swiftly', '   ', keychain);
    const broken = await saveKey('swiftly', 'fake-half\nkey', keychain);
    expect(!blank.ok && blank.error.kind).toBe('invalid-key');
    expect(!broken.ok && broken.error).toEqual({ kind: 'invalid-key', message: 'the pasted swiftly key has whitespace inside it — copy it again' });
    expect(keychain.items.get('live.key.swiftly')).toBe('fake-new-key');
  });

  it('clearKey removes only that provider\'s key', async () => {
    const keychain = memoryKeychain({ 'live.key.swiftly': 'fake-a', 'live.key.transitland': 'fake-b', [SWIFTLY_AGENCY_ITEM]: 'miami' });
    await expect(clearKey('swiftly', keychain)).resolves.toEqual({ ok: true, value: null });
    expect([...keychain.items.keys()].sort()).toEqual(['live.agency.swiftly', 'live.key.transitland']);
    await expect(readKey('swiftly', keychain)).resolves.toEqual({ ok: true, value: null });
  });

  it('a stored blank value reads as no key', async () => {
    const keychain = memoryKeychain({ 'live.key.transitland': '  ' });
    await expect(readKey('transitland', keychain)).resolves.toEqual({ ok: true, value: null });
    expect(keychain.items.size).toBe(1);
  });

  it('the Swiftly agency key defaults to miami, is stored when pasted, and a blank paste restores the default', async () => {
    const keychain = memoryKeychain();
    await expect(readSwiftlyAgency(keychain)).resolves.toEqual({ ok: true, value: 'miami' });
    await expect(saveSwiftlyAgency(' mdt-agency ', keychain)).resolves.toEqual({ ok: true, value: 'mdt-agency' });
    await expect(readSwiftlyAgency(keychain)).resolves.toEqual({ ok: true, value: 'mdt-agency' });
    const refused = await saveSwiftlyAgency('miami/../x', keychain);
    expect(!refused.ok && refused.error.kind).toBe('invalid-key');
    await expect(saveSwiftlyAgency('', keychain)).resolves.toEqual({ ok: true, value: 'miami' });
    expect(keychain.items.has(SWIFTLY_AGENCY_ITEM)).toBe(false);
  });

  it('readLiveKeys reads every credential at once', async () => {
    const keychain = memoryKeychain({ 'live.key.transitland': 'fake-t', [SWIFTLY_AGENCY_ITEM]: 'miami' });
    await expect(readLiveKeys(keychain)).resolves.toEqual({ ok: true, value: { swiftly: null, transitland: 'fake-t', swiftlyAgency: 'miami' } });
    await expect(readLiveKeys(memoryKeychain())).resolves.toEqual({ ok: true, value: { swiftly: null, transitland: null, swiftlyAgency: 'miami' } });
  });

  it('a Keychain that rejects (device locked) gives a keychain error value from every call, never a rejection', async () => {
    const keychain = lockedKeychain();
    const reads = await Promise.all([readKey('swiftly', keychain), readSwiftlyAgency(keychain), readLiveKeys(keychain)]);
    const writes = await Promise.all([saveKey('transitland', 'fake-key', keychain), clearKey('transitland', keychain), saveSwiftlyAgency('miami', keychain)]);
    expect([...reads, ...writes].map((result) => !result.ok && result.error.kind)).toEqual(Array(6).fill('keychain'));
    expect(!reads[0].ok && reads[0].error.message).toBe('could not read the swiftly key: User interaction is not allowed.');
  });
});
