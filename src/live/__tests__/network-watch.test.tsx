import type { NetworkState } from 'expo-network';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { closeScheduleCopy } from '../../data/__tests__/schedule-sqlite-fake';
import { ScheduleDbProvider } from '../../data/schedule-db-provider';
import { LIVE_TRIP_UPDATES_FIXTURE_BYTES, LIVE_VEHICLES_FIXTURE_BYTES } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { DEPARTURES_813 } from '../../domain/live/__fixtures__/transitland-departures.fixture';
import { PROVIDER_CONFIG } from '../../domain/live/constants';
import type { KvStoreFake, SecureStoreFake } from '../../ui/settings/__tests__/native-fakes';
import type { FetchResponseLike, HttpInit } from '../http';
import { LiveDataProvider, useLive } from '../live-context';
import { saveSwiftlyWifiOnly } from '../swiftly-wifi';
import { bytesOf, departuresUrl, FakeServer, networkState, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

// test-time mock of native module
jest.mock('expo-network', () => ({ __esModule: true, getNetworkStateAsync: mockGetNetworkState, addNetworkStateListener: mockAddNetworkListener }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ __esModule: true, fetch: mockFetch }));
// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual('../../ui/settings/__tests__/native-fakes').secureStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../ui/settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-sqlite', () => jest.requireActual('../../data/__tests__/schedule-sqlite-fake').scheduleSqliteModule());

/**
 * mfix10: the app's ONE network watch, through the REAL LiveDataProvider over the REAL ScheduleDbProvider
 * (the committed schedule DB). The native modules are stand-ins: expo-network answers every ask with
 * the test's network (the app asks once per resume: on mount, as the app is active, the runtime asks
 * and holds its poller until a heartbeat finds that answer in) and plays network changes to its
 * listeners; expo/fetch answers both providers from a fake server (recording each request's instant),
 * the Keychain holds both (fake) keys, and the kv store holds the setting. The app is active, and jest's
 * fake clock is stepped one second per act (the repo's act() trap).
 */

const STATION = 'mover:government-center';
const T0_MS = Date.UTC(2026, 9, 1, 12);
/** The four feeds the app reads: either provider's vehicles, Swiftly's trip updates, Transitland's departures. */
const KNOWN_FEED = /(\/vehicle_positions\.pb|\/gtfs-rt-vehicle-positions|\/gtfs-rt-trip-updates)$|\/departures\?/;

type Provider = 'swiftly' | 'transitland';
type Listener = { readonly listener: (state: NetworkState) => void; readonly remove: jest.Mock };
const mockNet = { answer: 'CELLULAR', asks: 0, listeners: [] as Listener[] };
const mockHttp: { server: FakeServer | null; requests: { url: string; atS: number }[] } = { server: null, requests: [] };
const trees: ReactTestRenderer[] = [];

/** expo-network's answer to an ask: networkState(mockNet.answer). */
function mockGetNetworkState(...args: unknown[]): Promise<NetworkState> {
  mockNet.asks += 1;
  expect(args).toEqual([]); // expo-network's getNetworkStateAsync takes nothing
  expect(mockNet.listeners.filter((entry) => entry.remove.mock.calls.length === 0)).toHaveLength(1); // asked only while the one watch listens
  return Promise.resolve(networkState(mockNet.answer));
}

/** expo-network's listener, handing back a subscription whose remove() is counted. */
function mockAddNetworkListener(listener: (state: NetworkState) => void): { remove: jest.Mock } {
  expect(typeof listener).toBe('function');
  expect(mockNet.listeners.filter((entry) => entry.remove.mock.calls.length === 0)).toHaveLength(0); // the app's ONE watch
  const entry = { listener, remove: jest.fn() };
  mockNet.listeners.push(entry);
  return { remove: entry.remove };
}

/** expo/fetch, answered by the fake server; each request is recorded with its instant. */
function mockFetch(url: string, init: HttpInit): Promise<FetchResponseLike> {
  const server = mockHttp.server;
  expect(server).not.toBeNull();
  expect(url.startsWith('https://')).toBe(true);
  mockHttp.requests.push({ url, atS: Date.now() / 1000 });
  return (server as FakeServer).fetch(url, init);
}

