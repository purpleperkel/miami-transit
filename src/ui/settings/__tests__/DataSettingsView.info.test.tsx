import { router } from 'expo-router';
import { Linking } from 'react-native';

import manifest from '../../../../assets/db/manifest.json';
import { WALKING_PACE_ITEM } from '../walking-pace';
import { liveRig, renderSettings, unmountAll } from './settings-rig';

// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual('./native-fakes').secureStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('./native-fakes').kvStoreModule());

/** M8b.1 "Schedule", "Walking pace", "Attribution" and the link to Diagnostics, on the real screen. */

const spies: jest.SpyInstance[] = [];

afterEach(async () => {
  spies.splice(0, spies.length).forEach((spy) => spy.mockRestore());
  await unmountAll();
});

/** Linking.openURL resolving (opened) or rejecting (could not open). */
function spyOpenURL(opens: boolean): jest.SpyInstance {
  const spy = jest.spyOn(Linking, 'openURL').mockImplementation(() => (opens ? Promise.resolve(true) : Promise.reject(new Error('no handler'))));
  spies.push(spy);
  expect(jest.isMockFunction(Linking.openURL)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
  return spy;
}

describe('Data & Settings (M8b.1): attribution', () => {
  it('both attribution urls are exact', async () => {
    const openURL = spyOpenURL(true);
    const screen = await renderSettings(await liveRig());
    await screen.press('attribution-link-transitland');
    await screen.press('attribution-link-transitous');
    expect(openURL.mock.calls).toEqual([['https://www.transit.land/terms'], ['https://transitous.org/sources']]);
    for (const name of ['Miami-Dade DTPW', 'Swiftly', 'Transitland', 'Transitous']) {
      expect(screen.json()).toContain(`"${name}"`);
    }
  });

  it('a link that cannot open says so', async () => {
    const openURL = spyOpenURL(false);
    const screen = await renderSettings(await liveRig());
    await screen.press('attribution-link-transitous');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(screen.textOf('attribution-notice')).toBe('Could not open https://transitous.org/sources: no handler');
  });
});

describe('Data & Settings (M8b.1): schedule, walking pace, Diagnostics', () => {
  it('the schedule section shows the bundled feed hash, both service ends and the expiry state', async () => {
    const screen = await renderSettings(await liveRig());
    expect(screen.textOf('schedule-feed')).toBe(manifest.feedSha256.slice(0, 8));
    expect([screen.textOf('schedule-rail-end'), screen.textOf('schedule-mover-end')]).toEqual(['Nov 22', 'Dec 31']);
    expect(screen.textOf('schedule-expiry')).toBe('Current · rail runs out in 53 days');
  });

  it('the walking pace shows the defaults, saves through the kv store, and a new mount reads it back', async () => {
    const screen = await renderSettings(await liveRig());
    expect([screen.textOf('pace-walk'), screen.textOf('pace-jog')]).toEqual(['1.35 m/s · 3.0 mph', '2.7 m/s · 6.0 mph']);
    await screen.type('pace-input-walk', '1,5');
    await screen.type('pace-input-jog', '3.1');
    await screen.press('pace-save');
    expect(screen.textOf('pace-notice')).toBe('Saved: walk 1.5, jog 3.1 m/s.');
    const kv = jest.requireMock<{ map: Map<string, string> }>('expo-sqlite/kv-store').map;
    expect(kv.get(WALKING_PACE_ITEM)).toBe('{"walkMps":1.5,"jogMps":3.1}');
    const again = await renderSettings(await liveRig({ kv: Object.fromEntries(kv) }));
    expect([again.textOf('pace-walk'), again.textOf('pace-jog')]).toEqual(['1.5 m/s · 3.4 mph', '3.1 m/s · 6.9 mph']);
  });

  it('a jog no faster than the walk is refused on screen and nothing is stored', async () => {
    const screen = await renderSettings(await liveRig());
    await screen.type('pace-input-jog', '1.2');
    await screen.press('pace-save');
    expect(screen.textOf('pace-notice')).toBe('Not saved: the jog must be faster than the walk.');
    expect(jest.requireMock<{ map: Map<string, string> }>('expo-sqlite/kv-store').map.has(WALKING_PACE_ITEM)).toBe(false);
    expect(screen.textOf('pace-jog')).toBe('2.7 m/s · 6.0 mph');
  });

  it('the Diagnostics link opens /diagnostics', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    spies.push(push);
    const screen = await renderSettings(await liveRig());
    expect(screen.textOf('diagnostics-link')).toBe('Open Diagnostics');
    await screen.press('diagnostics-link');
    expect(push.mock.calls).toEqual([['/diagnostics']]);
  });
});
