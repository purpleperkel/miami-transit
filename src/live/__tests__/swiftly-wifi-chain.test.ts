import { HEARTBEAT_MS, PROVIDER_CONFIG } from '../../domain/live/constants';
import type { FetchFn, FetchResponseLike, HttpInit } from '../http';
import type { SecretStore } from '../keys';
import type { SyncKeyValue } from '../quota-store';
import { LiveRuntime, type LiveState, RESUME_READING_TIMEOUT_MS } from '../runtime';
import { readSwiftlyWifiOnly, saveSwiftlyWifiOnly } from '../swiftly-wifi';
import { type AppStateSource, bindRuntime } from '../use-live-polling';
import { bothProviders, FakeNetwork, runtimeNetwork, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

/**
 * mfix10 "use Swiftly only on Wi-Fi": the provider chain under the gate, on a REAL LiveRuntime with both
 * (fake) keys. Both providers are answered by a fake server through a call spy on fetch, which records
 * each request and its instant; the phone's network is a FakeNetwork (the runtime's `networkSource`);
 * the setting is the real module over an in-memory kv store; the heartbeat is the real AppState-gated
 * binding on jest's fake clock, stepped one heartbeat (1 s) at a time. The app stays active, unless a
 * test moves it through a HandAppState (a resume then holds the poller until the network's fresh answer
 * is in); a test can hold Swiftly's downloads open and then cut them, as leaving Wi-Fi does.
 */

const STATION = 'rail:government-ctr';
/** Three watched stations, every one reading Swiftly's ONE whole-agency trip-updates download. */
const THREE_STATIONS = ['rail:government-ctr', 'rail:brickell', 'mover:government-center'];
const T0_MS = Date.UTC(2026, 9, 1, 12);
const SWIFTLY_CADENCE_S = PROVIDER_CONFIG.swiftly.cadenceS;
const ACTIVE: AppStateSource = { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) };

