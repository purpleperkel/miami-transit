import { LIVE_VEHICLES_FIXTURE_BYTES, LIVE_VEHICLES_FIXTURE_DECODED } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { vehiclesFromFeed } from '../../domain/live/from-gtfsrt';
import type { SecretStore } from '../keys';
import type { QuotaStore } from '../quota';
import { LiveRuntime, type LiveState } from '../runtime';
import { readSwiftlyWifiOnly } from '../swiftly-wifi';
import { FakeNetwork, FakeServer, runtimeNetwork, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

/**
 * M4.9: the runtime end to end — Keychain → chain → HTTP → decoder → mapper → published state —
 * over a fake server, an in-memory Keychain and quota store, and a manual clock. Keys are fake. The
 * phone is on Wi-Fi and "Use Swiftly only on Wi-Fi" is at its default (ON, mfix10), so a keyed Swiftly
 * serves as it always has; swiftly-wifi-chain.test.ts covers the phone off Wi-Fi. The runtime reads the
 * network on resume (the app becoming active); a test that only ticks hears Wi-Fi from a network event.
 */

const OCT_1 = Date.UTC(2026, 9, 1, 12) / 1000;
const TL_KEY = 'fake-transitland-key-for-runtime-test';

type Rig = {
  readonly runtime: LiveRuntime;
  readonly network: FakeNetwork;
  readonly server: FakeServer;
  readonly states: LiveState[];
  readonly keychain: Map<string, string>;
  readonly quota: Map<string, number>;
  readonly clock: { now: number };
};

/** A runtime over in-memory stores; `items` seeds the Keychain, `calls` the quota meter. */
function rig(items: Readonly<Record<string, string>> = { 'live.key.transitland': TL_KEY }, calls: Readonly<Record<string, number>> = {}, keychainDown = false): Rig {
  const keychain = new Map(Object.entries(items));
  const quota = new Map(Object.entries(calls));
  const clock = { now: OCT_1 };
  const states: LiveState[] = [];
  const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
  const secretStore: SecretStore = {
    getItemAsync: (key) => (keychainDown ? Promise.reject(new Error('locked')) : Promise.resolve(keychain.get(key) ?? null)),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const quotaStore: QuotaStore = { get: (key) => quota.get(key) ?? null, set: (key, count) => void quota.set(key, count) };
  const settings = new Map<string, string>();
  const network = new FakeNetwork('WIFI');
  const wifi = { networkSource: network, swiftlyWifiOnly: () => readSwiftlyWifiOnly({ getItemSync: (key) => settings.get(key) ?? null, setItemSync: (key, value) => void settings.set(key, value) }) };
  const options = { network: runtimeNetwork(), onChange: (state: LiveState) => void states.push(state), fetch: server.fetch, keychain: secretStore, quotaStore, nowS: () => clock.now, ...wifi };
  const runtime = new LiveRuntime(options);
  expect(runtime.isStarted()).toBe(false);
  expect(states).toEqual([]);
  return { runtime, network, server, states, keychain, quota, clock };
}

/** Lets the Keychain read, fetches and bookkeeping finish. */
async function settle(): Promise<void> {
  const before = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(Date.now()).toBeGreaterThanOrEqual(before);
  expect(typeof before).toBe('number');
}

function latest(states: readonly LiveState[]): LiveState {
  const state = states[states.length - 1];
  expect(state).toBeDefined();
  expect(state?.status).toBeDefined();
  return state as LiveState;
}

describe('LiveRuntime (M4.9): start and polling', () => {
  it('constructing a runtime does nothing observable; start() publishes, loads the keys, and says which exist — never the keys', async () => {
    const { runtime, states, server } = rig();
    runtime.start();
    await settle();
    expect(latest(states).hasKey).toEqual({ swiftly: false, transitland: true });
    expect(latest(states).keyHints).toEqual({ swiftly: null, transitland: '••••test' });
    expect(latest(states).swiftlyAgency).toBe('miami');
    expect(JSON.stringify(states)).not.toContain(TL_KEY);
    expect(server.requests).toEqual([]);
  });

  it('a tick polls Transitland vehicles: the batch, its bytes and the quota call all land in the state', async () => {
    const { runtime, states, server, quota } = rig();
    runtime.start();
    await settle();
    runtime.resume();
    await settle();
    const state = latest(states);
    expect(server.requests).toEqual([{ url: TL_VEHICLES_URL, headers: { apikey: TL_KEY } }]);
    expect(state.vehicles?.items).toEqual(vehiclesFromFeed(LIVE_VEHICLES_FIXTURE_DECODED, runtimeNetwork()).items);
    expect(state.bytes.transitland).toEqual({ responses: 1, bytes: 1_337, lastBytes: 1_337, lastAt: OCT_1 });
    expect(state.callsThisMonth).toEqual({ swiftly: 0, transitland: 1 });
    expect([...quota]).toEqual([['quota.transitland.202610', 1]]);
    expect(state.status.vehicles).toEqual({ provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null });
  });

  it('Transitland at 9,500 calls this month is skipped: no request, the chain serves none', async () => {
    const { runtime, states, server } = rig(undefined, { 'quota.transitland.202610': 9_500 });
    runtime.start();
    await settle();
    runtime.resume();
    await settle();
    expect(server.requests).toEqual([]);
    expect(latest(states).status.vehicles.provider).toBe('none');
    expect(latest(states).callsThisMonth.transitland).toBe(9_500);
  });

});

describe('LiveRuntime (M4.9): keys and lifecycle', () => {
  it('saveKey puts a pasted key in effect at once (Swiftly takes over); a bad paste changes nothing', async () => {
    const { runtime, network, states, server, keychain } = rig();
    server.on(SWIFTLY_VEHICLES_URL, { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES });
    runtime.start();
    network.emit('WIFI');
    await settle();
    const refused = await runtime.saveKey('swiftly', 'two words');
    expect(refused.ok).toBe(false);
    expect(latest(states).hasKey.swiftly).toBe(false);
    await expect(runtime.saveKey('swiftly', ' fake-swiftly-key ')).resolves.toEqual({ ok: true, value: 'fake-swiftly-key' });
    expect(keychain.get('live.key.swiftly')).toBe('fake-swiftly-key');
    runtime.tick();
    await settle();
    expect(server.urls()).toEqual([SWIFTLY_VEHICLES_URL]);
    expect(latest(states).status.vehicles.provider).toBe('swiftly');
  });

  it('a Keychain that cannot be read is reported in keysError, and nothing is polled', async () => {
    const { runtime, states, server } = rig(undefined, {}, true);
    runtime.start();
    await settle();
    runtime.tick();
    await settle();
    expect(latest(states).keysError).toEqual({ kind: 'keychain', message: 'could not read the swiftly key: locked' });
    expect(server.requests).toEqual([]);
  });

  it('stop() aborts and silences the runtime; it can start again (React may run an effect twice)', async () => {
    const { runtime, states, server } = rig();
    runtime.start();
    runtime.stop();
    await settle();
    const published = states.length;
    expect(runtime.isStarted()).toBe(false);
    runtime.watchStations(['rail:government-ctr']);
    expect(states).toHaveLength(published);
    runtime.start();
    await settle();
    runtime.resume();
    await settle();
    expect(server.urls()).toContain(TL_VEHICLES_URL);
    expect(latest(states).vehicles?.provider).toBe('transitland');
  });
});
