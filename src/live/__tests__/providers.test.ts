import {
  LIVE_TRIP_UPDATES_FIXTURE_BYTES,
  LIVE_VEHICLES_FIXTURE_BYTES,
  LIVE_VEHICLES_FIXTURE_DECODED,
} from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { DEPARTURES_9513 } from '../../domain/live/__fixtures__/transitland-departures.fixture';
import { testNetwork } from '../../domain/live/__tests__/test-network';
import { vehiclesFromFeed } from '../../domain/live/from-gtfsrt';
import { predictionsFromDepartures } from '../../domain/live/from-transitland-departures';
import type { LiveRequest } from '../../domain/live/transports';
import type { LivePrediction, LiveProvider, LiveResult, ProviderId } from '../../domain/live/types';
import { ByteCounter, httpGet } from '../http';
import type { LiveKeys } from '../keys';
import type { ProviderDeps } from '../providers/batches';
import { NONE_PROVIDER } from '../providers/none';
import { createSwiftlyProvider } from '../providers/swiftly';
import { createTransitlandProvider } from '../providers/transitland';
import { bytesOf, departuresUrl, FAKE_KEYS, FakeServer, runtimeNetwork, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL, TL_VEHICLES_URL } from './live-fakes';

/**
 * M4.9: the Transitland and Swiftly providers end to end over a fake server — request, quota call,
 * response bytes, decoder, mapper, batch — on the generated GTFS-rt fixtures and the sanitized
 * Transitland departures fixture. Keys are obviously fake.
 */

const NOW = 1_790_872_260;
const HTML = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]); // "<html>": a captive portal, not protobuf
const EMPTY_9512 = { stops: [{ stop_id: '9512', departures: [] }] };

/** The phone's two clocks: the wall clock in epoch seconds (`now`), and the monotonic one in milliseconds (`ms`, performance.now()'s). */
type Clocks = { now: number; ms: number };
type Deps = ProviderDeps & { readonly calls: ProviderId[]; readonly clock: Clocks };

/** Provider deps over `server`: quota calls are recorded, the wall clock is `deps.clock.now`, the monotonic one `deps.clock.ms`. */
function providerDeps(server: FakeServer, keys: LiveKeys = FAKE_KEYS): Deps {
  const calls: ProviderId[] = [];
  const clock: Clocks = { now: NOW, ms: 5_000 };
  const counter = new ByteCounter();
  const deps: Deps = {
    calls,
    clock,
    get: (request: LiveRequest, signal: AbortSignal) => httpGet(request, signal, { fetch: server.fetch, counter, nowS: () => clock.now }),
    keys: () => keys,
    network: runtimeNetwork(),
    recordCall: (provider: ProviderId) => void calls.push(provider),
    monotonicMs: () => clock.ms,
  };
  expect(deps.calls).toEqual([]);
  expect(deps.network.stopsOfStation('rail:government-ctr')).toEqual(['9512', '9513']);
  return deps;
}

/** `seconds` pass on both clocks, as they do on a phone whose clock is not being corrected. */
function advance(clock: Clocks, seconds: number): void {
  expect(seconds).toBeGreaterThan(0); // time moves forward
  expect(Number.isSafeInteger(clock.now + seconds)).toBe(true); // the wall clock reads whole seconds, as the runtime's wallClockS does
  clock.now += seconds;
  clock.ms += seconds * 1_000;
}

/** One fetch of each Swiftly feed — vehicles, then rail:brickell's predictions — in that order. */
async function fetchBoth(provider: LiveProvider): Promise<LiveResult<unknown>[]> {
  const results: LiveResult<unknown>[] = [await provider.fetchVehicles(signal()), await provider.fetchPredictions('rail:brickell', signal())];
  expect(provider.id).toBe('swiftly'); // the feeds are Swiftly's
  expect(results.every((result) => result.ok)).toBe(true); // the fake server answers both
  return results;
}

/** (trip, stop) of each prediction, in order. */
function rows(items: readonly LivePrediction[]): (string | null)[][] {
  const pairs = items.map((p) => [p.tripId, p.stopId]);
  expect(pairs).toHaveLength(items.length);
  expect(items.every((p) => p.routeId.length > 0)).toBe(true);
  return pairs;
}

/** A caller signal that never aborts. */
function signal(): AbortSignal {
  const live = new AbortController().signal;
  expect(live.aborted).toBe(false);
  expect(typeof live.addEventListener).toBe('function');
  return live;
}

