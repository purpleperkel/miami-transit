import { isOk } from '../../../lib/result';
import {
  type LiveRequest,
  swiftlyTripUpdatesRequest,
  swiftlyVehiclesRequest,
  transitlandDeparturesRequest,
  transitlandVehiclesRequest,
} from '../transports';

/**
 * M4.3: the pure request builders, pinned to the endpoints §3 live-verified on 2026-10-01. Every
 * key below is an obviously fake value; a real key never appears in a test.
 */

const FAKE_KEY = 'fake-test-key-0000-not-a-real-key';

/** The request, failing the test when the builder returned an error. */
function request(result: ReturnType<typeof transitlandVehiclesRequest>): LiveRequest {
  expect(result.ok).toBe(true);
  expect(isOk(result)).toBe(true);
  if (!result.ok) {
    throw new Error(`builder failed: ${result.error.message}`);
  }
  return result.value;
}

/** Every request the app can build, for both providers, with the fake key. */
function everyRequest(): LiveRequest[] {
  const all = [
    request(swiftlyVehiclesRequest(FAKE_KEY)),
    request(swiftlyTripUpdatesRequest(FAKE_KEY)),
    request(swiftlyVehiclesRequest(FAKE_KEY, 'other-agency')),
    request(transitlandVehiclesRequest(FAKE_KEY)),
    ...['9512', '9513', '813'].map((stopId) => request(transitlandDeparturesRequest(FAKE_KEY, stopId))),
  ];
  expect(all).toHaveLength(7);
  expect(all.every((r) => r.timeoutMs === 8_000)).toBe(true);
  return all;
}

describe('transports (M4.3): Swiftly', () => {
  it('swiftly authorization header: exactly the key, no "Bearer", on the live-verified GTFS-rt URLs', () => {
    expect(request(swiftlyVehiclesRequest(FAKE_KEY))).toEqual({
      provider: 'swiftly',
      url: 'https://api.goswift.ly/real-time/miami/gtfs-rt-vehicle-positions',
      headers: { Authorization: FAKE_KEY },
      body: 'protobuf',
      timeoutMs: 8_000,
    });
    const tripUpdates = request(swiftlyTripUpdatesRequest(FAKE_KEY));
    expect(tripUpdates.url).toBe('https://api.goswift.ly/real-time/miami/gtfs-rt-trip-updates');
    expect(tripUpdates.headers).toEqual({ Authorization: FAKE_KEY });
    expect(JSON.stringify(everyRequest())).not.toMatch(/bearer/i);
  });

  it('agencyKey defaults to miami when unset or blank; a Settings value replaces it', () => {
    expect(request(swiftlyVehiclesRequest(FAKE_KEY)).url).toBe('https://api.goswift.ly/real-time/miami/gtfs-rt-vehicle-positions');
    expect(request(swiftlyVehiclesRequest(FAKE_KEY, null)).url).toContain('/real-time/miami/');
    expect(request(swiftlyTripUpdatesRequest(FAKE_KEY, '   ')).url).toContain('/real-time/miami/');
    expect(request(swiftlyVehiclesRequest(FAKE_KEY, 'other-agency')).url).toBe('https://api.goswift.ly/real-time/other-agency/gtfs-rt-vehicle-positions');
  });
});

describe('transports (M4.3): Transitland', () => {
  it('transitland apikey header on the vehicle_positions.pb download', () => {
    expect(request(transitlandVehiclesRequest(FAKE_KEY))).toEqual({
      provider: 'transitland',
      url: 'https://transit.land/api/v2/rest/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb',
      headers: { apikey: FAKE_KEY },
      body: 'protobuf',
      timeoutMs: 8_000,
    });
    expect(request(transitlandDeparturesRequest(FAKE_KEY, '9513')).headers).toEqual({ apikey: FAKE_KEY });
  });

  it('transitland departures url: per station, the stop keyed f-dhw-miamidadetransit:<stop_id>, next 3600 s, JSON', () => {
    const governmentCenterNorthbound = request(transitlandDeparturesRequest(FAKE_KEY, '9513'));
    expect(governmentCenterNorthbound.url).toBe('https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:9513/departures?next=3600');
    expect(governmentCenterNorthbound.body).toBe('json');
    expect(request(transitlandDeparturesRequest(FAKE_KEY, '813')).url).toBe(
      'https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:813/departures?next=3600',
    );
  });

  it('never fetches trip_updates: no Transitland request is the 1 MB whole-agency trip-updates download', () => {
    const transitland = everyRequest().filter((r) => r.provider === 'transitland');
    expect(transitland.map((r) => r.url.replace(/:\d+\//, ':<stop>/'))).toEqual([
      'https://transit.land/api/v2/rest/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb',
      'https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:<stop>/departures?next=3600',
      'https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:<stop>/departures?next=3600',
      'https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:<stop>/departures?next=3600',
    ]);
    expect(transitland.some((r) => r.url.includes('trip_updates') || r.url.includes('trip-updates'))).toBe(false);
  });
});

describe('transports (M4.3): keys', () => {
  it('key never in url: the fake key appears only in a header, in every request', () => {
    for (const built of everyRequest()) {
      expect(built.url).not.toContain(FAKE_KEY);
      expect(Object.values(built.headers)).toEqual([FAKE_KEY]);
    }
    expect(everyRequest().map((r) => new URL(r.url).search).filter((query) => /key/i.test(query))).toEqual([]);
  });

  it('key never in url: a missing or blank key is a no-key error, never a request', () => {
    for (const key of [null, '', '   ']) {
      expect(swiftlyVehiclesRequest(key)).toEqual({ ok: false, error: { kind: 'no-key', message: 'no swiftly key is set — paste it in Data & Settings' } });
      expect(transitlandDeparturesRequest(key, '9513')).toEqual({ ok: false, error: { kind: 'no-key', message: 'no transitland key is set — paste it in Data & Settings' } });
    }
    expect(transitlandVehiclesRequest(`  ${FAKE_KEY}\n`)).toEqual(transitlandVehiclesRequest(FAKE_KEY));
    expect(transitlandVehiclesRequest('fake key with spaces')).toMatchObject({ ok: false, error: { kind: 'no-key' } });
  });
});
