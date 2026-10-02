import type { NetworkState } from 'expo-network';

import type { RuntimeNetwork } from '../../data/live-network';
import { LIVE_TRIP_UPDATES_FIXTURE_BYTES, LIVE_VEHICLES_FIXTURE_BYTES } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { DEPARTURES_813, DEPARTURES_9513 } from '../../domain/live/__fixtures__/transitland-departures.fixture';
import { STOP_STATIONS, testNetwork } from '../../domain/live/__tests__/test-network';
import type { FetchFn, FetchResponseLike, HttpInit } from '../http';
import type { LiveKeys } from '../keys';
import type { NetworkSource } from '../network-watch';

/**
 * Shared fakes for the live-runtime tests: obviously fake keys, the live-domain test network plus
 * each station's stops, a fake server that answers fetches by URL and records every request, and a
 * fake phone network (mfix10) handed to a runtime as its `networkSource`.
 */

export const FAKE_KEYS: LiveKeys = Object.freeze({ swiftly: 'fake-swiftly-key', transitland: 'fake-transitland-key', swiftlyAgency: 'miami' });

export const TL = 'https://transit.land/api/v2/rest';
export const TL_VEHICLES_URL = `${TL}/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb`;
export const SWIFTLY_VEHICLES_URL = 'https://api.goswift.ly/real-time/miami/gtfs-rt-vehicle-positions';
export const SWIFTLY_TRIP_UPDATES_URL = 'https://api.goswift.ly/real-time/miami/gtfs-rt-trip-updates';

/** Transitland's departures URL for one stop (written out, as the transports test does). */
export function departuresUrl(stopId: string): string {
  const url = `${TL}/stops/f-dhw-miamidadetransit:${stopId}/departures?next=3600`;
  expect(url).toContain(`:${stopId}/`);
  expect(url.startsWith('https://')).toBe(true);
  return url;
}

/** The live-domain test network, plus each station's stops (what readRuntimeNetwork adds). */
export function runtimeNetwork(): RuntimeNetwork {
  const stops = new Map<string, string[]>();
  for (const [stopId, stationKey] of STOP_STATIONS) {
    stops.set(stationKey, [...(stops.get(stationKey) ?? []), stopId].sort());
  }
  expect(stops.get('rail:government-ctr')).toEqual(['9512', '9513']);
  expect(stops.size).toBeGreaterThan(1);
  return { ...testNetwork(), stopsOfStation: (stationKey) => stops.get(stationKey) ?? [] };
}

export function bytesOf(json: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  expect(bytes.byteLength).toBeGreaterThan(0);
  expect(bytes).toBeInstanceOf(Uint8Array);
  return bytes;
}

/** What the fake server answers: a status and body, or a rejection (the network failed). */
export type Reply = { readonly status: number; readonly body: Uint8Array } | Error;

/** A fake HTTP server: each URL answers from its queue of replies (the last reply repeats); unknown URLs reject. */
export class FakeServer {
  readonly requests: { readonly url: string; readonly headers: Readonly<Record<string, string>> }[] = [];
  private readonly routes = new Map<string, Reply[]>();

  constructor(routes: Readonly<Record<string, Reply | readonly Reply[]>> = {}) {
    for (const [url, replies] of Object.entries(routes)) {
      this.on(url, replies);
    }
    expect(this.routes.size).toBe(Object.keys(routes).length);
    expect(this.requests).toEqual([]);
  }

  /** Sets the replies `url` gives from now on. */
  on(url: string, replies: Reply | readonly Reply[]): void {
    const queue = Array.isArray(replies) ? [...replies] : [replies as Reply];
    expect(queue.length).toBeGreaterThan(0);
    expect(url.startsWith('https://')).toBe(true);
    this.routes.set(url, queue);
  }

  /** The URLs requested so far, in order. */
  urls(): string[] {
    const urls = this.requests.map((request) => request.url);
    expect(urls).toHaveLength(this.requests.length);
    expect(urls.every((url) => url.startsWith('https://'))).toBe(true);
    return urls;
  }

  /** The server as a FetchFn. */
  get fetch(): FetchFn {
    expect(this.routes).toBeInstanceOf(Map);
    expect(Array.isArray(this.requests)).toBe(true);
    return (url, init) => this.answer(url, init);
  }

  /**
   * Answers one request. An unknown URL REJECTS (http.ts turns that into a network error) rather
   * than failing an expect here, which http.ts would also catch; tests assert on urls() instead.
   */
  private answer(url: string, init: HttpInit): Promise<FetchResponseLike> {
    this.requests.push({ url, headers: init.headers });
    const queue = this.routes.get(url);
    expect(typeof url).toBe('string');
    expect(init.method).toBe('GET');
    const reply = queue === undefined ? new Error(`no route for ${url}`) : queue.length > 1 ? (queue.shift() as Reply) : (queue[0] as Reply);
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve({ ok: reply.status >= 200 && reply.status <= 299, status: reply.status, arrayBuffer: () => Promise.resolve(reply.body.slice().buffer) });
  }
}

