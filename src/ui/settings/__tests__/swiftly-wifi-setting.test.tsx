import { act } from 'react-test-renderer';

import { bothProviders, FakeNetwork } from '../../../live/__tests__/live-fakes';
import type { KvStoreFake } from './native-fakes';
import { FAKE_KEY, type LiveRig, liveRig, renderSettings, type SettingsScreen, settle, unmountAll } from './settings-rig';

// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual('./native-fakes').secureStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('./native-fakes').kvStoreModule());

/**
 * mfix10 "Use Swiftly only on Wi-Fi" in Data & Settings: the switch in the Swiftly card (ON by default,
 * saved in its one kv item), the gated Swiftly row, Transitland's own health while it serves for a
 * gated Swiftly, and the footer's rule, on a REAL runtime with both (fake) keys and a fake phone network.
 */

const LABEL = 'Use Swiftly only on Wi-Fi';
const ITEM = 'settings.swiftly-wifi-only';
/** A provider's own live health: "Live · updated <age> · <size> per poll". */
const LIVE_HEALTH = /^Live · updated (just now|\d+ (s|min) ago) · \d+(\.\d)? (B|KB|MB) per poll$/;
const BOTH_KEYS = { 'live.key.swiftly': 'fake-swiftly-settings-key', 'live.key.transitland': FAKE_KEY };
const kvModule = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');
const kvWrite = kvModule.default.setItemSync;

afterEach(async () => {
  kvModule.default.setItemSync = kvWrite;
  await unmountAll();
});

/**
 * One heartbeat — or, `first`, the app becoming active: resume() asks the network afresh and holds the
 * poller, so nothing is polled or published until the next heartbeat finds the answer in. Then the
 * clock moves on and the screen redraws.
 */
async function beat(rig: LiveRig, screen: SettingsScreen, first: boolean, thenAdvanceS: number): Promise<void> {
  expect(rig.runtime.isStarted()).toBe(true);
  expect(thenAdvanceS).toBeGreaterThanOrEqual(0); // the clock never runs backwards
  await act(async () => {
    rig.runtime[first ? 'resume' : 'tick']();
    await settle();
  });
  rig.clock.now += thenAdvanceS;
  await screen.refresh();
}

/** Toggles the switch as a tap would, then redraws. */
async function toggle(screen: SettingsScreen, value: boolean): Promise<void> {
  const onValueChange = screen.prop('swiftly-wifi-only', 'onValueChange');
  expect(typeof onValueChange).toBe('function');
  await act(async () => (onValueChange as (next: boolean) => void)(value));
  await screen.refresh();
  expect(screen.tree().root.findAll((node) => node.props.testID === 'swiftly-wifi-only').length).toBeGreaterThan(0);
}

/** The index of the first host node matching `pred`, in document order (-1 when none does). */
function hostIndex(screen: SettingsScreen, pred: (props: Record<string, unknown>, text: string) => boolean): number {
  expect(screen.tree().toJSON()).not.toBeNull(); // the screen is mounted
  const hosts = screen.tree().root.findAll((node) => typeof node.type === 'string');
  expect(hosts.length).toBeGreaterThan(0);
  return hosts.findIndex((node) => pred(node.props, typeof node.props.children === 'string' ? node.props.children : ''));
}

