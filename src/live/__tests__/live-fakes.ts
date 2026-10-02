import type { NetworkState } from 'expo-network';

import type { RuntimeNetwork } from '../../data/live-network';
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
 * expo-network's state for a network type, connected unless the type is NONE or UNKNOWN (as on iOS);
 * `null` is a state without a type (connected, type unknown).
 */
export function networkState(type: string | null): NetworkState {
  const connected = type !== 'NONE' && type !== 'UNKNOWN';
  const state = (type === null ? { isConnected: true, isInternetReachable: true } : { type, isConnected: connected, isInternetReachable: connected }) as NetworkState;
  expect(state.type ?? null).toBe(type);
  expect(typeof state.isConnected).toBe('boolean');
  return state;
}

/** One listener the fake network handed out, and whether its subscription was removed. */
export type FakeListener = { readonly listener: (state: NetworkState) => void; removed: boolean };

/**
 * The phone's network, standing in for expo-network as a runtime's `networkSource`: the first answer
 * is networkState(`first`), or never lands for 'never'; `emit` plays a network change to every listener
 * still subscribed. It counts the first-answer asks and keeps every listener it handed out.
 */
export class FakeNetwork implements NetworkSource {
  readonly listeners: FakeListener[] = [];
  asks = 0;

  constructor(private readonly first: string | null | 'never') {
    expect(first === null || first.length > 0).toBe(true);
    expect(this.listeners).toEqual([]);
  }

  getNetworkStateAsync(): Promise<NetworkState> {
    this.asks += 1;
    expect(this.asks).toBeGreaterThan(0);
    expect(this.first).not.toBe('');
    return this.first === 'never' ? new Promise<NetworkState>(() => undefined) : Promise.resolve(networkState(this.first));
  }

  addNetworkStateListener(listener: (state: NetworkState) => void): { remove(): void } {
    const entry: FakeListener = { listener, removed: false };
    this.listeners.push(entry);
    expect(typeof listener).toBe('function');
    expect(this.listeners).toContain(entry);
    return { remove: () => void (entry.removed = true) };
  }

  /** The listeners still subscribed. */
  open(): FakeListener[] {
    const open = this.listeners.filter((entry) => !entry.removed);
    expect(open.length).toBeLessThanOrEqual(this.listeners.length);
    expect(open.every((entry) => !entry.removed)).toBe(true);
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
