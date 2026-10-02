import { LIVE_TRIP_UPDATES_FIXTURE_BYTES, LIVE_VEHICLES_FIXTURE_BYTES } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { DEPARTURES_9513 } from '../../domain/live/__fixtures__/transitland-departures.fixture';
import { HEARTBEAT_MS, PROVIDER_CONFIG } from '../../domain/live/constants';
import type { FetchFn, HttpInit } from '../http';
import type { SecretStore } from '../keys';
import type { SyncKeyValue } from '../quota-store';
import { LiveRuntime, type LiveState } from '../runtime';
import { readSwiftlyWifiOnly, saveSwiftlyWifiOnly } from '../swiftly-wifi';
import { type AppStateSource, bindRuntime } from '../use-live-polling';
import { bytesOf, departuresUrl, FakeNetwork, FakeServer, runtimeNetwork, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

/**
 * mfix10 "use Swiftly only on Wi-Fi": the provider chain under the gate, on a REAL LiveRuntime with both
 * (fake) keys. Both providers are answered by a fake server through a call spy on fetch, which records
 * each request and its instant; the phone's network is a FakeNetwork (the runtime's `networkSource`);
 * the setting is the real module over an in-memory kv store; the heartbeat is the real AppState-gated
 * binding on jest's fake clock, stepped one heartbeat (1 s) at a time.
 */

const STATION = 'rail:government-ctr';
const T0_MS = Date.UTC(2026, 9, 1, 12);
const SWIFTLY_CADENCE_S = PROVIDER_CONFIG.swiftly.cadenceS;
const ACTIVE: AppStateSource = { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) };

type Provider = 'swiftly' | 'transitland';
type Request = { readonly url: string; readonly provider: Provider; readonly capability: 'vehicles' | 'predictions'; readonly atS: number };
type Chain = {
  readonly network: FakeNetwork;
  /** The call spy: every fetch the runtime makes, to either provider. */
  readonly fetch: jest.Mock<ReturnType<FetchFn>, Parameters<FetchFn>>;
  readonly requests: Request[];
  readonly states: LiveState[];
  readonly quota: Map<string, number>;
};

const teardowns: (() => void)[] = [];

beforeEach(() => {
  jest.useFakeTimers({ now: T0_MS });
  expect(Date.now()).toBe(T0_MS);
  expect(teardowns).toHaveLength(0);
});

afterEach(() => {
  teardowns.splice(0).forEach((teardown) => teardown());
  jest.useRealTimers();
});

/** Every URL either provider answers, from the committed synthetic fixtures. */
function bothProviders(): FakeServer {
  const server = new FakeServer({
    [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES },
    [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    [departuresUrl('9512')]: { status: 200, body: bytesOf({ stops: [{ stop_id: '9512', departures: [] }] }) },
    [departuresUrl('9513')]: { status: 200, body: bytesOf(DEPARTURES_9513) },
  });
  expect(server.requests).toEqual([]);
  expect(typeof server.fetch).toBe('function');
  return server;
}

/** Who a request went to, and for what. */
function classify(url: string): Pick<Request, 'provider' | 'capability'> {
  const provider: Provider = url.startsWith('https://api.goswift.ly/') ? 'swiftly' : 'transitland';
  const capability = url === SWIFTLY_VEHICLES_URL || url === TL_VEHICLES_URL ? 'vehicles' : 'predictions';
  expect(url.startsWith('https://')).toBe(true);
  expect(provider === 'swiftly' || url.startsWith('https://transit.land/')).toBe(true);
  return { provider, capability };
}

/**
 * A started runtime with both keys, watching one station, on the network whose first answer is
 * `first` (FakeNetwork's); `wifiOnly` null leaves the setting unwritten (its default, ON).
 */
function chainRig(first: string | null | 'never', wifiOnly: boolean | null = null): Chain {
  const keychain = new Map([['live.key.swiftly', 'fake-swiftly-chain-key'], ['live.key.transitland', 'fake-transitland-chain-key']]);
  const secrets: SecretStore = { getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null), setItemAsync: () => Promise.resolve(), deleteItemAsync: () => Promise.resolve() };
  const items = new Map<string, string>();
  const settings: SyncKeyValue = { getItemSync: (key) => items.get(key) ?? null, setItemSync: (key, value) => void items.set(key, value) };
  if (wifiOnly !== null) {
    expect(saveSwiftlyWifiOnly(wifiOnly, settings)).toEqual({ ok: true, value: wifiOnly });
  }
  const server = bothProviders();
  const requests: Request[] = [];
  const fetch = jest.fn((url: string, init: HttpInit) => {
    requests.push({ url, ...classify(url), atS: Date.now() / 1000 });
    return server.fetch(url, init);
  });
  const quota = new Map<string, number>();
  const network = new FakeNetwork(first);
  const states: LiveState[] = [];
  const quotaStore = { get: (key: string) => quota.get(key) ?? null, set: (key: string, n: number) => void quota.set(key, n) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secrets, quotaStore, networkSource: network, swiftlyWifiOnly: () => readSwiftlyWifiOnly(settings) });
  runtime.watchStations([STATION]);
  teardowns.push(bindRuntime(runtime, ACTIVE, HEARTBEAT_MS));
  expect(network.open()).toHaveLength(1);
  return { network, fetch, requests, states, quota };
}

