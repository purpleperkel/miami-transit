import {
  resolveServiceDays,
  type ServiceCalendarBounds,
  type ServiceDayResolution,
  type TimeWindow,
} from '../domain/gtfs/service-day';
import { assembleDepartures, type Departure } from '../domain/schedule/departures';
import { assembleRides, judgeRides, type RidesOutcome } from '../domain/schedule/rides';
import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import {
  daySeconds,
  findStation,
  readCalendarBounds,
  readMeta,
  readRideCandidates,
  readServiceDays,
  readStopVisits,
  type StationRef,
} from './schedule-queries';
import type { SqlExecutor } from './sql-executor';

/**
 * The schedule engine's public face (plan M3.2–M3.4): service days, departures and rides, read
 * from the bundled schedule DB through the SqlExecutor contract.
 *
 *   executor (expo-sqlite | node:sqlite) → schedule-queries (SQL) → domain (pure assembly)
 *
 * It imports only the contract and pure modules, through relative paths, so the node:test suites
 * run this exact code against the real assets/db/schedule.db.
 *
 * Every time is an absolute epoch second; the DB's `service_day.base_epoch` (computed on the Mac
 * in America/New_York) is the only bridge to the feed's service-day seconds, so the phone does no
 * time-zone math.
 */

/** The schema this engine reads (plan §4 DDL; meta.schema_version and PRAGMA user_version). */
export const SCHEDULE_SCHEMA_VERSION = 1;
/** The feed's agency time zone, which every base_epoch in the DB was computed in. */
export const SCHEDULE_TIME_ZONE = 'America/New_York';

export type ScheduleMeta = {
  readonly feedSha256: string;
  readonly schemaVersion: number;
  readonly builderVersion: number;
  readonly timeZone: string;
};

/** The DB is not one this engine can read (wrong schema, wrong time zone, missing meta). */
export type ScheduleDbError = { readonly kind: 'schedule-db'; readonly message: string };
/** A query named a station the DB does not have (e.g. a saved trip from an older feed). */
export type UnknownStation = { readonly kind: 'unknown-station'; readonly stationKey: string };

/** The calendar does not cover the window: the schedule has expired, or has not started. */
export type CalendarGap = Exclude<ServiceDayResolution, { readonly kind: 'active' }>;

export type DeparturesOutcome =
  | { readonly kind: 'departures'; readonly serviceDates: readonly number[]; readonly departures: readonly Departure[] }
  | CalendarGap;

export type RidesQueryOutcome = RidesOutcome | CalendarGap;

export class ScheduleRepo {
  readonly meta: ScheduleMeta;
  private readonly db: SqlExecutor;
  private readonly bounds: ServiceCalendarBounds;

  private constructor(db: SqlExecutor, meta: ScheduleMeta, bounds: ServiceCalendarBounds) {
    invariant(meta.schemaVersion === SCHEDULE_SCHEMA_VERSION, 'the repo reads only the schema it was written for');
    invariant(bounds.spanS > 0, 'the calendar has trips');
    this.db = db;
    this.meta = meta;
    this.bounds = bounds;
  }

  /** Check the DB's meta (schema version, time zone, feed hash) and read the calendar's bounds. */
  static open(db: SqlExecutor): Result<ScheduleRepo, ScheduleDbError> {
    invariant(typeof db.all === 'function' && typeof db.get === 'function', 'open needs a SqlExecutor');
    const meta = parseMeta(readMeta(db));
    if (!meta.ok) {
      return meta;
    }
    const repo = new ScheduleRepo(db, meta.value, readCalendarBounds(db));
    invariant(repo.meta.timeZone === SCHEDULE_TIME_ZONE, 'the repo serves New York service days');
    return ok(repo);
  }

  /** The service days with trains possibly running during `window` (two just after midnight), or why none. */
  serviceDays(window: TimeWindow): ServiceDayResolution {
    invariant(window.fromEpoch <= window.toEpoch, 'serviceDays needs an ordered window');
    const resolution = resolveServiceDays(window, readServiceDays(this.db, window, this.bounds.spanS), this.bounds);
    invariant(resolution.kind !== 'active' || resolution.days.length > 0, 'an active resolution names its days');
    return resolution;
  }

