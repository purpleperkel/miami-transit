import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { HEARTBEAT_MS, PROVIDER_CONFIG } from '../../domain/live/constants';
import type { FetchFn, FetchResponseLike, HttpInit } from '../http';
import type { SecretStore } from '../keys';
import type { SyncKeyValue } from '../quota-store';
import { LiveRuntime, type LiveState, RESUME_READING_TIMEOUT_MS } from '../runtime';
import { readSwiftlyWifiOnly, saveSwiftlyWifiOnly } from '../swiftly-wifi';
import { type AppStateSource, bindRuntime } from '../use-live-polling';
import { bothProviders, FakeNetwork, type FakeServer, HANGS, runtimeNetwork, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

/**
 * mfix10 "use Swiftly only on Wi-Fi": the provider chain under the gate, on a REAL LiveRuntime with both
 * (fake) keys. Both providers are answered by a fake server through a call spy on fetch, which records
 * each request and its instant; the phone's network is a FakeNetwork (the runtime's `networkSource`);
 * the setting is the real module over an in-memory kv store; the heartbeat is the real AppState-gated
 * binding on jest's fake clock, stepped one heartbeat (1 s) at a time. The app stays active, unless a
 * test moves it through a HandAppState (a resume then holds the poller until the network's fresh answer
 * is in); a test can hold Swiftly's downloads open and then cut them, as leaving Wi-Fi does, or have a
 * URL of the fake server hang until its request is aborted (HANGS). A held or hanging download honours
 * its request's abort signal, as a real fetch does.
 */

const STATION = 'rail:government-ctr';
/** Three watched stations, every one reading Swiftly's ONE whole-agency trip-updates download. */
const THREE_STATIONS = ['rail:government-ctr', 'rail:brickell', 'mover:government-center'];
const T0_MS = Date.UTC(2026, 9, 1, 12);
const SWIFTLY_CADENCE_S = PROVIDER_CONFIG.swiftly.cadenceS;
const TL_CADENCE_S = PROVIDER_CONFIG.transitland.cadenceS;
const SERVER_DOWN = { status: 503, body: new Uint8Array(0) };
const ACTIVE: AppStateSource = { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) };

