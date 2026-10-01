import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { DEPARTURES_WINDOW_S, REQUEST_ABORT_MS } from './constants';
import type { LiveError, ProviderId } from './types';

/**
 * Plan M4.3: pure request builders for the endpoints §3 live-verified on 2026-10-01. The runtime
 * (src/live/http.ts, M4.8) performs them. Keys travel ONLY in headers, never in a URL, so a key
 * cannot leak into a log line, a crash report or a cached URL:
 *   - Swiftly: `Authorization: <key>` — exactly the key, no "Bearer" — on
 *     https://api.goswift.ly/real-time/<agencyKey>/gtfs-rt-{vehicle-positions,trip-updates};
 *     agencyKey is a Settings value that defaults to `miami`.
 *   - Transitland: `apikey: <key>` on the county realtime feed's vehicle-positions download, and on
 *     per-station departures (stop key f-dhw-miamidadetransit:<stop_id>, the next 3600 s).
 * Transitland's whole-agency trip-updates download is 1 MB per poll (§3, falsifier R19 fired), so no
 * builder here can produce it: Transitland predictions come from per-station departures only.
 */

export type LiveRequest = {
  readonly provider: ProviderId;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** What the response body is: GTFS-realtime protobuf bytes, or JSON. */
  readonly body: 'protobuf' | 'json';
  /** Abort the request after this long (§4: 8 s). */
  readonly timeoutMs: number;
};

export const SWIFTLY_BASE_URL = 'https://api.goswift.ly/real-time';
export const DEFAULT_SWIFTLY_AGENCY_KEY = 'miami';
export const TRANSITLAND_REST_URL = 'https://transit.land/api/v2/rest';
/** The county's realtime feed on Transitland. */
export const TRANSITLAND_RT_FEED = 'f-miamidadetransit~rt';
/** The county's static feed on Transitland, which keys its stops: `<feed>:<stop_id>`. */
export const TRANSITLAND_STOP_FEED = 'f-dhw-miamidadetransit';

/** Swiftly's GTFS-realtime vehicle positions (protobuf). */
export function swiftlyVehiclesRequest(key: string | null, agencyKey: string | null = null): Result<LiveRequest, LiveError> {
  invariant(agencyKey === null || typeof agencyKey === 'string', 'an agency key is a string or unset');
  const request = swiftlyRequest(key, agencyKey, 'gtfs-rt-vehicle-positions');
  invariant(!request.ok || request.value.url.endsWith('/gtfs-rt-vehicle-positions'), 'the vehicles request asks for vehicle positions');
  return request;
}

/** Swiftly's GTFS-realtime trip updates (protobuf) — Swiftly's predictions path. */
export function swiftlyTripUpdatesRequest(key: string | null, agencyKey: string | null = null): Result<LiveRequest, LiveError> {
  invariant(agencyKey === null || typeof agencyKey === 'string', 'an agency key is a string or unset');
  const request = swiftlyRequest(key, agencyKey, 'gtfs-rt-trip-updates');
  invariant(!request.ok || request.value.url.endsWith('/gtfs-rt-trip-updates'), 'the predictions request asks for trip updates');
  return request;
}

/** Transitland's copy of the county's vehicle positions (protobuf, about 56 KB a poll). */
export function transitlandVehiclesRequest(key: string | null): Result<LiveRequest, LiveError> {
  const apiKey = usableKey(key, 'transitland');
  if (!apiKey.ok) {
    return apiKey;
  }
  const url = `${TRANSITLAND_REST_URL}/feeds/${TRANSITLAND_RT_FEED}/download_latest_rt/vehicle_positions.pb`;
  const request: LiveRequest = { provider: 'transitland', url, headers: { apikey: apiKey.value }, body: 'protobuf', timeoutMs: REQUEST_ABORT_MS };
  invariant(request.url.startsWith(`${TRANSITLAND_REST_URL}/feeds/`), 'the vehicles request is a feed download built from constants alone');
  invariant(request.url.endsWith('/vehicle_positions.pb'), 'Transitland is only ever asked for vehicle positions as a feed download');
  return ok(request);
}

/** Transitland's departures from one stop for the next hour (JSON, about 18 KB) — its predictions path. */
export function transitlandDeparturesRequest(key: string | null, stopId: string): Result<LiveRequest, LiveError> {
  invariant(/^[A-Za-z0-9_.-]+$/.test(stopId), `stop_id "${stopId}" is a schedule stop id (URL-safe)`);
  const apiKey = usableKey(key, 'transitland');
  if (!apiKey.ok) {
    return apiKey;
  }
  const url = `${TRANSITLAND_REST_URL}/stops/${TRANSITLAND_STOP_FEED}:${stopId}/departures?next=${DEPARTURES_WINDOW_S}`;
  const request: LiveRequest = { provider: 'transitland', url, headers: { apikey: apiKey.value }, body: 'json', timeoutMs: REQUEST_ABORT_MS };
  invariant(request.url.endsWith(`:${stopId}/departures?next=${DEPARTURES_WINDOW_S}`), 'the URL holds the stop id and the window, nothing else');
  return ok(request);
}

function swiftlyRequest(key: string | null, agencyKey: string | null, feed: string): Result<LiveRequest, LiveError> {
  invariant(feed.startsWith('gtfs-rt-'), 'Swiftly is asked for a GTFS-realtime feed');
  const apiKey = usableKey(key, 'swiftly');
  if (!apiKey.ok) {
    return apiKey;
  }
  const agency = agencyKey === null || agencyKey.trim() === '' ? DEFAULT_SWIFTLY_AGENCY_KEY : agencyKey.trim();
  const url = `${SWIFTLY_BASE_URL}/${encodeURIComponent(agency)}/${feed}`;
  const request: LiveRequest = { provider: 'swiftly', url, headers: { Authorization: apiKey.value }, body: 'protobuf', timeoutMs: REQUEST_ABORT_MS };
  invariant(request.url === `${SWIFTLY_BASE_URL}/${encodeURIComponent(agency)}/${feed}`, 'the URL holds the agency and the feed, nothing else');
  return ok(request);
}

/**
 * The key as pasted, surrounding whitespace trimmed; a no-key error when there is none, or when it
 * holds inner whitespace (a header value cannot carry a line break, and no real key has a space).
 */
function usableKey(key: string | null, provider: ProviderId): Result<string, LiveError> {
  invariant(key === null || typeof key === 'string', 'a key is a string or absent');
  const trimmed = key?.trim() ?? '';
  if (trimmed === '') {
    return err({ kind: 'no-key', message: `no ${provider} key is set — paste it in Data & Settings` });
  }
  if (/\s/.test(trimmed)) {
    return err({ kind: 'no-key', message: `the ${provider} key contains whitespace — paste it again in Data & Settings` });
  }
  invariant(trimmed.length > 0 && !/\s/.test(trimmed), 'a usable key is non-empty and has no whitespace');
  return ok(trimmed);
}