describe('Transitland provider (M4.9)', () => {
  it('vehicles: the county vehicle_positions.pb with the apikey header, mapped exactly as the domain mapper maps it; one quota call', async () => {
    const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    const deps = providerDeps(server);
    const result = await createTransitlandProvider(deps).fetchVehicles(signal());
    expect(result.ok).toBe(true);
    const batch = result.ok ? result.value : null;
    expect(batch?.items).toEqual(vehiclesFromFeed(LIVE_VEHICLES_FIXTURE_DECODED, testNetwork()).items);
    expect(batch).toEqual(expect.objectContaining({ provider: 'transitland', fetchedAt: NOW, bytes: 1_337, feedTimestamp: 1_790_872_200 }));
    expect(server.requests).toEqual([{ url: TL_VEHICLES_URL, headers: { apikey: 'fake-transitland-key' } }]);
    expect(deps.calls).toEqual(['transitland']);
  });

  it('predictions: a station is asked stop by stop (9512, then 9513) — one quota call each — and the rows are combined', async () => {
    const server = new FakeServer({
      [departuresUrl('9512')]: { status: 200, body: bytesOf(EMPTY_9512) },
      [departuresUrl('9513')]: { status: 200, body: bytesOf(DEPARTURES_9513) },
    });
    const deps = providerDeps(server);
    const result = await createTransitlandProvider(deps).fetchPredictions('rail:government-ctr', signal());
    const expected = predictionsFromDepartures(DEPARTURES_9513, deps.network);
    expect(expected.ok && expected.value.items.length).toBeGreaterThan(0);
    expect(result.ok && rows(result.value.items)).toEqual(expected.ok && rows(expected.value.items));
    expect(result.ok && result.value.bytes).toBe(bytesOf(EMPTY_9512).byteLength + bytesOf(DEPARTURES_9513).byteLength);
    expect(server.urls()).toEqual([departuresUrl('9512'), departuresUrl('9513')]);
    expect(deps.calls).toEqual(['transitland', 'transitland']);
  });

  it('predictions: the first failing stop fails the station, and the next stop is not asked', async () => {
    const server = new FakeServer({ [departuresUrl('9512')]: { status: 503, body: new Uint8Array(0) } });
    const deps = providerDeps(server);
    const result = await createTransitlandProvider(deps).fetchPredictions('rail:government-ctr', signal());
    expect(!result.ok && result.error).toEqual({ kind: 'http', status: 503, message: 'transit.land answered HTTP 503' });
    expect(server.urls()).toEqual([departuresUrl('9512')]);
    expect(deps.calls).toEqual(['transitland']);
  });

  it('no key: nothing is sent and no quota is used', async () => {
    const server = new FakeServer();
    const deps = providerDeps(server, { ...FAKE_KEYS, transitland: null });
    const provider = createTransitlandProvider(deps);
    const results = [await provider.fetchVehicles(signal()), await provider.fetchPredictions('rail:brickell', signal())];
    expect(results.map((r) => !r.ok && r.error.kind)).toEqual(['no-key', 'no-key']);
    expect(server.requests).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  it('a body that is not GTFS-realtime, or departures that are not JSON, is a decode error — never a throw', async () => {
    const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: HTML }, [departuresUrl('813')]: { status: 200, body: HTML } });
    const provider = createTransitlandProvider(providerDeps(server));
    const vehicles = await provider.fetchVehicles(signal());
    const predictions = await provider.fetchPredictions('mover:government-center', signal());
    expect(!vehicles.ok && vehicles.error.kind).toBe('decode');
    expect(!vehicles.ok && vehicles.error.message).toMatch(/^transitland vehicle positions: /);
    expect(!predictions.ok && predictions.error.message).toMatch(/^transitland departures: the body is not JSON/);
  });
});

