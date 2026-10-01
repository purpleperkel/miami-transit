import type { RuntimeNetwork } from '../../data/live-network';
import { STOP_STATIONS, testNetwork } from '../../domain/live/__tests__/test-network';
import type { FetchFn, FetchResponseLike, HttpInit } from '../http';
import type { LiveKeys } from '../keys';

/**
 * Shared fakes for the live-runtime tests: obviously fake keys, the live-domain test network plus
 * each station's stops, and a fake server that answers fetches by URL and records every request.
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
