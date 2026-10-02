import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * Plan M10a.1 — the Transitous route-options client, pure. Transitous (MOTIS 2) plans door-to-door
 * trips over every Miami-Dade mode; the app asks it for options and the live overlay (overlay.ts)
 * corrects the rail and Mover departures with m4a's predictions.
 *
 * USAGE TERMS (transitous#2538, approved 2026-10-01): open source, non-commercial, FEW requests, and an
 * identifying User-Agent. Transitous takes no key. The polite client (polite-client.ts) is the only
 * caller that performs these requests; it caches, debounces and keeps one request in flight.
 *
 * REQUEST: GET https://api.transitous.org/api/v5/plan?fromPlace=<lat>,<lon>&toPlace=<lat>,<lon>
 *   &time=<ISO instant>&arriveBy=<true|false>, written out literally — plain JS number formatting, a
 *   literal ',' and ':' — because URLSearchParams would percent-encode them.
 *
 * RESPONSE: parseItineraries turns the /plan body into Itinerary values, keeping EVERY itinerary and
 * EVERY leg in order (walk, bus, rail, Mover…). Times become epoch seconds. Transitous gives a distance
 * only on walk legs, so a transit leg's distanceM is null. Any malformed body is an Err, never a throw.
 */

export const TRANSITOUS_PLAN_URL = 'https://api.transitous.org/api/v5/plan';
/** Where the User-Agent points Transitous's maintainers: this public repository. */
export const APP_REPO_URL = 'https://github.com/purpleperkel/miami-transit';

export type PlanQuery = {
  readonly from: LatLon;
  readonly to: LatLon;
  /** Depart at (or, with arriveBy, arrive by) this instant, epoch s. */
  readonly timeEpoch: number;
  readonly arriveBy: boolean;
};

export type PlanRequest = {
  readonly url: string;
  /** A plain name → value object (the polite client hands it to fetch as is). */
  readonly headers: Readonly<Record<string, string>>;
};

/** One end of a leg: a stop (with its Transitous-prefixed stop id) or a street place (stopId null). */
export type LegPlace = {
  readonly name: string;
  /** Transitous's id, `<feed>_<GTFS stop_id>` (e.g. `us-fl-miami-dade_9512`), or null off a stop. */
  readonly stopId: string | null;
  /** The leg's start (from) or end (to), epoch s. The live overlay may move a boarding epoch. */
  readonly epoch: number;
  readonly latitude: number;
  readonly longitude: number;
};

export type Leg = {
  /** The raw MOTIS mode: WALK, BUS, TRAM (Metromover), REGIONAL_RAIL (Metrorail), … */
  readonly mode: string;
  readonly routeShortName: string | null;
  readonly headsign: string | null;
  readonly from: LegPlace;
  readonly to: LegPlace;
  /** Transitous's id, `<yyyymmdd>_<hh:mm>_<feed>_<GTFS trip_id>`, or null for a leg without a trip. */
  readonly tripId: string | null;
  /** Transitous's own realtime flag (Miami is schedule-only there, so false). */
  readonly realTime: boolean;
  /** True once overlay.ts gave the boarding departure a live prediction; false as parsed. */
  readonly live: boolean;
  /** Metres, when Transitous gives one (walk legs); null on transit legs. */
  readonly distanceM: number | null;
  readonly durationS: number;
};

/**
 * A connection a late leg may break (overlay.ts): the rider reaches leg `legIndex`'s boarding stop after it
 * leaves, so they may miss `line` (its route's short name, else its mode) — a bus does not wait for a late train.
 */
export type ConnectionRisk = { readonly legIndex: number; readonly line: string };

export type Itinerary = {
  readonly startEpoch: number;
  readonly endEpoch: number;
  readonly durationS: number;
  readonly transfers: number;
  readonly legs: readonly Leg[];
  /** Set by the live overlay when a delay overruns a transfer's slack; absent as parsed (and when the transfers hold). */
  readonly connectionAtRisk?: ConnectionRisk;
};

export type PlanParseError = { readonly kind: 'malformed'; readonly message: string };

type RawRecord = Readonly<Record<string, unknown>>;

/** An ISO 8601 instant with an explicit offset, as MOTIS writes them (Date.parse alone is lenient). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The /plan request for one query, identified by the app's version (never hardcoded here). */
export function buildPlanRequest(query: PlanQuery, appVersion: string): PlanRequest {
  invariant(isLatLon(query.from) && isLatLon(query.to), 'a plan query runs between two valid coordinates');
  invariant(Number.isFinite(query.timeEpoch) && typeof query.arriveBy === 'boolean', 'a plan query has an instant and a direction');
  invariant(/^\S+$/.test(appVersion), `the app version is one token, got "${appVersion}"`);
  const from = `${query.from.latitude},${query.from.longitude}`;
  const to = `${query.to.latitude},${query.to.longitude}`;
  const time = new Date(query.timeEpoch * 1000).toISOString();
  const url = `${TRANSITOUS_PLAN_URL}?fromPlace=${from}&toPlace=${to}&time=${time}&arriveBy=${query.arriveBy}`;
  const headers: Record<string, string> = { 'User-Agent': `MiamiTransit/${appVersion} (+${APP_REPO_URL})` };
  invariant(url.startsWith(`${TRANSITOUS_PLAN_URL}?fromPlace=`) && !url.includes('%'), 'the URL is written out literally, never percent-encoded');
  return { url, headers };
}

/** Every itinerary of a /plan body, in order, or an Err naming the first malformed part. */
export function parseItineraries(json: unknown): Result<Itinerary[], PlanParseError> {
  const body = asRecord(json);
  if (body === null || !Array.isArray(body.itineraries)) {
    return malformed('the body is not a /plan response with an itineraries array');
  }
  const raws: readonly unknown[] = body.itineraries;
  const itineraries: Itinerary[] = [];
  for (let i = 0; i < raws.length; i += 1) {
    const parsed = parseItinerary(raws[i], `itinerary ${i}`);
    if (!parsed.ok) {
      return malformed(parsed.error);
    }
    itineraries.push(parsed.value);
  }
  invariant(itineraries.length === raws.length, 'every itinerary is kept');
  invariant(itineraries.every((it, i) => it.legs.length === (asRecord(raws[i])?.legs as unknown[]).length), 'every leg is kept');
  return ok(itineraries);
}

function parseItinerary(raw: unknown, where: string): Result<Itinerary, string> {
  invariant(where.length > 0, 'a parse error names where it happened');
  const it = asRecord(raw);
  if (it === null || !Array.isArray(it.legs) || it.legs.length === 0) {
    return err(`${where}: not an itinerary with a non-empty legs array`);
  }
  const startEpoch = epochOf(it.startTime);
  const endEpoch = epochOf(it.endTime);
  const { duration, transfers } = it;
  if (startEpoch === null || endEpoch === null || !isNonNegative(duration) || !isCount(transfers)) {
    return err(`${where}: startTime, endTime, duration or transfers is missing or malformed`);
  }
  const rawLegs: readonly unknown[] = it.legs;
  const legs: Leg[] = [];
  for (let j = 0; j < rawLegs.length; j += 1) {
    const leg = parseLeg(rawLegs[j], `${where} leg ${j}`);
    if (!leg.ok) {
      return leg;
    }
    legs.push(leg.value);
  }
  invariant(legs.length === rawLegs.length, 'every leg of the itinerary is kept, in order');
  return ok({ startEpoch, endEpoch, durationS: duration, transfers, legs });
}

function parseLeg(raw: unknown, where: string): Result<Leg, string> {
  invariant(where.length > 0, 'a parse error names where it happened');
  const leg = asRecord(raw);
  if (leg === null || typeof leg.mode !== 'string' || leg.mode.length === 0 || typeof leg.realTime !== 'boolean') {
    return err(`${where}: not a leg with a string mode and a boolean realTime`);
  }
  const startEpoch = epochOf(leg.startTime);
  const endEpoch = epochOf(leg.endTime);
  const { duration } = leg;
  if (startEpoch === null || endEpoch === null || !isNonNegative(duration)) {
    return err(`${where} (${leg.mode}): startTime, endTime or duration is missing or malformed`);
  }
  const from = parsePlace(leg.from, startEpoch);
  const to = parsePlace(leg.to, endEpoch);
  const routeShortName = optionalText(leg.routeShortName);
  const headsign = optionalText(leg.headsign);
  const tripId = optionalText(leg.tripId);
  const distance = leg.distance ?? null;
  if (from === null || to === null || routeShortName === undefined || headsign === undefined || tripId === undefined || (distance !== null && !isNonNegative(distance))) {
    return err(`${where} (${leg.mode}): from, to, routeShortName, headsign, tripId or distance is malformed`);
  }
  const parsed: Leg = { mode: leg.mode, routeShortName, headsign, from, to, tripId, realTime: leg.realTime, live: false, distanceM: distance, durationS: duration };
  invariant(parsed.from.epoch === startEpoch && parsed.to.epoch === endEpoch, 'a leg runs from its startTime to its endTime');
  return ok(parsed);
}

/** A leg end as the leg dates it, or null when it is not a named place with coordinates. */
function parsePlace(raw: unknown, epoch: number): LegPlace | null {
  invariant(Number.isFinite(epoch), 'a place is dated by its leg');
  const place = asRecord(raw);
  if (place === null) {
    return null;
  }
  const { name, lat, lon } = place;
  const stopId = optionalText(place.stopId);
  if (typeof name !== 'string' || !isCoordinate(lat, 90) || !isCoordinate(lon, 180) || stopId === undefined) {
    return null;
  }
  const parsed: LegPlace = { name, stopId, epoch, latitude: lat, longitude: lon };
  invariant(isLatLon(parsed), 'a parsed place has valid coordinates');
  return parsed;
}

/** A JSON object (not an array), or null. */
function asRecord(value: unknown): RawRecord | null {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawRecord) : null;
  invariant(record === null || typeof record === 'object', 'a record is an object');
  invariant(record === null || !Array.isArray(record), 'an array is not a record');
  return record;
}

