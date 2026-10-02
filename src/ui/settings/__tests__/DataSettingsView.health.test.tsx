import { act } from 'react-test-renderer';

import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { PROVIDER_CONFIG } from '../../../domain/live/constants';
import { FakeServer, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import { quotaKey } from '../../../live/quota';
import { FAKE_KEY, type LiveRig, liveRig, OCT_1_NOON_S, renderSettings, settle, unmountAll } from './settings-rig';

// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual('./native-fakes').secureStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('./native-fakes').kvStoreModule());

/**
 * M8b.1 "A status row shows live / failing / stale, the last update age, bytes per poll, and
 * Transitland quota 'N of 10,000 this month'" — read from a real runtime's state. The Transitland
 * vehicles feed is the synthetic 1,337-byte fixture; keys are fake.
 */

afterEach(unmountAll);

/** One poll of every due task (resume() the first time, as the app does on becoming active), then the clock moves on. */
async function poll(rig: LiveRig, first: boolean, thenAdvanceS: number): Promise<void> {
  expect(rig.runtime.isStarted()).toBe(true);
  const step = first ? 'resume' : 'tick';
  await act(async () => {
    rig.runtime[step]();
    await settle();
  });
  rig.clock.now += thenAdvanceS;
  expect(rig.clock.now).toBeGreaterThanOrEqual(OCT_1_NOON_S);
}

describe('Data & Settings (M8b.1): the quota row', () => {
  it('the quota row reads 1234 of 10,000', async () => {
    // 1234 renders with digit grouping, "1,234" — the plan's "1234 of 10,000" with the limit's own separator.
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY }, kv: { [quotaKey('transitland', OCT_1_NOON_S)]: '1234' } });
    const screen = await renderSettings(rig);
    expect(rig.latest().callsThisMonth.transitland).toBe(1234);
    expect(PROVIDER_CONFIG.transitland.monthlyQuota).toBe(10_000);
    expect(screen.textOf('provider-quota-transitland')).toBe('1,234 of 10,000 this month');
    expect(screen.textOf('provider-quota-swiftly')).toBe('0 calls this month');
  });

  it('at 95% of the quota Transitland is paused, and says so', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY }, kv: { [quotaKey('transitland', OCT_1_NOON_S)]: '9500' } });
    const screen = await renderSettings(rig);
    expect(screen.textOf('provider-quota-transitland')).toBe('9,500 of 10,000 this month');
    expect(screen.textOf('provider-status-transitland')).toBe('Paused · 95% of the monthly quota used');
  });
});

describe('Data & Settings (M8b.1): the provider status row', () => {
  it('the status row shows the provider state, update age and bytes per poll', async () => {
    const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY }, fetch: server.fetch });
    await poll(rig, true, 12);
    expect(server.urls()).toEqual([TL_VEHICLES_URL]);
    const screen = await renderSettings(rig);
    expect(screen.textOf('provider-status-transitland')).toBe('Live · updated 12 s ago · 1.3 KB per poll');
    expect(screen.textOf('provider-status-swiftly')).toBe('Off · no key');
  });

  it('data older than the fresh threshold (180 s) reads Stale, with its age', async () => {
    const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY }, fetch: server.fetch });
    await poll(rig, true, PROVIDER_CONFIG.transitland.freshS + 1);
    expect(rig.latest().vehicles?.fetchedAt).toBe(OCT_1_NOON_S);
    const screen = await renderSettings(rig);
    expect(PROVIDER_CONFIG.transitland.freshS).toBe(180);
    expect(screen.textOf('provider-status-transitland')).toBe('Stale · updated 3 min ago · 1.3 KB per poll');
  });

  it('Failing after 3 failed polls, and not before', async () => {
    const rig = await liveRig({ keychain: { 'live.key.transitland': FAKE_KEY } });
    const before = await renderSettings(rig);
    expect(before.textOf('provider-status-transitland')).toBe('Waiting for the first update');
    await poll(rig, true, 300);
    await poll(rig, false, 300);
    await before.refresh();
    expect(before.textOf('provider-status-transitland')).not.toMatch(/failing/i);
    await poll(rig, false, 0);
    await before.refresh();
    expect(before.textOf('provider-status-transitland')).toBe('Failing · transit.land could not be reached: offline in this test');
  });
});
