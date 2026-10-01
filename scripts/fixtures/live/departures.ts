import type { ScheduleRepo } from '../../../src/data/schedule-repo';
import type { SqlExecutor } from '../../../src/data/sql-executor';
import { windowFrom } from '../../../src/domain/gtfs/service-day';
import type { LineId } from '../../../src/domain/lines/line-catalog';
import type { Departure } from '../../../src/domain/schedule/departures';
import { invariant } from '../../../src/lib/invariant';
import { clockOf, dashedDate, isoAt } from './clock';
import type { SeededRandom } from './prng';
import { type FixtureDay, routeLineNames, stopCall, stopFacts, type TripFacts, tripFacts } from './schedule-facts';

/**
 * The synthetic Transitland departures responses (plan M8.3) for Government Center rail — stop 9512
 * (southbound) and 9513 (northbound) — in the key structure of the live response
 * (`GET /stops/<feed>:<stop_id>/departures?next=3600`): `{ stops: [{ <stop fields>, departures: [row…] }] }`.
 *
 * Every row is a REAL schedule.db trip that serves that platform inside the hour after the fixture
 * instant, with its scheduled times; the realtime part is synthetic: rows due within REALTIME_HORIZON_S
 * are SCHEDULED with a seeded delay (estimated_* set), later rows are STATIC (no estimate). Transitland's
 * own numeric ids, onestop ids, the feed version and display colours are synthetic placeholders.
 */

export type DeparturesContext = {
  readonly db: SqlExecutor;
  readonly repo: ScheduleRepo;
  readonly rng: SeededRandom;
  readonly day: FixtureDay;
  readonly feedEpoch: number;
};