/** Steps the fake clock `seconds` heartbeats, one at a time, letting each tick's requests finish. */
async function stepS(seconds: number): Promise<void> {
  expect(seconds).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < seconds; i += 1) {
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
  }
  expect(Date.now() % HEARTBEAT_MS).toBe(0);
}

/** How many requests Swiftly has seen since request number `from`, counted on the call spy. */
function swiftlyCalls(chain: Chain, from = 0): number {
  const calls = chain.fetch.mock.calls.slice(from).filter(([url]) => classify(url).provider === 'swiftly').length;
  expect(chain.fetch).toHaveBeenCalledTimes(chain.requests.length);
  expect(calls).toBeLessThanOrEqual(chain.requests.length - from);
  return calls;
}

/** Who the first `capability` request after request number `from` went to, or null before there is one. */
function firstTo(chain: Chain, from: number, capability: Request['capability']): Provider | null {
  const first = chain.requests.slice(from).find((request) => request.capability === capability);
  expect(from).toBeLessThanOrEqual(chain.requests.length);
  expect(first === undefined || first.capability === capability).toBe(true);
  return first?.provider ?? null;
}

/** Steps (at most `maxS` s) until each capability has a request after request number `from`; who each first one went to. */
async function nextFetches(chain: Chain, from: number, maxS: number): Promise<{ vehicles: Provider | null; predictions: Provider | null }> {
  for (let s = 0; s < maxS && (firstTo(chain, from, 'vehicles') === null || firstTo(chain, from, 'predictions') === null); s += 1) {
    await stepS(1);
  }
  expect(maxS).toBeGreaterThan(0);
  expect(from).toBeLessThanOrEqual(chain.requests.length);
  return { vehicles: firstTo(chain, from, 'vehicles'), predictions: firstTo(chain, from, 'predictions') };
}

/** Steps until Swiftly's next poll is ONE second away: a gate that closes now must stop that poll. */
async function toEveOfSwiftlyPoll(chain: Chain): Promise<void> {
  const lastS = Math.max(...chain.requests.filter((request) => request.provider === 'swiftly').map((request) => request.atS));
  expect(Number.isFinite(lastS)).toBe(true);
  const waitS = lastS + SWIFTLY_CADENCE_S - 1 - Date.now() / 1000;
  expect(waitS).toBeGreaterThanOrEqual(0);
  await stepS(waitS);
}

function latest(chain: Chain): LiveState {
  const state = chain.states[chain.states.length - 1];
  expect(state).toBeDefined();
  expect(state?.status).toBeDefined();
  return state as LiveState;
}

/** Both capabilities are served by `provider`, nothing failing. */
function expectServing(chain: Chain, provider: Provider): void {
  const { vehicles, predictions } = latest(chain).status;
  expect([vehicles.provider, predictions.provider]).toEqual([provider, provider]);
  expect([vehicles.failing, predictions.failing, vehicles.consecutiveFailures, predictions.consecutiveFailures]).toEqual([false, false, 0, 0]);
}

/** Swiftly's call meter as the runtime keeps it: the published count and its quota items. */
function swiftlyMeter(chain: Chain): string {
  const meter = JSON.stringify({ published: latest(chain).callsThisMonth.swiftly, stored: [...chain.quota].filter(([key]) => key.startsWith('quota.swiftly.')) });
  expect(meter.length).toBeGreaterThan(0);
  expect(chain.quota).toBeInstanceOf(Map);
  return meter;
}