type Provider = 'swiftly' | 'transitland';
type AppStatus = NonNullable<AppStateSource['currentState']>;
/** A request as the call spy saw it: when it started on the wall clock (s) and on the awake clock (performance.now(), ms). */
type Request = { readonly url: string; readonly provider: Provider; readonly capability: 'vehicles' | 'predictions'; readonly atS: number; readonly awakeMs: number };
type RigOptions = { readonly wifiOnly?: boolean; readonly app?: AppStateSource; readonly stations?: readonly string[]; readonly awakeMs?: () => number };
type Chain = {
  readonly runtime: LiveRuntime;
  readonly network: FakeNetwork;
  readonly downloads: HeldDownloads;
  /** The fake server behind the call spy: a test may change what a URL answers. */
  readonly server: FakeServer;
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

/** One download the test holds open. */
type HeldDownload = { readonly url: string; readonly fail: (error: Error) => void };

/**
 * Swiftly downloads the test holds open while `holding`, then cuts, as leaving Wi-Fi does mid-download.
 * A held download whose request is aborted rejects at once, as a real fetch does (mfix10 fix round 5).
 */
class HeldDownloads {
  holding = false;
  /** How many held downloads ended because their request was aborted. */
  aborted = 0;
  private readonly held: HeldDownload[] = [];

  /** A download of `url` that hangs until cutAll(), or until `signal` aborts it. */
  hold(url: string, signal: AbortSignal): Promise<FetchResponseLike> {
    expect(this.held.map((download) => download.url)).not.toContain(url); // one download per endpoint at a time (Swiftly's 30 s floor)
    expect(this.held.length).toBeLessThan(2); // at most its vehicles and its ONE shared trip-updates download
    return new Promise<FetchResponseLike>((_resolve, reject) => {
      const download: HeldDownload = { url, fail: reject };
      this.held.push(download);
      signal.addEventListener('abort', () => this.abort(download), { once: true });
    });
  }

  /** The held downloads still open. */
  get open(): number {
    expect(this.held.every((download) => download.url.startsWith('https://api.goswift.ly/'))).toBe(true); // only Swiftly's downloads are held
    expect(this.aborted).toBeGreaterThanOrEqual(0);
    return this.held.length;
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

  /** `download`'s request was aborted: if it is still held, it rejects now, as fetch does. One cut first stays cut. */
  private abort(download: HeldDownload): void {
    const at = this.held.indexOf(download);
    const before = this.aborted;
    if (at >= 0) {
      this.held.splice(at, 1);
      this.aborted += 1;
      download.fail(new Error(`the request to ${download.url} was aborted`));
    }
    expect(this.held).not.toContain(download); // an aborted download is held no more
    expect(this.aborted).toBe(at >= 0 ? before + 1 : before);
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
 * `app` the app's foreground state (active throughout by default), and `awakeMs` the phone's awake
 * clock (performance.now(), on jest's fake clock, by default).
 */
function chainRig(first: string | 'never', { wifiOnly, app = ACTIVE, stations = [STATION], awakeMs }: RigOptions = {}): Chain {
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
    requests.push({ url, ...classify(url), atS: Date.now() / 1000, awakeMs: performance.now() });
    return downloads.holding && classify(url).provider === 'swiftly' ? downloads.hold(url, init.signal) : server.fetch(url, init);
  });
  const quota = new Map<string, number>();
  const network = new FakeNetwork(first);
  const states: LiveState[] = [];
  const quotaStore = { get: (key: string) => quota.get(key) ?? null, set: (key: string, n: number) => void quota.set(key, n) };
  const wifi = { networkSource: network, swiftlyWifiOnly: () => readSwiftlyWifiOnly(settings) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secrets, quotaStore, monotonicMs: awakeMs, ...wifi });
  runtime.watchStations(stations);
  teardowns.push(bindRuntime(runtime, app, HEARTBEAT_MS));
  expect(network.open()).toHaveLength(1);
  return { runtime, network, downloads, server, fetch, requests, states, quota };
}

/** Steps the fake clock `seconds` heartbeats, one at a time, letting each tick's requests finish. */
async function stepS(seconds: number): Promise<void> {
  expect(seconds).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(seconds)).toBe(true); // whole heartbeats: a fraction would round up to one more
  for (let i = 0; i < seconds; i += 1) {
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
  }
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
  expect(after.every((request) => request.capability === 'vehicles' || request.url === SWIFTLY_TRIP_UPDATES_URL || request.url.includes('/departures?'))).toBe(true); // a known feed: classify reads any other URL as predictions
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
  expect(chain.downloads.open).toBe(0); // every held download has ended (cut or aborted), so every poll has been settled
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

describe('Swiftly only on Wi-Fi (mfix10 fix round 4): Swiftly\'s floor sets when a turned-away poll is due', () => {
  it('a poll the floor turns away is due again when the floor ends, not a cadence later', async () => {
    const chain = chainRig('WIFI');
    await stepS(1); // the mount's hold lifts: Swiftly downloads both feeds
    const startedS = lastSwiftlyAtS(chain);
    await stepS(4);
    chain.network.emit('CELLULAR');
    await stepS(1); // Transitland takes both tasks
    chain.network.emit('WIFI');
    await stepS(1); // Swiftly takes them back, due at once, 6 s after its downloads: the floor turns both polls away
    expect([swiftlyCalls(chain), Date.now() / 1000 - startedS]).toEqual([2, 6]);
    expectServing(chain, 'swiftly');
    await stepS(SWIFTLY_CADENCE_S);
    const starts = chain.requests.filter((request) => request.provider === 'swiftly').map((request) => [request.url, request.atS - startedS]);
    const floorEndsS = SWIFTLY_CADENCE_S; // 30 s after the downloads; a cadence after the turned-away polls would be 36 s
    expect(starts.sort()).toEqual([[SWIFTLY_TRIP_UPDATES_URL, 0], [SWIFTLY_TRIP_UPDATES_URL, floorEndsS], [SWIFTLY_VEHICLES_URL, 0], [SWIFTLY_VEHICLES_URL, floorEndsS]]);
  });
});

describe('Swiftly only on Wi-Fi (mfix10): the 30 s floor runs on a monotonic millisecond clock', () => {
  it('a start at .95 s allows no new start at +30.05 s of wall time while fewer than 30 000 ms have passed', async () => {
    jest.setSystemTime(T0_MS + 950); // the wall clock reads x.95 s; performance.now(), the monotonic clock, does not move
    const chain = chainRig('WIFI');
    await stepS(1); // the mount's hold lifts: Swiftly downloads both feeds
    const startS = lastSwiftlyAtS(chain);
    expect([swiftlyCalls(chain), Math.round((startS % 1) * 100)]).toEqual([2, 95]);
    await stepS(28); // 28 000 ms after the start
    jest.setSystemTime(Date.now() + 1_050); // the wall clock is corrected 1.05 s forward
    await stepS(1); // wall: +30.05 s after the start, so both Swiftly tasks are due; monotonic: 29 000 ms, so the floor turns both away
    expect([Math.round(Date.now() - startS * 1_000), swiftlyCalls(chain)]).toEqual([30_050, 2]);
    await stepS(1); // 30 000 ms after the start: the floor ends, and the polls it turned away are due then (fix round 4)
    expect(chain.fetch.mock.calls.slice(2).map(([url]) => url).sort()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL]);
  });

  it('a forward wall-clock jump of +40 s does not end the floor', async () => {
    const chain = chainRig('WIFI');
    await stepS(1);
    const startS = lastSwiftlyAtS(chain);
    await stepS(4);
    jest.setSystemTime(Date.now() + 40_000); // the phone's clock jumps 40 s ahead: every task is due at once
    await stepS(25); // monotonic: 29 000 ms after the start
    expect([Math.round(Date.now() - startS * 1_000), swiftlyCalls(chain)]).toEqual([69_000, 2]);
    await stepS(1); // 30 000 ms after the start: the floor ends, and the polls it turned away are due then
    expect(chain.fetch.mock.calls.slice(2).map(([url]) => url).sort()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL]);
    expect(chain.requests.filter((request) => request.provider === 'transitland')).toEqual([]);
  });
});