beforeAll(() => {
  Object.assign(AppState, { currentState: 'active' }); // RN's jest AppState mock has currentState = jest.fn()
  expect(AppState.currentState).toBe('active');
});

beforeEach(() => {
  jest.useFakeTimers({ now: T0_MS, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  mockNet.asks = 0;
  mockNet.listeners.splice(0);
  mockHttp.requests.splice(0);
  expect(Date.now()).toBe(T0_MS);
  expect([mockNet.listeners, mockHttp.requests]).toEqual([[], []]);
});

afterEach(async () => {
  await act(async () => trees.splice(0).forEach((tree) => tree.unmount()));
  jest.useRealTimers();
});

afterAll(closeScheduleCopy);

/** Watches the station, as the Stations tab would; checks the published gate's contract on every render. */
function Watcher(): null {
  const { runtime, state } = useLive();
  useEffect(() => {
    runtime?.watchStations([STATION]);
  }, [runtime]);
  expect(state === null || !state.swiftlyGated || state.hasKey.swiftly).toBe(true); // the gate holds back only a keyed Swiftly
  expect(state === null || runtime?.isStarted() === true).toBe(true); // a published state comes from the running runtime
  return null;
}

/** Lets fetches, Keychain reads and renders settle, without moving the clock. */
async function flush(): Promise<void> {
  const before = Date.now();
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
  });
  expect(Date.now()).toBe(before);
  expect(mockNet.listeners.filter((entry) => entry.remove.mock.calls.length === 0).length).toBeLessThanOrEqual(1); // never a second watch, at any instant
}

/** Steps the fake clock `seconds` seconds, one second per act. */
async function stepS(seconds: number): Promise<void> {
  expect(seconds).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await flush();
  }
  expect(Date.now() % 1000).toBe(0);
}