type Provider = 'swiftly' | 'transitland';
type AppStatus = NonNullable<AppStateSource['currentState']>;
type Request = { readonly url: string; readonly provider: Provider; readonly capability: 'vehicles' | 'predictions'; readonly atS: number };
type RigOptions = { readonly wifiOnly?: boolean; readonly app?: AppStateSource; readonly stations?: readonly string[] };
type Chain = {
  readonly network: FakeNetwork;
  readonly downloads: HeldDownloads;
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

/** The app's foreground state, moved by the test as iOS moves it; the real AppState-gated binding listens to it. */
class HandAppState implements AppStateSource {
  currentState: AppStatus = 'active';
  private readonly listeners: ((state: AppStatus) => void)[] = [];

  addEventListener(type: 'change', listener: (state: AppStatus) => void): { remove(): void } {
    expect(type).toBe('change');
    expect(this.listeners).toHaveLength(0); // one binding per runtime
    this.listeners.push(listener);
    return { remove: () => void this.listeners.splice(this.listeners.indexOf(listener), 1) };
  }

  /** The app moves to `state`: the binding hears it (becoming active resumes the runtime at once). */
  set(state: AppStatus): void {
    expect(this.listeners).toHaveLength(1);
    expect(state).not.toBe(this.currentState);
    this.currentState = state;
    this.listeners.forEach((listener) => listener(state));
  }
}

/** Swiftly downloads the test holds open while `holding`, then cuts, as leaving Wi-Fi does mid-download. */
class HeldDownloads {
  holding = false;
  private readonly held: { readonly url: string; readonly fail: (error: Error) => void }[] = [];

  /** A download of `url` that hangs until cutAll(). */
  hold(url: string): Promise<FetchResponseLike> {
    expect(this.held.map((download) => download.url)).not.toContain(url); // one download per endpoint at a time (Swiftly's 30 s floor)
    expect(this.held.length).toBeLessThan(2); // at most its vehicles and its ONE shared trip-updates download
    return new Promise<FetchResponseLike>((_resolve, reject) => void this.held.push({ url, fail: reject }));
  }

  /** Fails every held download (the Wi-Fi went away under it) and stops holding; how many there were. */
  cutAll(): number {
    expect(this.holding).toBe(true);
    const cut = this.held.splice(0);
    expect(cut.length).toBeGreaterThan(0);
    cut.forEach((download) => download.fail(new Error('the Wi-Fi went away mid-download')));
    this.holding = false;
    return cut.length;
  }
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
 * A started runtime with both keys on the network whose every answer is `first` (FakeNetwork's): the
 * setting unwritten (its default, ON) unless `wifiOnly` saves it, `stations` watched (one by default),
 * and `app` the app's foreground state (active throughout by default).
 */
function chainRig(first: string | 'never', { wifiOnly, app = ACTIVE, stations = [STATION] }: RigOptions = {}): Chain {
  const keychain = new Map([['live.key.swiftly', 'fake-swiftly-chain-key'], ['live.key.transitland', 'fake-transitland-chain-key']]);
  const secrets: SecretStore = { getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null), setItemAsync: () => Promise.resolve(), deleteItemAsync: () => Promise.resolve() };
  const items = new Map<string, string>();
  const settings: SyncKeyValue = { getItemSync: (key) => items.get(key) ?? null, setItemSync: (key, value) => void items.set(key, value) };
  if (wifiOnly !== undefined) {
    expect(saveSwiftlyWifiOnly(wifiOnly, settings)).toEqual({ ok: true, value: wifiOnly });
  }
  const server = bothProviders(stations);
  const requests: Request[] = [];
  const downloads = new HeldDownloads();
  const fetch = jest.fn((url: string, init: HttpInit) => {
    requests.push({ url, ...classify(url), atS: Date.now() / 1000 });
    return downloads.holding && classify(url).provider === 'swiftly' ? downloads.hold(url) : server.fetch(url, init);
  });
  const quota = new Map<string, number>();
  const network = new FakeNetwork(first);
  const states: LiveState[] = [];
  const quotaStore = { get: (key: string) => quota.get(key) ?? null, set: (key: string, n: number) => void quota.set(key, n) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secrets, quotaStore, networkSource: network, swiftlyWifiOnly: () => readSwiftlyWifiOnly(settings) });
  runtime.watchStations(stations);
  teardowns.push(bindRuntime(runtime, app, HEARTBEAT_MS));
  expect(network.open()).toHaveLength(1);
  return { network, downloads, fetch, requests, states, quota };
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
  expect(from).toBeLessThanOrEqual(chain.fetch.mock.calls.length); // a mark taken earlier in the test
  const urls = chain.fetch.mock.calls.slice(from).map(([url]) => url).filter((url) => classify(url).provider === 'swiftly');
  expect(urls.every((url) => url === SWIFTLY_VEHICLES_URL || url === SWIFTLY_TRIP_UPDATES_URL)).toBe(true); // Swiftly is asked for its two feeds only
  return urls.length;
}

/** Who the first `capability` request after request number `from` went to, or null before there is one. */
function firstTo(chain: Chain, from: number, capability: Request['capability']): Provider | null {
  expect(from).toBeLessThanOrEqual(chain.requests.length);
  const after = chain.requests.slice(from);
  expect(after.every((request, i) => i === 0 || (after[i - 1]?.atS ?? request.atS) <= request.atS)).toBe(true); // in time order: the fake clock never runs backwards
  return after.find((request) => request.capability === capability)?.provider ?? null;
}

/** Steps (at most `maxS` s) until each capability has a request after request number `from`; who each first one went to. */
async function nextFetches(chain: Chain, from: number, maxS: number): Promise<{ vehicles: Provider | null; predictions: Provider | null }> {
  expect(maxS).toBeGreaterThan(0);
  expect(from).toBeLessThanOrEqual(chain.requests.length);
  for (let s = 0; s < maxS && (firstTo(chain, from, 'vehicles') === null || firstTo(chain, from, 'predictions') === null); s += 1) {
    await stepS(1);
  }
  return { vehicles: firstTo(chain, from, 'vehicles'), predictions: firstTo(chain, from, 'predictions') };
}

/** When Swiftly's latest request started (s). */
function lastSwiftlyAtS(chain: Chain): number {
  const lastS = Math.max(...chain.requests.filter((request) => request.provider === 'swiftly').map((request) => request.atS));
  expect(Number.isFinite(lastS)).toBe(true); // Swiftly has polled
  expect(lastS).toBeLessThanOrEqual(Date.now() / 1000);
  return lastS;
}

/** Steps until Swiftly's next poll is ONE second away: a gate that closes now must stop that poll. */
async function toEveOfSwiftlyPoll(chain: Chain): Promise<void> {
  const waitS = lastSwiftlyAtS(chain) + SWIFTLY_CADENCE_S - 1 - Date.now() / 1000;
  expect(waitS).toBeGreaterThanOrEqual(0);
  await stepS(waitS);
  expect(Date.now() / 1000).toBe(lastSwiftlyAtS(chain) + SWIFTLY_CADENCE_S - 1);
}

function latest(chain: Chain): LiveState {
  const state = chain.states[chain.states.length - 1];
  expect(state).toBeDefined();
  expect(Object.isFrozen(state)).toBe(true); // the runtime publishes immutable states
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
  const stored = [...chain.quota].filter(([key]) => key.startsWith('quota.swiftly.'));
  const published = latest(chain).callsThisMonth.swiftly;
  expect(stored.length).toBeLessThanOrEqual(1); // one item per provider per month
  expect(published).toBeLessThanOrEqual(stored[0]?.[1] ?? 0); // the published count never runs ahead of the store
  return JSON.stringify({ published, stored });
}

/** The published states since state number `from` that show a Swiftly failure: a count, a bench or an error. */
function failureTraces(chain: Chain, from: number): LiveState[] {
  expect(chain.states.length).toBeGreaterThan(from); // states were published since the mark, so an empty answer is not vacuous
  expect(chain.downloads.holding).toBe(false); // every held download has ended, so every poll has been settled
  return chain.states.slice(from).filter((state) => [state.status.vehicles, state.status.predictions].some((status) => status.consecutiveFailures > 0 || status.failing || status.lastError !== null));
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
    const chain = chainRig('CELLULAR', { wifiOnly: false });
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

describe('Swiftly only on Wi-Fi (mfix10): a resume holds the poller for the fresh reading', () => {
  it('a wi-fi resume makes zero transitland requests, and swiftly\'s next request starts at least 30 s after its previous one', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(40);
    await toEveOfSwiftlyPoll(chain);
    await stepS(6); // Swiftly polled 5 s ago
    const previousS = lastSwiftlyAtS(chain);
    app.set('background');
    await stepS(10); // still on Wi-Fi: the fresh answer will say so
    const [resumed, published] = [chain.requests.length, chain.states.length];
    app.set('active');
    await stepS(65);
    expect(chain.requests.slice(resumed).filter((request) => request.provider === 'transitland')).toEqual([]);
    expect((chain.requests.slice(resumed).find((request) => request.provider === 'swiftly')?.atS ?? Number.NaN) - previousS).toBeGreaterThanOrEqual(SWIFTLY_CADENCE_S);
    const moved = chain.states.slice(published).filter((state) => state.swiftlyGated || state.status.vehicles.provider !== 'swiftly' || state.status.predictions.provider !== 'swiftly');
    expect(moved).toEqual([]); // no "Paused · not on Wi-Fi" flash, no provider switch
  });

  it('leaving wi-fi while backgrounded, where the fresh answer is cellular, makes zero swiftly requests after resume', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(40);
    expectServing(chain, 'swiftly');
    app.set('background');
    chain.network.answer = 'CELLULAR'; // the phone leaves Wi-Fi while the app is suspended: no listener event reaches it
    await stepS(120);
    const resumed = chain.requests.length;
    app.set('active');
    await stepS(65);
    expect([chain.network.asks, swiftlyCalls(chain, resumed)]).toEqual([2, 0]);
    expect([firstTo(chain, resumed, 'vehicles'), firstTo(chain, resumed, 'predictions')]).toEqual(['transitland', 'transitland']);
    expectServing(chain, 'transitland');
  });

  it('if no answer comes within the timeout, transitland serves', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(40);
    expectServing(chain, 'swiftly');
    app.set('background');
    chain.network.answer = 'never';
    await stepS(120);
    const [resumed, resumedS] = [chain.requests.length, Date.now() / 1000];
    app.set('active');
    expect(await nextFetches(chain, resumed, 5)).toEqual({ vehicles: 'transitland', predictions: 'transitland' });
    expect(chain.requests[resumed]?.atS).toBe(resumedS + RESUME_READING_TIMEOUT_MS / 1000); // held until the timeout; then no reading, so not Wi-Fi
    await stepS(65);
    expect([swiftlyCalls(chain, resumed), latest(chain).swiftlyGated]).toEqual([0, true]);
    expectServing(chain, 'transitland');
  });
});