describe('Swiftly only on Wi-Fi (mfix10): the floor clock counts the phone\'s sleep', () => {
  it('after a lock longer than 30 s, the first poll on unlock downloads fresh swiftly data', async () => {
    const app = new HandAppState();
    const asleep = { ms: 0 };
    const chain = chainRig('WIFI', { app, awakeMs: () => performance.now() - asleep.ms }); // performance.now() as iOS reads it: stopped while the phone sleeps
    await stepS(40);
    const lastS = lastSwiftlyAtS(chain);
    expect(Date.now() / 1000 - lastS).toBe(9); // Swiftly downloaded both feeds 9 s before the lock
    app.set('background'); // the phone locks
    for (let s = 0; s < 40; s += 1) {
      await stepS(1);
      asleep.ms += HEARTBEAT_MS; // 40 s asleep: the wall clock runs, the awake clock does not
    }
    const unlocked = chain.fetch.mock.calls.length;
    app.set('active'); // unlocked: the runtime asks the network and holds until the next heartbeat
    await stepS(1); // the first poll on unlock: 50 s after Swiftly's downloads, only 10 s of them awake
    expect(chain.fetch.mock.calls.slice(unlocked).map(([url]) => url).sort()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL]);
    expectServing(chain, 'swiftly');
  });

  it('a trip to another app with the phone awake does not count twice toward the floor', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(32);
    const lastS = lastSwiftlyAtS(chain); // Swiftly downloaded both feeds 1 s ago
    app.set('background'); // another app: the phone stays awake, so performance.now() runs on
    await stepS(20);
    app.set('active');
    await stepS(1); // the hold lifts; the tasks are due one cadence after their last start
    const back = chain.fetch.mock.calls.length;
    chain.runtime.watchStations([STATION, 'rail:brickell']); // a new station: its poll is due at once, inside the floor
    await stepS(lastS + SWIFTLY_CADENCE_S - 1 - Date.now() / 1000); // to 29 s after Swiftly's downloads
    expect(swiftlyCalls(chain, back)).toBe(0); // 20 s away, all of them awake, are counted once: the floor turns that poll away
    await stepS(1); // the floor ends
    expect(chain.fetch.mock.calls.slice(back).map(([url]) => url).sort()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL]);
  });
});