describe('Data & Settings (mfix10): the Wi-Fi only switch', () => {
  it('the wi-fi only switch renders under swiftly and is on by default', async () => {
    const rig = await liveRig({ keychain: BOTH_KEYS, network: new FakeNetwork('CELLULAR') });
    const screen = await renderSettings(rig);
    expect([screen.prop('swiftly-wifi-only', 'value'), screen.prop('swiftly-wifi-only', 'accessibilityLabel')]).toEqual([true, LABEL]);
    const swiftly = hostIndex(screen, (props, text) => props.accessibilityRole === 'header' && text === 'Swiftly');
    const switchAt = hostIndex(screen, (props) => props.testID === 'swiftly-wifi-only');
    const label = hostIndex(screen, (_props, text) => text === LABEL);
    const transitland = hostIndex(screen, (props, text) => props.accessibilityRole === 'header' && text === 'Transitland');
    expect([swiftly >= 0, swiftly < switchAt, switchAt < transitland, swiftly < label, label < transitland]).toEqual([true, true, true, true, true]);
    expect(rig.kv.map.has(ITEM)).toBe(false);
  });

  it('a switch saved off shows off', async () => {
    const rig = await liveRig({ keychain: BOTH_KEYS, kv: { [ITEM]: 'false' }, network: new FakeNetwork('CELLULAR') });
    const screen = await renderSettings(rig);
    expect(screen.prop('swiftly-wifi-only', 'value')).toBe(false);
    expect(screen.json()).not.toContain('swiftly-wifi-only-notice');
  });

  it('toggling the wi-fi only switch writes its kv item', async () => {
    const network = new FakeNetwork('CELLULAR');
    const rig = await liveRig({ keychain: BOTH_KEYS, network });
    const screen = await renderSettings(rig);
    await toggle(screen, false);
    expect([...rig.kv.map].filter(([key]) => key.startsWith('settings.'))).toEqual([[ITEM, 'false']]);
    expect(screen.prop('swiftly-wifi-only', 'value')).toBe(false);
    await beat(rig, screen, true, 0);
    await beat(rig, screen, false, 0);
    expect(rig.latest().swiftlyGated).toBe(false);
    await toggle(screen, true);
    expect([rig.kv.map.get(ITEM), screen.prop('swiftly-wifi-only', 'value')]).toEqual(['true', true]);
    await beat(rig, screen, false, 0);
    expect(rig.latest().swiftlyGated).toBe(true);
  });

  it('a save the kv store refuses says so and the switch keeps the setting in effect', async () => {
    const rig = await liveRig({ keychain: BOTH_KEYS, network: new FakeNetwork('CELLULAR') });
    const screen = await renderSettings(rig);
    kvModule.default.setItemSync = () => {
      throw new Error('disk full');
    };
    await toggle(screen, false);
    expect(screen.textOf('swiftly-wifi-only-notice')).toBe('Not saved: could not save the Wi-Fi only setting: disk full.');
    expect([screen.prop('swiftly-wifi-only', 'value'), rig.kv.map.has(ITEM)]).toEqual([true, false]);
  });
});

describe('Data & Settings (mfix10): the status rows and the footer', () => {
  it('a gated swiftly row reads paused not on wi-fi', async () => {
    const network = new FakeNetwork('WIFI');
    const rig = await liveRig({ keychain: BOTH_KEYS, fetch: bothProviders([]).fetch, network });
    const screen = await renderSettings(rig);
    await beat(rig, screen, true, 0);
    await beat(rig, screen, false, 5);
    expect(screen.textOf('provider-status-swiftly')).toMatch(LIVE_HEALTH);
    await act(async () => network.emit('CELLULAR'));
    await beat(rig, screen, false, 5);
    expect(screen.textOf('provider-status-swiftly')).toBe('Paused · not on Wi-Fi');
    expect(screen.textOf('key-status-swiftly')).toMatch(/^Saved /);
  });

  it('transitland shows its own live health while it serves for a gated swiftly', async () => {
    const network = new FakeNetwork('WIFI');
    const rig = await liveRig({ keychain: BOTH_KEYS, fetch: bothProviders([]).fetch, network });
    const screen = await renderSettings(rig);
    await beat(rig, screen, true, 0);
    await beat(rig, screen, false, 5);
    expect(screen.textOf('provider-status-transitland')).toBe('Standby · Swiftly serves');
    await act(async () => network.emit('CELLULAR'));
    await beat(rig, screen, false, 12);
    expect(screen.textOf('provider-status-transitland')).toMatch(LIVE_HEALTH);
    expect(rig.latest().status.vehicles.provider).toBe('transitland');
  });

  it('the live data footer states the wi-fi rule', async () => {
    const rig = await liveRig({ keychain: BOTH_KEYS, network: new FakeNetwork('CELLULAR') });
    const screen = await renderSettings(rig);
    const footer = "Keys stay in this phone's Keychain. Swiftly serves first when it has a key (only on Wi-Fi, if that is on); Transitland otherwise.";
    expect(screen.json()).toContain(JSON.stringify(footer));
    expect(screen.json()).not.toContain('Swiftly serves first when it has a key;');
  });
});
