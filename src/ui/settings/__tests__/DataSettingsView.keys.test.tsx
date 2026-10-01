import { Alert, type AlertButton } from 'react-native';

import { FAKE_KEY, FAKE_KEY_2, liveRig, renderSettings, unmountAll } from './settings-rig';

// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual('./native-fakes').secureStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('./native-fakes').kvStoreModule());

/**
 * M8b.1 "Live data": a pasted key goes into the Keychain (expo-secure-store, mocked) THROUGH the live
 * runtime, takes effect at once, and is never rendered — only "Saved ••••<last4>". Keys are fake.
 */

const spies: jest.SpyInstance[] = [];

afterEach(async () => {
  spies.splice(0, spies.length).forEach((spy) => spy.mockRestore());
  await unmountAll();
});

/** Every 5-character run of `key` that appears in `rendered`. */
function leaks(rendered: string, key: string): string[] {
  const runs = Array.from({ length: key.length - 4 }, (_, i) => key.slice(i, i + 5));
  expect(runs).toHaveLength(key.length - 4);
  expect(runs.every((run) => run.length === 5)).toBe(true);
  return runs.filter((run) => rendered.includes(run));
}

/** Alert.alert answers with the button whose style is `choose` (the confirm's destructive "Remove", or "Cancel"). */
function answerAlerts(choose: 'destructive' | 'cancel'): jest.SpyInstance {
  const spy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => buttons?.find((button) => button.style === choose)?.onPress?.());
  spies.push(spy);
  expect(jest.isMockFunction(Alert.alert)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  return spy;
}

describe('Data & Settings (M8b.1): a key pasted into the Keychain through the live runtime', () => {
  it('save writes live.key.transitland to the keychain', async () => {
    const rig = await liveRig();
    const screen = await renderSettings(rig);
    expect(screen.textOf('key-status-transitland')).toBe('Not set');
    await screen.type('key-input-transitland', `  ${FAKE_KEY}\n`);
    await screen.press('key-save-transitland');
    expect(rig.keychain.setItemAsync.mock.calls).toEqual([['live.key.transitland', FAKE_KEY]]);
    expect(rig.latest().hasKey).toEqual({ swiftly: false, transitland: true });
    expect(screen.textOf('key-status-transitland')).toBe('Saved ••••WXYZ');
    expect(screen.textOf('key-notice-transitland')).toBe('Transitland key saved. Live data starts at the next update.');
  });

  it('the full key is never rendered, only its last 4', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY } });
    const screen = await renderSettings(rig);
    expect(screen.textOf('key-status-transitland')).toBe('Saved ••••WXYZ');
    expect(leaks(screen.json(), FAKE_KEY)).toEqual([]);
    await screen.type('key-input-transitland', FAKE_KEY_2);
    expect(screen.prop('key-input-transitland', 'secureTextEntry')).toBe(true);
    await screen.press('key-save-transitland');
    expect(screen.prop('key-input-transitland', 'value')).toBe('');
    expect([...leaks(screen.json(), FAKE_KEY), ...leaks(screen.json(), FAKE_KEY_2)]).toEqual([]);
    expect(screen.textOf('key-status-transitland')).toBe('Saved ••••QRST');
  });

  it('clear deletes the key from the keychain', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY } });
    const screen = await renderSettings(rig);
    const alert = answerAlerts('destructive');
    await screen.press('key-clear-transitland');
    expect(alert.mock.calls[0]?.[0]).toBe('Remove the Transitland key?');
    expect(rig.keychain.deleteItemAsync.mock.calls).toEqual([['live.key.transitland']]);
    expect(rig.latest().hasKey.transitland).toBe(false);
    expect(screen.textOf('key-status-transitland')).toBe('Not set');
    expect(screen.tree().root.findAll((node) => node.props.testID === 'key-clear-transitland')).toEqual([]);
  });
});

describe('Data & Settings (M8b.1): refusals keep the Keychain as it was', () => {
  it('cancelling the confirm keeps the key', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY } });
    const screen = await renderSettings(rig);
    answerAlerts('cancel');
    await screen.press('key-clear-transitland');
    expect(rig.keychain.deleteItemAsync).not.toHaveBeenCalled();
    expect(screen.textOf('key-status-transitland')).toBe('Saved ••••WXYZ');
  });

  it('a paste with whitespace inside is refused, stores nothing, and the field still clears', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY } });
    const screen = await renderSettings(rig);
    await screen.type('key-input-transitland', 'fake-half\nkey');
    await screen.press('key-save-transitland');
    expect(rig.keychain.setItemAsync).not.toHaveBeenCalled();
    expect(screen.textOf('key-notice-transitland')).toBe('The pasted transitland key has whitespace inside it — copy it again');
    expect(screen.prop('key-input-transitland', 'value')).toBe('');
    expect(screen.textOf('key-status-transitland')).toBe('Saved ••••WXYZ');
  });

  it('Save is disabled until something is pasted', async () => {
    const screen = await renderSettings(await liveRig());
    expect(screen.prop('key-save-transitland', 'disabled')).toBe(true);
    await screen.type('key-input-transitland', FAKE_KEY);
    expect(screen.prop('key-save-transitland', 'disabled')).toBe(false);
  });
});

describe('Data & Settings (M8b.1): Swiftly agency key', () => {
  it('the swiftly agency key defaults to miami', async () => {
    const rig = await liveRig();
    const screen = await renderSettings(rig);
    expect([screen.prop('agency-input-swiftly', 'value'), screen.prop('agency-input-swiftly', 'placeholder')]).toEqual(['miami', 'miami']);
    await screen.type('agency-input-swiftly', 'miami-dade');
    await screen.press('agency-save-swiftly');
    expect(rig.keychain.setItemAsync.mock.calls).toEqual([['live.agency.swiftly', 'miami-dade']]);
    expect(rig.latest().swiftlyAgency).toBe('miami-dade');
    expect(screen.prop('agency-input-swiftly', 'value')).toBe('miami-dade');
    expect(screen.textOf('agency-notice-swiftly')).toBe('Swiftly agency key saved: miami-dade.');
  });
});