describe('Swiftly only on Wi-Fi (mfix10 fix round 5): leaving the foreground aborts every poll in flight', () => {
  it('a swiftly request frozen through a long lock is aborted, and the first poll on unlock downloads fresh data', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(1); // the mount's hold lifts: Swiftly downloads both feeds
    await toEveOfSwiftlyPoll(chain);
    chain.downloads.holding = true;
    const [held, published] = [chain.fetch.mock.calls.length, chain.states.length];
    await stepS(1); // Swiftly's next poll starts, for both feeds, and hangs
    expect([swiftlyCalls(chain, held), chain.downloads.open]).toEqual([2, 2]);
    app.set('background'); // the phone locks with both requests in flight
    jest.setSystemTime(Date.now() + 40_000); // 40 s asleep: the wall clock moves; performance.now() (the awake clock) and every JS timer stand still, as on iOS
    chain.downloads.holding = false;
    const unlocked = chain.fetch.mock.calls.length;
    app.set('active'); // unlocked: the runtime asks the network and holds until the next heartbeat
    await stepS(2);
    expect(chain.fetch.mock.calls.slice(unlocked).map(([url]) => url).sort()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL]);
    expect([chain.downloads.aborted, failureTraces(chain, published)]).toEqual([2, []]); // both were aborted, and their polls left no trace
    expectServing(chain, 'swiftly');
  });

  it('a short trip to another app aborts the poll in flight, and the floor still holds', async () => {
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(1); // the mount's hold lifts: Swiftly downloads both feeds
    await toEveOfSwiftlyPoll(chain);
    chain.downloads.holding = true;
    const [held, published] = [chain.requests.length, chain.states.length];
    await stepS(1); // Swiftly's next poll starts, for both feeds, and hangs
    const abortedMs = Math.max(...chain.requests.slice(held).map((request) => request.awakeMs));
    app.set('background'); // another app: the phone stays awake, so the floor clock is performance.now() (no sleep to count)
    await stepS(5);
    expect([chain.downloads.aborted, chain.downloads.open]).toEqual([2, 0]); // leaving the foreground aborted both
    chain.downloads.holding = false;
    app.set('active');
    await stepS(60);
    const later = chain.requests.slice(held + 2).filter((request) => request.provider === 'swiftly');
    expect(later.length).toBeGreaterThan(0); // Swiftly polls again within the minute, so the floor check below is not vacuous
    expect(later.filter((request) => request.awakeMs - abortedMs < SWIFTLY_CADENCE_S * 1_000)).toEqual([]); // none within 30 000 floor-ms of the aborted ones
    expect([Date.now() - performance.now(), failureTraces(chain, published)]).toEqual([T0_MS, []]); // wall and awake clocks moved together: the floor clock counted no sleep
    expectServing(chain, 'swiftly');
  });
});

/** When each request to `url` started, in s after T0 (whole seconds unless the test set the wall clock's phase). */
function startsS(chain: Chain, url: string): number[] {
  const starts = chain.requests.filter((request) => request.url === url).map((request) => request.atS - T0_MS / 1_000);
  expect(starts.every((atS) => atS >= 0)).toBe(true);
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  return starts;
}