/** Epoch seconds of an ISO instant, or null when the value is not one. */
function epochOf(value: unknown): number | null {
  const ms = typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
  const epoch = Number.isFinite(ms) ? ms / 1000 : null;
  invariant(epoch === null || typeof value === 'string', 'only a string instant has an epoch');
  invariant(epoch === null || Number.isFinite(epoch), 'an epoch is a finite number');
  return epoch;
}

/** A present string, null when absent (undefined or null), undefined when it is something else. */
function optionalText(value: unknown): string | null | undefined {
  const text = value === undefined || value === null ? null : typeof value === 'string' ? value : undefined;
  invariant(text === null || text === undefined || typeof text === 'string', 'text is a string, absent or malformed');
  invariant(text !== undefined || (value !== undefined && value !== null), 'only a present non-string is malformed');
  return text;
}

/** A finite number >= 0 (a duration, a distance). */
function isNonNegative(value: unknown): value is number {
  const yes = typeof value === 'number' && Number.isFinite(value) && value >= 0;
  invariant(!yes || typeof value === 'number', 'only a number can be non-negative');
  invariant(!yes || !Number.isNaN(value), 'NaN is never non-negative');
  return yes;
}

/** A whole number >= 0 (a count of transfers). */
function isCount(value: unknown): value is number {
  const yes = isNonNegative(value) && Number.isInteger(value);
  invariant(!yes || typeof value === 'number', 'only a number is a count');
  invariant(!yes || Number.isSafeInteger(value), 'a count is a whole number');
  return yes;
}

/** A degree within +-limit (90 for a latitude, 180 for a longitude). */
function isCoordinate(value: unknown, limit: number): value is number {
  invariant(limit === 90 || limit === 180, 'a coordinate is a latitude or a longitude');
  const yes = typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
  invariant(!yes || typeof value === 'number', 'only a number is a coordinate');
  return yes;
}

function malformed(message: string): Result<Itinerary[], PlanParseError> {
  invariant(message.length > 0, 'a malformed body says what is wrong');
  const result = err<PlanParseError>({ kind: 'malformed', message });
  invariant(!result.ok, 'a malformed body is an Err');
  return result;
}