/** The real live provider (both keys saved) over the committed schedule DB, on a network that answers every ask with `answer`. */
async function mountLive(answer: string): Promise<ReactTestRenderer> {
  mockNet.answer = answer;
  mockHttp.server = new FakeServer({
    [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES },
    [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    [departuresUrl('813')]: { status: 200, body: bytesOf(DEPARTURES_813) },
  });
  const keychain = jest.requireMock<SecureStoreFake>('expo-secure-store');
  keychain.items.clear();
  jest.requireMock<KvStoreFake>('expo-sqlite/kv-store').map.clear();
  keychain.items.set('live.key.swiftly', 'fake-swiftly-watch-key');
  keychain.items.set('live.key.transitland', 'fake-transitland-watch-key');
  const app = (
    <ScheduleDbProvider>
      <LiveDataProvider>
        <Watcher />
      </LiveDataProvider>
    </ScheduleDbProvider>
  );
  let tree: ReactTestRenderer | null = null;
  await act(async () => {
    tree = create(app);
  });
  await flush();
  trees.push(tree as unknown as ReactTestRenderer);
  expect(tree).not.toBeNull();
  expect(mockNet.listeners).toHaveLength(1);
  return tree as unknown as ReactTestRenderer;
}

/** Who a request went to. */
function providerOf(url: string): Provider {
  const provider: Provider = url.startsWith('https://api.goswift.ly/') ? 'swiftly' : 'transitland';
  expect(url.startsWith('https://')).toBe(true);
  expect(provider === 'swiftly' || url.startsWith('https://transit.land/')).toBe(true);
  return provider;
}

/** Who the first request after request number `from` matching `capability` went to, or null before there is one. */
function firstTo(from: number, capability: RegExp): Provider | null {
  expect(from).toBeLessThanOrEqual(mockHttp.requests.length);
  const after = mockHttp.requests.slice(from);
  expect(after.every((request) => KNOWN_FEED.test(request.url))).toBe(true); // a known feed, so no request escapes the capability patterns unseen
  const first = after.find((request) => capability.test(request.url));
  return first === undefined ? null : providerOf(first.url);
}

/** Steps (at most `maxS` s) until both capabilities have a request after request number `from`; who each first one went to. */
async function nextFetches(from: number, maxS: number): Promise<{ vehicles: Provider | null; predictions: Provider | null }> {
  expect(maxS).toBeGreaterThan(0);
  expect(from).toBeGreaterThanOrEqual(0);
  const [VEHICLES, PREDICTIONS] = [/vehicle/, /trip-updates|\/departures/];
  for (let s = 0; s < maxS && (firstTo(from, VEHICLES) === null || firstTo(from, PREDICTIONS) === null); s += 1) {
    await stepS(1);
  }
  return { vehicles: firstTo(from, VEHICLES), predictions: firstTo(from, PREDICTIONS) };
}

/** How many requests Swiftly has seen since request number `from`. */
function swiftlyCalls(from: number): number {
  expect(from).toBeLessThanOrEqual(mockHttp.requests.length);
  const urls = mockHttp.requests.slice(from).map((request) => request.url).filter((url) => providerOf(url) === 'swiftly');
  expect(urls.every((url) => url === SWIFTLY_VEHICLES_URL || url === SWIFTLY_TRIP_UPDATES_URL)).toBe(true); // Swiftly is asked for its two feeds only
  return urls.length;
}

/** Steps until Swiftly's next poll is ONE second away, so a gate read late would let that poll through. */
async function toEveOfSwiftlyPoll(): Promise<void> {
  const lastS = Math.max(...mockHttp.requests.filter((request) => providerOf(request.url) === 'swiftly').map((request) => request.atS));
  expect(Number.isFinite(lastS)).toBe(true);
  const waitS = lastS + PROVIDER_CONFIG.swiftly.cadenceS - 1 - Date.now() / 1000;
  expect(waitS).toBeGreaterThanOrEqual(0);
  await stepS(waitS);
}

/** Every live expo-network listener hears `type`. */
async function emit(type: string): Promise<void> {
  expect(mockNet.listeners.length).toBeGreaterThan(0);
  expect(type.length).toBeGreaterThan(0);
  await act(async () => mockNet.listeners.filter((entry) => entry.remove.mock.calls.length === 0).forEach((entry) => entry.listener(networkState(type))));
}

describe('the network watch (mfix10): the real live provider', () => {
  it('a network change sends the next fetch of the real live provider to the allowed provider', async () => {
    await mountLive('CELLULAR');
    expect(await nextFetches(0, 5)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    await stepS(30);
    const toWifi = mockHttp.requests.length;
    await emit('WIFI');
    expect(await nextFetches(toWifi, 30)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await toEveOfSwiftlyPoll();
    const toCellular = mockHttp.requests.length;
    await emit('CELLULAR');
    expect(await nextFetches(toCellular, 60)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    await stepS(35);
    expect(swiftlyCalls(toCellular)).toBe(0);
  });

  it('a toggle saved through the setting sends the next fetch to the allowed provider', async () => {
    await mountLive('CELLULAR');
    await stepS(10);
    expect(swiftlyCalls(0)).toBe(0);
    const off = mockHttp.requests.length;
    expect(saveSwiftlyWifiOnly(false)).toEqual({ ok: true, value: false });
    expect(await nextFetches(off, 30)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    await toEveOfSwiftlyPoll();
    const on = mockHttp.requests.length;
    expect(saveSwiftlyWifiOnly(true)).toEqual({ ok: true, value: true });
    expect(await nextFetches(on, 60)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    await stepS(35);
    expect(swiftlyCalls(on)).toBe(0);
  });

  it('the network watch is read once on mount and removed on unmount', async () => {
    const tree = await mountLive('WIFI');
    await stepS(65);
    expect([mockNet.asks, mockNet.listeners.length]).toEqual([1, 1]);
    expect(mockNet.listeners[0]?.remove).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
    trees.splice(trees.indexOf(tree), 1);
    expect(mockNet.listeners[0]?.remove).toHaveBeenCalledTimes(1);
    expect([mockNet.asks, mockNet.listeners.length]).toEqual([1, 1]);
  });
});