  /** Scheduled departures from the station during `window`, earliest first; terminating trains excluded. */
  departures(stationKey: string, window: TimeWindow): Result<DeparturesOutcome, UnknownStation> {
    invariant(stationKey.length > 0, 'departures needs a station key');
    const station = findStation(this.db, stationKey);
    if (station === null) {
      return err({ kind: 'unknown-station', stationKey });
    }
    const resolution = this.serviceDays(window);
    if (resolution.kind !== 'active') {
      return ok(resolution);
    }
    const visits = resolution.days.map((day) => ({ day, visits: readStopVisits(this.db, station, day, daySeconds(day, window)) }));
    const departures = assembleDepartures(window, visits);
    invariant(departures.every((d) => d.epoch >= window.fromEpoch && d.epoch <= window.toEpoch), 'every departure is inside the window');
    return ok({ kind: 'departures', serviceDates: resolution.days.map((day) => day.date), departures });
  }

  /** Rides from one station to another boarding during `window` (same vehicle, at most one block hop). */
  rides(fromKey: string, toKey: string, window: TimeWindow): Result<RidesQueryOutcome, UnknownStation> {
    invariant(fromKey.length > 0 && toKey.length > 0, 'rides needs two station keys');
    invariant(fromKey !== toKey, `a ride joins two different stations, got ${fromKey} twice`);
    const stations = this.stationPair(fromKey, toKey);
    if (!stations.ok) {
      return stations;
    }
    const resolution = this.serviceDays(window);
    if (resolution.kind !== 'active') {
      return ok(resolution);
    }
    const candidates = resolution.days.map((day) => ({
      day,
      candidates: readRideCandidates(this.db, stations.value, day, daySeconds(day, window)),
    }));
    return ok(judgeRides(assembleRides(window, candidates)));
  }

  private stationPair(fromKey: string, toKey: string): Result<{ from: StationRef; to: StationRef }, UnknownStation> {
    const from = findStation(this.db, fromKey);
    const to = findStation(this.db, toKey);
    invariant(from === null || from.stationKey === fromKey, 'the origin found is the one asked for');
    invariant(to === null || to.stationKey === toKey, 'the destination found is the one asked for');
    if (from === null) {
      return err({ kind: 'unknown-station', stationKey: fromKey });
    }
    return to === null ? err({ kind: 'unknown-station', stationKey: toKey }) : ok({ from, to });
  }
}

/** The meta rows as a ScheduleMeta, or why this engine cannot read the DB. */
function parseMeta(meta: ReadonlyMap<string, string>): Result<ScheduleMeta, ScheduleDbError> {
  invariant(meta.size > 0, 'parseMeta needs the meta rows');
  const feedSha256 = meta.get('feed_sha256') ?? '';
  const parsed = {
    feedSha256,
    schemaVersion: Number(meta.get('schema_version')),
    builderVersion: Number(meta.get('builder_version')),
    timeZone: meta.get('time_zone') ?? '',
  };
  if (parsed.schemaVersion !== SCHEDULE_SCHEMA_VERSION) {
    return err({ kind: 'schedule-db', message: `schema_version is ${meta.get('schema_version')}; this engine reads ${SCHEDULE_SCHEMA_VERSION}` });
  }
  if (parsed.timeZone !== SCHEDULE_TIME_ZONE) {
    return err({ kind: 'schedule-db', message: `time_zone is "${parsed.timeZone}"; base epochs must be ${SCHEDULE_TIME_ZONE}` });
  }
  if (!/^[0-9a-f]{64}$/.test(feedSha256) || !Number.isInteger(parsed.builderVersion)) {
    return err({ kind: 'schedule-db', message: 'meta lacks a feed_sha256 (64 hex) or an integer builder_version' });
  }
  invariant(parsed.schemaVersion === SCHEDULE_SCHEMA_VERSION && parsed.timeZone === SCHEDULE_TIME_ZONE, 'a parsed meta is one this engine reads');
  return ok(parsed);
}