describe('Swiftly only on Wi-Fi (mfix10 fix round 6): a poll a pause aborts keeps its task\'s state', () => {
  it('a transitland poll in flight at a pause is retried no sooner than its cadence', async () => {
    const app = new HandAppState();
    const chain = chainRig('CELLULAR', { app }); // Swiftly gated: Transitland serves both capabilities
    await stepS(1); // the mount's hold lifts: Transitland's vehicles poll at 1 s
    chain.server.on(TL_VEHICLES_URL, HANGS);
    await stepS(TL_CADENCE_S); // its next one starts at 61 s, and hangs
    const published = chain.states.length;
    app.set('background'); // another app: the poll in flight is aborted
    chain.server.on(TL_VEHICLES_URL, { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES });
    await stepS(5);
    app.set('active'); // back at 66 s: the hold lifts at 67 s
    await stepS(TL_CADENCE_S);
    expect(startsS(chain, TL_VEHICLES_URL)).toEqual([1, 61, 121]); // a cadence after the aborted start, not at the first heartbeat back (67 s): no extra metered call
    expect(failureTraces(chain, published)).toEqual([]); // the aborted poll left no trace
    expectServing(chain, 'transitland');
  });

  it('a pause during a failing provider\'s request keeps its backoff', async () => {
    const app = new HandAppState();
    const chain = chainRig('CELLULAR', { app }); // Transitland alone serves, so it keeps serving while it fails
    chain.server.on(TL_VEHICLES_URL, SERVER_DOWN);
    await stepS(300); // its vehicles fail at 1, 61, 121 and 181 s; R-b backs the 4th failure off 120 s, to 301 s
    chain.server.on(TL_VEHICLES_URL, HANGS);
    await stepS(1); // the 5th try starts at 301 s, and hangs
    const published = chain.states.length;
    app.set('background'); // the pause aborts it
    chain.server.on(TL_VEHICLES_URL, SERVER_DOWN);
    await stepS(5);
    app.set('active');
    await stepS(185); // through 491 s
    expect(startsS(chain, TL_VEHICLES_URL)).toEqual([1, 61, 121, 181, 301, 361, 481]); // retried a cadence after the aborted start; the next failure backs off 120 s from the 4 kept
    expect(latest(chain).status.vehicles).toMatchObject({ provider: 'transitland', failing: true, consecutiveFailures: 6, lastError: { kind: 'http', status: 503 } });
    expect(chain.states.slice(published).filter((state) => state.status.vehicles.lastError?.kind === 'timeout')).toEqual([]); // the aborted request's cancellation never shows
  });
});

describe('Swiftly only on Wi-Fi (mfix10 fix round 6): an aborted download inside Swiftly\'s floor is a floor-wait', () => {
  it('after a short trip away with a swiftly download in flight, fresh data comes when the floor ends, not a cadence later', async () => {
    jest.setSystemTime(T0_MS + 600); // the wall clock reads x.6 s at every heartbeat; performance.now() and the timers do not move
    const app = new HandAppState();
    const chain = chainRig('WIFI', { app });
    await stepS(SWIFTLY_CADENCE_S); // Swiftly downloads both feeds at the first heartbeat; its next poll is due a cadence on
    chain.downloads.holding = true;
    const [held, published] = [chain.requests.length, chain.states.length];
    await stepS(1); // that poll starts, for both feeds, and hangs
    expect([swiftlyCalls(chain, held), chain.downloads.open]).toEqual([2, 2]);
    const abortedMs = Math.max(...chain.requests.slice(held).map((request) => request.awakeMs));
    app.set('background'); // another app, the phone awake: both requests are aborted
    await stepS(5); // away 5 s, the heartbeat stopped,
    await jest.advanceTimersByTimeAsync(400); // and 0.4 s more (steps of <= 1 s): the heartbeat comes back at a new phase against the second (x.0 s)
    chain.downloads.holding = false;
    app.set('active');
    await stepS(2 * SWIFTLY_CADENCE_S + 5); // the first poll back lands 29.4 s into the aborted downloads' floor: turned away with nothing to hand back
    const freshMs = chain.requests.slice(held + 2).filter((request) => request.provider === 'swiftly').map((request) => request.awakeMs - abortedMs);
    expect(freshMs.length).toBeGreaterThan(0); // Swiftly downloads again, so the window below is not vacuous
    const firstMs = Math.min(...freshMs);
    expect(firstMs).toBeGreaterThanOrEqual(SWIFTLY_CADENCE_S * 1_000); // never inside the floor
    expect(firstMs).toBeLessThanOrEqual(SWIFTLY_CADENCE_S * 1_000 + HEARTBEAT_MS); // at most one heartbeat after it ends (a backoff would wait a cadence more)
    expect([chain.downloads.aborted, failureTraces(chain, published)]).toEqual([2, []]); // no failure, bench or error recorded
    expectServing(chain, 'swiftly');
  });
});