describe('Swiftly only on Wi-Fi (mfix10): Swiftly\'s 30 s floor and one failure per download', () => {
  it('switching back to swiftly 5 s after a swiftly vehicles request starts no new request until 30 s', async () => {
    const chain = chainRig('WIFI');
    await stepS(40);
    await toEveOfSwiftlyPoll(chain);
    await stepS(1);
    const [startedS, after] = [lastSwiftlyAtS(chain), chain.requests.length];
    expect(chain.requests.filter((request) => request.url === SWIFTLY_VEHICLES_URL && request.atS === startedS)).toHaveLength(1);
    chain.network.emit('CELLULAR');
    await stepS(4);
    expect(firstTo(chain, after, 'vehicles')).toBe('transitland');
    chain.network.emit('WIFI');
    await stepS(1); // 5 s after Swiftly's vehicles request: both tasks switch back to Swiftly
    expectServing(chain, 'swiftly');
    await stepS(SWIFTLY_CADENCE_S - 6);
    expect(swiftlyCalls(chain, after)).toBe(0); // 29 s after it: nothing new
    await stepS(10);
    expect((chain.requests.slice(after).find((request) => request.provider === 'swiftly')?.atS ?? Number.NaN) - startedS).toBeGreaterThanOrEqual(SWIFTLY_CADENCE_S);
  });

  it('a download cut by leaving wi-fi, back on wi-fi within 30 s, with 3 watched stations, records zero failures and swiftly is not benched', async () => {
    const chain = chainRig('WIFI', { stations: THREE_STATIONS });
    await stepS(40);
    expectServing(chain, 'swiftly');
    await toEveOfSwiftlyPoll(chain);
    chain.downloads.holding = true;
    const [cut, published] = [chain.requests.length, chain.states.length];
    await stepS(1); // Swiftly's vehicles download and its ONE trip-updates download, read by all 3 stations, start and hang
    expect(swiftlyCalls(chain, cut)).toBe(2);
    chain.network.emit('CELLULAR');
    await stepS(1);
    expect(chain.downloads.cutAll()).toBe(2); // 4 polls fail with them while Swiftly is gated
    await stepS(4); // Transitland serves meanwhile
    chain.network.emit('WIFI');
    await stepS(SWIFTLY_CADENCE_S); // back inside the floor: every Swiftly poll reuses a cut download
    expect([swiftlyCalls(chain, cut), failureTraces(chain, published)]).toEqual([2, []]);
    expectServing(chain, 'swiftly');
  });

  it('a swiftly poll cut by leaving wi-fi records no failure, so swiftly serves at the next tick back on wi-fi', async () => {
    const chain = chainRig('WIFI');
    await stepS(40);
    await toEveOfSwiftlyPoll(chain);
    chain.downloads.holding = true;
    const cut = chain.requests.length;
    await stepS(1); // Swiftly's next poll starts on Wi-Fi, for both capabilities, and hangs
    chain.network.emit('CELLULAR');
    await stepS(1); // gated now: no new Swiftly request, and the two in flight may still finish
    expect([chain.downloads.cutAll(), swiftlyCalls(chain, cut)]).toEqual([2, 2]); // they fail while Swiftly is gated
    await stepS(SWIFTLY_CADENCE_S); // past Swiftly's 30 s floor on the cut downloads, so the return downloads afresh
    expectServing(chain, 'transitland');
    const [states, requests] = [chain.states.length, chain.requests.length];
    chain.network.emit('WIFI');
    expect(await nextFetches(chain, requests, 1)).toEqual({ vehicles: 'swiftly', predictions: 'swiftly' });
    const takeover = chain.states.slice(states).find((state) => state.status.vehicles.provider === 'swiftly');
    expect([takeover?.status.vehicles.consecutiveFailures, takeover?.status.predictions.consecutiveFailures, swiftlyCalls(chain, cut)]).toEqual([0, 0, 4]);
    await stepS(1);
    expectServing(chain, 'swiftly');
  });
});