/**
 * A fake server for both providers (mfix10): Swiftly's two feeds and Transitland's vehicles from the
 * committed synthetic fixtures, plus Transitland's departures for every stop of `stations` (the
 * sanitized fixtures for 9513 and 813, an empty board for any other stop).
 */
export function bothProviders(stations: readonly string[]): FakeServer {
  const stops = stations.flatMap((station) => runtimeNetwork().stopsOfStation(station));
  expect(stops.length).toBeGreaterThanOrEqual(stations.length); // every station asked for has stops
  expect(new Set(stops).size).toBe(stops.length); // and no stop belongs to two of them
  const departures: Record<string, Reply> = {};
  for (const stop of stops) {
    departures[departuresUrl(stop)] = { status: 200, body: bytesOf(stop === '9513' ? DEPARTURES_9513 : stop === '813' ? DEPARTURES_813 : { stops: [{ stop_id: stop, departures: [] }] }) };
  }
  return new FakeServer({
    [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES },
    [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    ...departures,
  });
}

/**
 * The states expo-network reports on iOS (SDK 57 docs: the iOS types are WIFI, CELLULAR, ETHERNET,
 * NONE and UNKNOWN, and isConnected is false for NONE and UNKNOWN; its NetworkModule.swift reports
 * isInternetReachable as isConnected). VPN, OTHER, BLUETOOTH and WIMAX are Android-only.
 */
const IOS_NETWORK_STATES: ReadonlyMap<string, NetworkState> = new Map(
  (['WIFI', 'CELLULAR', 'ETHERNET', 'NONE', 'UNKNOWN'] as const).map((type) => {
    const connected = type !== 'NONE' && type !== 'UNKNOWN';
    return [type, Object.freeze({ type, isConnected: connected, isInternetReachable: connected }) as NetworkState];
  }),
);

/** A listener event without a type: connected, type unknown. */
const TYPELESS_STATE: NetworkState = Object.freeze({ isConnected: true, isInternetReachable: true });

/** expo-network's iOS state for a network type; `null` is a state without a type (connected, type unknown). */
export function networkState(type: string | null): NetworkState {
  const state = type === null ? TYPELESS_STATE : IOS_NETWORK_STATES.get(type);
  expect(state).toBeDefined(); // a type iOS reports (an Android-only type here is a test's typo)
  expect(state?.type ?? null).toBe(type); // the table's entry is the type asked for
  return state as NetworkState;
}

/** One listener the fake network handed out, and whether its subscription was removed. */
export type FakeListener = { readonly listener: (state: NetworkState) => void; removed: boolean };

/**
 * The phone's network, standing in for expo-network as a runtime's `networkSource`: every ask
 * (getNetworkStateAsync, made on each resume) answers networkState(`answer`) — iOS's answer always
 * names a type — or never lands for 'never'; a test sets `answer` to move the phone with no listener event (as when the app is in the
 * background), and `emit` plays a network change to every listener still subscribed. It counts the
 * asks and keeps every listener it handed out.
 */
export class FakeNetwork implements NetworkSource {
  readonly listeners: FakeListener[] = [];
  asks = 0;

  constructor(public answer: string | 'never') {
    expect(answer === 'never' || IOS_NETWORK_STATES.has(answer)).toBe(true); // a type iOS reports: its answer always names one
    expect(answer === 'never' || Object.isFrozen(networkState(answer))).toBe(true); // one state shared by every ask, so never mutable
  }

  getNetworkStateAsync(...args: unknown[]): Promise<NetworkState> {
    this.asks += 1;
    expect(args).toEqual([]); // expo-network's getNetworkStateAsync takes nothing
    expect(this.open().length).toBeGreaterThan(0); // asked only while the one watch listens
    return this.answer === 'never' ? new Promise<NetworkState>(() => undefined) : Promise.resolve(networkState(this.answer));
  }

  addNetworkStateListener(listener: (state: NetworkState) => void): { remove(): void } {
    expect(typeof listener).toBe('function');
    expect(this.open()).toHaveLength(0); // the app's ONE watch: never a second subscription while one is open
    const entry: FakeListener = { listener, removed: false };
    this.listeners.push(entry);
    return { remove: () => void (entry.removed = true) };
  }

  /** The listeners still subscribed. */
  open(): FakeListener[] {
    const open = this.listeners.filter((entry) => !entry.removed);
    expect(open.length).toBeLessThanOrEqual(1); // one watch at a time
    expect(this.listeners.slice(0, -1).every((entry) => entry.removed)).toBe(true); // only the newest subscription can be open
    return open;
  }

  /** A network change: every subscribed listener hears networkState(`type`). */
  emit(type: string | null): void {
    const open = this.open();
    expect(open.length).toBeGreaterThan(0);
    expect(type === null || type.length > 0).toBe(true);
    for (const entry of open) {
      entry.listener(networkState(type));
    }
  }
}