describe('Swiftly provider (M4.9)', () => {
  it('vehicles: gtfs-rt-vehicle-positions under the agency key, with "Authorization: <key>" (no Bearer)', async () => {
    const server = new FakeServer({
      [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
      'https://api.goswift.ly/real-time/mdt-test/gtfs-rt-vehicle-positions': { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES },
    });
    const first = await createSwiftlyProvider(providerDeps(server)).fetchVehicles(signal());
    await createSwiftlyProvider(providerDeps(server, { ...FAKE_KEYS, swiftlyAgency: 'mdt-test' })).fetchVehicles(signal());
    expect(first.ok && first.value.provider).toBe('swiftly');
    expect(first.ok && first.value.items.length).toBe(vehiclesFromFeed(LIVE_VEHICLES_FIXTURE_DECODED, testNetwork()).items.length);
    expect(server.requests.map((r) => r.headers)).toEqual([{ Authorization: 'fake-swiftly-key' }, { Authorization: 'fake-swiftly-key' }]);
    expect(server.urls()[1]).toBe('https://api.goswift.ly/real-time/mdt-test/gtfs-rt-vehicle-positions');
  });

  it('predictions: ONE trip-updates fetch serves every station asked within 30 s (Swiftly\'s cache rule); each gets its own rows plus trip-wide cancellations', async () => {
    const server = new FakeServer({ [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES } });
    const deps = providerDeps(server);
    const provider = createSwiftlyProvider(deps);
    const rail = await provider.fetchPredictions('rail:government-ctr', signal());
    advance(deps.clock, 29);
    const mover = await provider.fetchPredictions('mover:government-center', signal());
    // fixture-rail-0845's 9513 update is NO_DATA, which the M4.2 mapper drops (from-gtfsrt.test.ts).
    expect(rail.ok && rows(rail.value.items)).toEqual([['fixture-rail-0822', '9513'], ['fixture-rail-0830', null]]);
    expect(mover.ok && rows(mover.value.items)).toEqual([['fixture-rail-0830', null], ['fixture-omni-1630', '813']]); // feed order
    expect(server.urls()).toEqual([SWIFTLY_TRIP_UPDATES_URL]);
    expect(deps.calls).toEqual(['swiftly']);
  });

  it('predictions: a station asked 30 s after the shared fetch started gets a fresh fetch', async () => {
    const server = new FakeServer({ [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES } });
    const deps = providerDeps(server);
    const provider = createSwiftlyProvider(deps);
    await provider.fetchPredictions('rail:brickell', signal());
    advance(deps.clock, 30);
    const later = await provider.fetchPredictions('rail:brickell', signal());
    expect(later.ok && later.value.fetchedAt).toBe(NOW + 30);
    expect(server.urls()).toEqual([SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_TRIP_UPDATES_URL]);
  });

  it('predictions: a failed shared fetch is shared too — no second request inside the cadence', async () => {
    const server = new FakeServer({ [SWIFTLY_TRIP_UPDATES_URL]: { status: 403, body: new Uint8Array(0) } });
    const provider = createSwiftlyProvider(providerDeps(server));
    const results = [await provider.fetchPredictions('rail:brickell', signal()), await provider.fetchPredictions('rail:government-ctr', signal())];
    expect(results.map((r) => !r.ok && r.error.kind === 'http' && r.error.status)).toEqual([403, 403]);
    expect(results.map((r) => !r.ok && r.error.reused === true)).toEqual([false, true]); // only the fetch that started it records it
    expect(server.urls()).toHaveLength(1);
  });
});

describe('Swiftly provider (mfix10): the 30 s floor at the source', () => {
  it('vehicles: a fetch less than 30 s after the last download started reads that download, unmetered; at 30 s it downloads afresh', async () => {
    const server = new FakeServer({ [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    const deps = providerDeps(server);
    const provider = createSwiftlyProvider(deps);
    const first = await provider.fetchVehicles(signal());
    advance(deps.clock, 29);
    const reread = await provider.fetchVehicles(signal());
    expect([server.urls(), deps.calls]).toEqual([[SWIFTLY_VEHICLES_URL], ['swiftly']]);
    expect(reread.ok && reread.value).toEqual(first.ok && { ...first.value, floorEndsInMs: 1_000 }); // the same download, handed out with the 1 000 ms left on its floor
    advance(deps.clock, 1);
    await provider.fetchVehicles(signal());
    expect([server.urls(), deps.calls]).toEqual([[SWIFTLY_VEHICLES_URL, SWIFTLY_VEHICLES_URL], ['swiftly', 'swiftly']]);
  });

  it('vehicles: a failure handed out again inside the floor is marked reused; the fetch that started the download gets it as it came', async () => {
    const server = new FakeServer({ [SWIFTLY_VEHICLES_URL]: { status: 503, body: new Uint8Array(0) } });
    const deps = providerDeps(server);
    const provider = createSwiftlyProvider(deps);
    const own = await provider.fetchVehicles(signal());
    advance(deps.clock, 5);
    const reused = await provider.fetchVehicles(signal());
    expect(own).toEqual({ ok: false, error: { kind: 'http', status: 503, message: 'api.goswift.ly answered HTTP 503' } });
    expect(reused).toEqual({ ok: false, error: { kind: 'http', status: 503, message: 'api.goswift.ly answered HTTP 503', reused: true } });
    expect(server.urls()).toHaveLength(1);
  });

});

describe('Swiftly provider (mfix10): the floor per endpoint, per key, on a monotonic clock', () => {
  it('a new agency key is a new endpoint, so it downloads at once; back on the first agency within 30 s, nothing is re-requested', async () => {
    const MDT = 'https://api.goswift.ly/real-time/mdt-test/gtfs-rt-vehicle-positions';
    const server = new FakeServer({ [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES }, [MDT]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    let keys: LiveKeys = FAKE_KEYS;
    const deps: Deps = { ...providerDeps(server), keys: () => keys };
    const provider = createSwiftlyProvider(deps);
    await provider.fetchVehicles(signal());
    keys = { ...FAKE_KEYS, swiftlyAgency: 'mdt-test' };
    advance(deps.clock, 5);
    await provider.fetchVehicles(signal());
    keys = FAKE_KEYS;
    advance(deps.clock, 24);
    await provider.fetchVehicles(signal()); // 29 s after miami's download: inside its floor
    expect(server.urls()).toEqual([SWIFTLY_VEHICLES_URL, MDT]);
    expect(deps.calls).toEqual(['swiftly', 'swiftly']); // each download metered once
    advance(deps.clock, 1);
    await provider.fetchVehicles(signal());
    expect(server.urls()).toEqual([SWIFTLY_VEHICLES_URL, MDT, SWIFTLY_VEHICLES_URL]);
  });

  it('the key is part of a request: a new key downloads at once, key a again within 30 s repeats nothing, and keyChanged forgets only downloads past their floor', async () => {
    const server = new FakeServer({ [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES }, [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES } });
    let keys: LiveKeys = FAKE_KEYS;
    const deps: Deps = { ...providerDeps(server), keys: () => keys };
    const provider = createSwiftlyProvider(deps);
    await fetchBoth(provider); // key a
    keys = { ...FAKE_KEYS, swiftly: 'fake-swiftly-key-b' };
    expect(() => provider.keyChanged(FAKE_KEYS.swiftly)).toThrow('the provider is told of the key in effect now');
    provider.keyChanged(keys.swiftly);
    advance(deps.clock, 1);
    await fetchBoth(provider); // key b: a new request, downloaded at once
    keys = FAKE_KEYS;
    provider.keyChanged(keys.swiftly);
    advance(deps.clock, 28);
    const again = await fetchBoth(provider); // key a again, 29 s after its downloads: inside their floor
    expect(again.map((result) => result.ok && result.value.floorEndsInMs)).toEqual([1_000, 1_000]);
    advance(deps.clock, 1);
    await fetchBoth(provider); // 30 s after key a's downloads: their floor has ended
    const sent = server.requests.map((r) => [r.url.slice(r.url.lastIndexOf('/') + 1), r.headers.Authorization]);
    const [a, b] = ['fake-swiftly-key', 'fake-swiftly-key-b'];
    expect(sent).toEqual([['gtfs-rt-vehicle-positions', a], ['gtfs-rt-trip-updates', a], ['gtfs-rt-vehicle-positions', b], ['gtfs-rt-trip-updates', b], ['gtfs-rt-vehicle-positions', a], ['gtfs-rt-trip-updates', a]]);
  });

  it('the floor\'s clock never runs backwards: a monotonic source that steps back is absorbed, so the floor neither stretches nor shortens', async () => {
    const server = new FakeServer({ [SWIFTLY_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
    const deps = providerDeps(server);
    const provider = createSwiftlyProvider(deps);
    await provider.fetchVehicles(signal());
    deps.clock.ms -= 3_600_000; // a source that steps an hour back (performance.now() never does; a fallback to Date.now() could)
    await provider.fetchVehicles(signal());
    expect(server.urls()).toHaveLength(1);
    deps.clock.ms += 29_999;
    await provider.fetchVehicles(signal());
    expect(server.urls()).toHaveLength(1);
    deps.clock.ms += 1;
    await provider.fetchVehicles(signal());
    expect(server.urls()).toHaveLength(2);
  });
});

describe('none provider (M4.9)', () => {
  it('offers no capability and answers no-key without a request', async () => {
    expect(NONE_PROVIDER.capabilities).toEqual({ vehicles: false, predictions: false });
    const results = [await NONE_PROVIDER.fetchVehicles(signal()), await NONE_PROVIDER.fetchPredictions('rail:brickell', signal())];
    expect(results.map((r) => !r.ok && r.error.kind)).toEqual(['no-key', 'no-key']);
  });
});