describe('Swiftly only on Wi-Fi (mfix10): the chain on one network', () => {
  it('wi-fi only on cellular serves vehicles and predictions from transitland and swiftly sees zero requests', async () => {
    const chain = chainRig('CELLULAR');
    expect(await nextFetches(chain, 0, 5)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    for (let s = 0; s < 330; s += 1) {
      await stepS(1); // past the 300 s re-probe: a gated Swiftly is never benched, so never re-probed
      expect([s, swiftlyCalls(chain)]).toEqual([s, 0]);
    }
    expectServing(chain, 'transitland');
    expect(chain.requests.filter((request) => request.url === TL_VEHICLES_URL).length).toBeGreaterThanOrEqual(330 / PROVIDER_CONFIG.transitland.cadenceS);
    expect([latest(chain).callsThisMonth.swiftly, [...chain.quota.keys()].filter((key) => key.startsWith('quota.swiftly.'))]).toEqual([0, []]);
    expect([latest(chain).hasKey.swiftly, latest(chain).keyHints.swiftly, latest(chain).swiftlyGated]).toEqual([true, '••••-key', true]);
  });

  it('wi-fi only on wi-fi serves from swiftly', async () => {
    const chain = chainRig('WIFI');
    expect(await nextFetches(chain, 0, 5)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await stepS(65);
    expect(chain.requests.filter((request) => request.provider === 'transitland')).toEqual([]);
    expectServing(chain, 'swiftly');
    expect(latest(chain).swiftlyGated).toBe(false);
  });

  it('wi-fi only off on cellular serves from swiftly', async () => {
    const chain = chainRig('CELLULAR', false);
    expect(await nextFetches(chain, 0, 5)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await stepS(65);
    expect(chain.requests.filter((request) => request.provider === 'transitland')).toEqual([]);
    expectServing(chain, 'swiftly');
    expect(latest(chain).swiftlyGated).toBe(false);
  });

  it('no network reading yet counts as not on wi-fi', async () => {
    const chain = chainRig('never');
    await stepS(65);
    expect([chain.network.asks, swiftlyCalls(chain)]).toEqual([1, 0]);
    expectServing(chain, 'transitland');
    const later = chain.requests.length;
    chain.network.emit('WIFI');
    expect(await nextFetches(chain, later, 30)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
  });
});

describe('Swiftly only on Wi-Fi (mfix10): the chain as the network changes', () => {
  it('cellular to wi-fi to cellular switches the provider within one cadence each time', async () => {
    const chain = chainRig('CELLULAR');
    await stepS(65);
    expect(swiftlyCalls(chain)).toBe(0);
    const toWifi = chain.requests.length;
    chain.network.emit('WIFI');
    expect(await nextFetches(chain, toWifi, SWIFTLY_CADENCE_S)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await stepS(35);
    expectServing(chain, 'swiftly');
    await toEveOfSwiftlyPoll(chain);
    const toCellular = chain.requests.length;
    const meter = swiftlyMeter(chain);
    chain.network.emit('CELLULAR');
    expect(await nextFetches(chain, toCellular, PROVIDER_CONFIG.transitland.cadenceS)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    await stepS(65);
    expect([swiftlyCalls(chain, toCellular), swiftlyMeter(chain)]).toEqual([0, meter]);
    expectServing(chain, 'transitland');
  });

  it('an event without a network type replaces the wi-fi reading and is not wi-fi', async () => {
    const chain = chainRig('WIFI');
    await stepS(40);
    expectServing(chain, 'swiftly');
    await toEveOfSwiftlyPoll(chain);
    const typeless = chain.requests.length;
    chain.network.emit(null);
    expect(await nextFetches(chain, typeless, PROVIDER_CONFIG.transitland.cadenceS)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    await stepS(35);
    expect([swiftlyCalls(chain, typeless), latest(chain).swiftlyGated]).toEqual([0, true]);
  });

  it('gated time adds no swiftly failures so swiftly serves at the next tick back on wi-fi', async () => {
    const chain = chainRig('CELLULAR');
    await stepS(200); // long enough for 3 would-be failures (0, 15, 45 s) and most of a 300 s bench
    expect(swiftlyCalls(chain)).toBe(0);
    expectServing(chain, 'transitland');
    const back = chain.requests.length;
    chain.network.emit('WIFI');
    expect(await nextFetches(chain, back, 1)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await stepS(1);
    expectServing(chain, 'swiftly');
  });
});