/** The departures window Transitland is asked for (`?next=3600`). */
const WINDOW_S = 3_600;
/** Rows due within this long carry a realtime estimate; later ones are STATIC, as the live feed's horizon ends. */
const REALTIME_HORIZON_S = 40 * 60;
const STATION_KEY = 'rail:government-ctr';
export const GOVERNMENT_CENTER_RAIL_STOPS = ['9512', '9513'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type DeparturesBuild = {
  /** stop_id → the departures response for it. */
  readonly responses: Readonly<Record<string, JsonObject>>;
  /** trip_id → line of every row's trip (schedule.db), sorted by trip_id. */
  readonly tripLines: readonly (readonly [string, LineId])[];
};

export function buildDepartures(ctx: DeparturesContext): DeparturesBuild {
  const outcome = ctx.repo.departures(STATION_KEY, windowFrom(ctx.feedEpoch, WINDOW_S));
  invariant(outcome.ok && outcome.value.kind === 'departures', `schedule.db has departures at ${STATION_KEY} in the fixture hour`);
  const ids = new SyntheticIds(ctx.rng);
  const responses: Record<string, JsonObject> = {};
  const tripLines = new Map<string, LineId>();
  for (const stopId of GOVERNMENT_CENTER_RAIL_STOPS) {
    const rows = outcome.value.departures.filter((d) => d.stopId === stopId);
    invariant(rows.length > 0 && rows[0] !== undefined && rows[0].epoch - ctx.feedEpoch < REALTIME_HORIZON_S, `stop ${stopId} has a departure inside the realtime horizon`);
    const built = rows.map((d) => departureRow(ctx, ids, d));
    built.forEach((row) => tripLines.set(row.facts.tripId, row.facts.lineId));
    responses[stopId] = { stops: [stopObject(ctx, ids, stopId, built.map((row) => row.json))] };
  }
  return { responses, tripLines: [...tripLines].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/** Transitland's internal numeric ids, one per (kind, key), drawn on first use. */
class SyntheticIds {
  private readonly seen = new Map<string, number>();
  private readonly rng: SeededRandom;

  constructor(rng: SeededRandom) {
    invariant(typeof rng.int === 'function', 'ids are drawn from the seeded sequence');
    this.rng = rng;
    invariant(this.seen.size === 0, 'no id is drawn yet');
  }

  of(kind: string, key: string): number {
    invariant(kind.length > 0 && key.length > 0, 'an id is for a named thing');
    const name = `${kind}:${key}`;
    const id = this.seen.get(name) ?? this.rng.int(100_000, 9_999_999);
    this.seen.set(name, id);
    invariant(this.seen.get(name) === id, 'an id, once drawn, is kept');
    return id;
  }
}

/** One departure row at its stop: the scheduled call from schedule.db, a synthetic estimate when inside the horizon. */
function departureRow(ctx: DeparturesContext, ids: SyntheticIds, departure: Departure): { readonly json: JsonObject; readonly facts: TripFacts } {
  invariant(departure.serviceDate === ctx.day.date, 'the fixture hour lies inside one service day');
  const facts = tripFacts(ctx.db, departure.tripId);
  const call = stopCall(ctx.db, departure.tripId, departure.stopId);
  invariant(ctx.day.baseEpoch + call.depS === departure.epoch, 'the departure is the call schedule.db lists');
  const realtime = departure.epoch - ctx.feedEpoch < REALTIME_HORIZON_S;
  const delayS = realtime ? ctx.rng.int(-30, 240) : null;
  const relationship = realtime ? 'SCHEDULED' : 'STATIC';
  const json: JsonObject = {
    arrival: stopEvent(ctx, call.arrS, delayS),
    arrival_time: clockOf(call.arrS),
    continuous_drop_off: null,
    continuous_pickup: null,
    date: dashedDate(ctx.day.date),
    departure: stopEvent(ctx, call.depS, delayS),
    departure_time: clockOf(call.depS),
    drop_off_type: 0,
    interpolated: null,
    pickup_type: 0,
    schedule_relationship: relationship,
    service_date: dashedDate(departure.serviceDate),
    shape_dist_traveled: Math.round(call.distM) / 1_000,
    stop_headsign: null,
    stop_sequence: call.seq + 1,
    timepoint: 1,
    trip: tripObject(ctx, ids, facts, departure, relationship),
  };
  return { json, facts };
}

/** An arrival or departure event: scheduled times always; estimated times and delay only when `delayS` is set. */
function stopEvent(ctx: DeparturesContext, serviceS: number, delayS: number | null): JsonObject {
  invariant(Number.isSafeInteger(serviceS) && serviceS >= 0, 'a call time is a service-day second');
  invariant(delayS === null || Number.isSafeInteger(delayS), 'a delay is whole seconds');
  const scheduled = ctx.day.baseEpoch + serviceS;
  const estimated = delayS === null ? null : scheduled + delayS;
  return {
    delay: null,
    estimated: delayS === null ? null : clockOf(serviceS + delayS),
    estimated_delay: delayS,
    estimated_local: estimated === null ? null : isoAt(estimated, ctx.day.offsetS),
    estimated_utc: estimated === null ? null : isoAt(estimated, 0),
    scheduled: clockOf(serviceS),
    scheduled_local: isoAt(scheduled, ctx.day.offsetS),
    scheduled_utc: isoAt(scheduled, 0),
    uncertainty: delayS === null ? null : ctx.rng.pick([null, 30, 60]),
  };
}

function tripObject(ctx: DeparturesContext, ids: SyntheticIds, facts: TripFacts, departure: Departure, relationship: string): JsonObject {
  invariant(facts.tripId === departure.tripId, 'the trip is the departure\'s');
  invariant(relationship === 'SCHEDULED' || relationship === 'STATIC', 'a synthetic row is realtime or static');
  return {
    bikes_allowed: 1,
    block_id: facts.blockId,
    cars_allowed: null,
    direction_id: facts.directionId,
    frequencies: [],
    id: ids.of('trip', facts.tripId),
    route: routeObject(ctx, ids, facts.routeId),
    schedule_relationship: relationship,
    shape: { generated: false, id: ids.of('shape', facts.shapeId), shape_id: facts.shapeId },
    stop_pattern_id: facts.patternIdx,
    timestamp: relationship === 'STATIC' ? null : isoAt(ctx.feedEpoch - ctx.rng.int(5, 50), 0),
    trip_headsign: departure.destName,
    trip_id: facts.tripId,
    trip_short_name: null,
    wheelchair_accessible: 1,
  };
}

function routeObject(ctx: DeparturesContext, ids: SyntheticIds, routeId: string): JsonObject {
  invariant(routeId.length > 0, 'a route id is named');
  const route: JsonObject = {
    agency: { agency_id: 'syn-agency', agency_name: 'Synthetic agency (public GTFS)', id: ids.of('agency', 'syn'), onestop_id: 'o-syn-agency' },
    cemv_support: null,
    continuous_drop_off: null,
    continuous_pickup: null,
    id: ids.of('route', routeId),
    onestop_id: `r-syn-${routeId}`,
    route_color: 'syn000',
    route_desc: null,
    route_id: routeId,
    route_long_name: routeLineNames(ctx.db, routeId),
    route_short_name: routeId,
    route_text_color: null,
    route_type: 1,
    route_type_basic: 1,
    route_url: null,
  };
  invariant(route.route_id === routeId, 'the route object is the trip\'s route');
  return route;
}

/** The platform as Transitland describes it, its coordinates and code from schedule.db, holding its departure rows. */
function stopObject(ctx: DeparturesContext, ids: SyntheticIds, stopId: string, departures: JsonObject[]): JsonObject {
  invariant(departures.length > 0, `stop ${stopId} has departure rows`);
  const stop = stopFacts(ctx.db, stopId);
  const bound = stop.bound === 'N' ? 'Northbound' : stop.bound === 'S' ? 'Southbound' : 'Platform';
  invariant(stop.stopId === stopId, 'the stop is the one asked for');
  return {
    children: null,
    departures,
    feed_version: {
      feed: { id: ids.of('feed', 'syn'), onestop_id: 'f-syn-public-gtfs' },
      fetched_at: `${isoAt(ctx.feedEpoch - 86_400, 0).slice(0, -1)}.${String(ctx.rng.int(0, 999_999)).padStart(6, '0')}Z`,
      id: ids.of('feed_version', 'syn'),
      sha1: Array.from({ length: 40 }, () => '0123456789abcdef'.charAt(ctx.rng.int(0, 15))).join(''),
    },
    geometry: { coordinates: [stop.longitude, stop.latitude], type: 'Point' },
    id: ids.of('stop', stopId),
    location_type: 0,
    onestop_id: `s-syn-${stopId}`,
    parent: null,
    platform_code: null,
    stop_access: null,
    stop_code: stop.code,
    stop_desc: null,
    stop_id: stopId,
    stop_name: `${stop.stationName} ${bound}`,
    stop_timezone: null,
    stop_url: null,
    tts_stop_name: null,
    wheelchair_boarding: 1,
    zone_id: null,
  };
}
