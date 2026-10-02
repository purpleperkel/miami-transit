import {
  resolveServiceDays,
  type ServiceCalendarBounds,
  type ServiceDay,
  type ServiceDayResolution,
  type TimeWindow,
  windowFrom,
} from '../domain/gtfs/service-day';
import { assembleDepartures, type Departure, firstPerDirection, type ServiceDayVisits } from '../domain/schedule/departures';
import type { Platform } from '../domain/hurry/platform';
import { LINE_IDS, type LineId } from '../domain/lines/line-catalog';
import { type ModeCalendar, type ModeStatuses, modeStatuses, STARTING_SOON_S } from '../domain/schedule/mode-status';
import { type NextStop, nextStops } from '../domain/schedule/next-stops';
import type { Mode } from '../domain/network/stations';
import {
  blockPlacementAt,
  MAX_LAYOVER_S,
  type ScheduledVehicle,
  scheduledVehicles,
  type ServiceDayTrips,
  type ShapePath,
  vehicleBlocks,
} from '../domain/schedule/positions';
import { assembleRides, judgeRides, type RidesOutcome } from '../domain/schedule/rides';
import { type DirectReach, partitionReachable } from '../domain/trips/reachable';
import { dropBeatenRides } from '../domain/trips/trip-rides';
import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import { readRuntimeNetwork, type RuntimeNetwork } from './live-network';
import {
  daySeconds,
  findStation,
  readCalendarBounds,
  readDirectStationKeys,
  readMeta,
  readModeCalendar,
  readModeStartsAfter,
  readModeTripsAround,
  readNextDepartures,
  readPlatforms,
  readRideCandidates,
  readServiceDays,
  readShapePaths,
  readStationLines,
  readStations,
  readTripDestinations,
  readStopVisits,
  readTripRun,
  readTripsAround,
  type StationListing,
  type StationRef,
} from './schedule-queries';
import type { SqlExecutor } from './sql-executor';

/**
 * The schedule engine's public face (plan M3.2–M3.5): service days, departures, rides and scheduled
 * vehicle positions, read from the bundled schedule DB through the SqlExecutor contract.
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

export type VehiclesOutcome =
  | { readonly kind: 'vehicles'; readonly serviceDates: readonly number[]; readonly vehicles: readonly ScheduledVehicle[] }
  | CalendarGap;

/** The trips and shapes behind every vehicle of a span (timetableAround), or why the calendar has none. */
export type TimetableOutcome =
  | {
      readonly kind: 'timetable';
      readonly fromEpoch: number;
      readonly toEpoch: number;
      /** Each running service day with its trips around the span, in date order. */
      readonly days: readonly ServiceDayTrips[];
      readonly shapes: ReadonlyMap<number, ShapePath>;
    }
  | CalendarGap;

/** Each station's next scheduled departure per direction (R7), or why the calendar has none. */
export type NextDeparturesOutcome =
  | {
      readonly kind: 'next-departures';
      /** station key -> its earliest departure in each direction inside the window, in direction order; a station with none is absent. */
      readonly byStation: ReadonlyMap<string, readonly Departure[]>;
    }
  | CalendarGap;

/** A vehicle's next stops by the timetable (M6.6), the vehicle is not out at that instant, or why the calendar has none. */
export type NextStopsOutcome =
  | {
      readonly kind: 'next-stops';
      readonly vehicleKey: string;
      readonly lineId: LineId;
      readonly mode: Mode;
      /** Where its current trip ends. */
      readonly destination: string;
      /** At most MAX_NEXT_STOPS, in time order, all ahead of the vehicle. */
      readonly stops: readonly NextStop[];
    }
  | { readonly kind: 'not-running'; readonly vehicleKey: string }
  | CalendarGap;

/** Whether rail and the Mover run at an instant by the timetable (mfix4), or why the calendar cannot say. */
export type ModeStatusOutcome = ({ readonly kind: 'mode-status' } & ModeStatuses) | CalendarGap;

export class ScheduleRepo {
  readonly meta: ScheduleMeta;
  private readonly db: SqlExecutor;
  private readonly bounds: ServiceCalendarBounds;
  /** Every shape's path, read on the first positions call and kept (15 shapes, ~2,400 points). */
  private shapes: ReadonlyMap<number, ShapePath> | null = null;
  /** The live runtime's trip / stop / track lookups (M4.9), read on first use and kept. */
  private network: RuntimeNetwork | null = null;
  /** Every station (44 on the 2026 feed), read on first use and kept. */
  private stationList: readonly StationListing[] | null = null;
  /** trip_id → its destination station key (5,137 trips), read on first use and kept. */
  private destinations: ReadonlyMap<string, string> | null = null;
  /** Every station's lines, read on first use and kept. */
  private lineMap: ReadonlyMap<string, readonly LineId[]> | null = null;
  /** Each mode's first trip start on every service day (~1,260 rows), read on first use and kept. */
  private modeDays: ModeCalendar | null = null;
  /** Every platform with its directions (89 stops on the 2026 feed), read on first use and kept. */
  private platformList: readonly Platform[] | null = null;

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
    const departures = this.departuresFrom(station, resolution.days, window);
    invariant(departures.every((d) => resolution.days.some((day) => day.date === d.serviceDate)), 'every departure runs on a resolved service day');
    return ok({ kind: 'departures', serviceDates: resolution.days.map((day) => day.date), departures });
  }

  /**
   * Rides from one station to another boarding during `window` (same vehicle, at most one block hop).
   * With none: `needs-transfer` if anything departs the origin in the window, else `no-service`.
   */
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
    const rides = assembleRides(window, candidates);
    const departsFromA = rides.length > 0 || this.departuresFrom(stations.value.from, resolution.days, window).length > 0;
    return ok(judgeRides(rides, departsFromA));
  }

  /**
   * The rides a trip card offers (M7, m3a's input): `rides()`, minus every ride a direct ride that
   * departs no earlier beats on arrival — e.g. the 17-min Omni loop-around beside a 4-min direct
   * Brickell ride. Other outcomes pass through unchanged.
   */
  tripRides(fromKey: string, toKey: string, window: TimeWindow): Result<RidesQueryOutcome, UnknownStation> {
    const outcome = this.rides(fromKey, toKey, window);
    if (!outcome.ok || outcome.value.kind !== 'rides') {
      return outcome;
    }
    const kept = dropBeatenRides(outcome.value.rides);
    invariant(kept.length > 0, 'the earliest-arriving ride is never beaten, so a ride list stays non-empty');
    invariant(kept.length <= outcome.value.rides.length, 'the filter only drops rides');
    return ok({ kind: 'rides', rides: kept });
  }

  /**
   * The add-trip flow's destinations (M7.9): every other station, split into those one vehicle reaches
   * from `fromKey` on some day of the bundled timetable (same trip, or one block hop — rides()' two
   * shapes) and the rest, each excluded as `needs-transfer`. Both halves keep stations()' order.
   */
  directReachable(fromKey: string): Result<DirectReach<StationListing>, UnknownStation> {
    invariant(fromKey.includes(':'), `a station is keyed mode:name, got "${fromKey}"`);
    const from = findStation(this.db, fromKey);
    if (from === null) {
      return err({ kind: 'unknown-station', stationKey: fromKey });
    }
    const reach = partitionReachable(fromKey, this.stations(), readDirectStationKeys(this.db, from));
    invariant(reach.direct.length + reach.excluded.length === this.stations().length - 1, 'every other station is direct or excluded');
    return ok(reach);
  }

  /**
   * Every scheduled vehicle at `epoch` — one per block per running service day — or why the calendar
   * has none. The trips fetched run within MAX_LAYOVER_S of the instant, so a layover sees the trips
   * either side of its gap.
   */
  vehiclesAt(epoch: number): VehiclesOutcome {
    invariant(Number.isSafeInteger(epoch), `vehiclesAt needs a whole epoch second, got ${epoch}`);
    const timetable = this.timetableAround(epoch, epoch);
    if (timetable.kind !== 'timetable') {
      return timetable;
    }
    const vehicles = scheduledVehicles(epoch, timetable.days, timetable.shapes);
    const serviceDates = timetable.days.map(({ day }) => day.date);
    invariant(vehicles.every((v) => serviceDates.includes(v.serviceDate)), 'every vehicle runs a block of a running service day');
    return { kind: 'vehicles', serviceDates, vehicles };
  }

  /**
   * The timetable behind the vehicles of a whole span (the map's frames, M5.10): every running
   * service day's trips that run within MAX_LAYOVER_S of [fromEpoch, toEpoch], and every shape. With
   * it, scheduledVehicles / placeVehicle place the vehicles at ANY instant of the span exactly as
   * vehiclesAt would — read once per span, so no query runs per frame.
   */
  timetableAround(fromEpoch: number, toEpoch: number): TimetableOutcome {
    invariant(Number.isSafeInteger(fromEpoch) && Number.isSafeInteger(toEpoch), 'a timetable span runs between whole epoch seconds');
    invariant(fromEpoch <= toEpoch, 'a timetable span is ordered');
    const window = windowFrom(fromEpoch - MAX_LAYOVER_S, toEpoch - fromEpoch + 2 * MAX_LAYOVER_S);
    const resolution = this.serviceDays(window);
    if (resolution.kind !== 'active') {
      return resolution;
    }
    const days = resolution.days.map((day) => ({ day, trips: readTripsAround(this.db, day, daySeconds(day, window)) }));
    return { kind: 'timetable', fromEpoch, toEpoch, days, shapes: this.shapePaths() };
  }

  /** What the live mappers need from the schedule (trip → line, stop → station, line tracks), plus each station's stops. */
  liveNetwork(): RuntimeNetwork {
    const network = this.network ?? readRuntimeNetwork(this.db);
    this.network = network;
    invariant(network.tracks.length > 0, 'the schedule DB has line tracks');
    invariant(this.network === network, 'the network is read once, then kept');
    return network;
  }

  /** Every station, rail first, each mode in name order (the Stations tab, M5.5; the map's markers, M5.8). */
  stations(): readonly StationListing[] {
    const stations = this.stationList ?? Object.freeze(readStations(this.db));
    this.stationList = stations;
    invariant(stations.length > 0, 'the schedule DB has stations');
    invariant(this.stationList === stations, 'the stations are read once, then kept');
    return stations;
  }

  /** Departures from `station` on the running service days, inside `window`; terminating trains excluded. */
  private departuresFrom(station: StationRef, days: readonly ServiceDay[], window: TimeWindow): Departure[] {
    invariant(days.length > 0, 'departures are read for running service days');
    const visits = days.map((day) => ({ day, visits: readStopVisits(this.db, station, day, daySeconds(day, window)) }));
    const departures = assembleDepartures(window, visits);
    invariant(departures.every((d) => d.epoch >= window.fromEpoch && d.epoch <= window.toEpoch), 'every departure is inside the window');
    return departures;
  }

  /** trip_id → the station key of the trip's last stop: where a vehicle on the map is going (mfix3 §5 vehicle taps). */
  tripDestinations(): ReadonlyMap<string, string> {
    const destinations = this.destinations ?? readTripDestinations(this.db);
    this.destinations = destinations;
    invariant(destinations.size > 0, 'the schedule DB has trips');
    invariant(this.destinations === destinations, 'the destinations are read once, then kept');
    return destinations;
  }

  /** Every platform (stop) with its station, coordinate and directions (hurry-or-chill's walk target, M7c.3). */
  platforms(): readonly Platform[] {
    const platforms = this.platformList ?? Object.freeze(readPlatforms(this.db));
    this.platformList = platforms;
    invariant(platforms.length > 0, 'the schedule DB has platforms');
    invariant(this.platformList === platforms, 'the platforms are read once, then kept');
    return platforms;
  }

  /** station key -> every line stopping there, in line order (the line strips, M6.5). */
  stationLines(): ReadonlyMap<string, readonly LineId[]> {
    const lines = this.lineMap ?? readStationLines(this.db);
    this.lineMap = lines;
    invariant(lines.size > 0, 'the schedule DB has stations served by lines');
    invariant(this.lineMap === lines, 'the station lines are read once, then kept');
    return lines;
  }

  /**
   * Every station's next scheduled departure in each direction during `window` (R7: the Stations list,
   * schedule only, ONE statement per running service day for the whole list), or why the calendar has none.
   */
  nextDepartures(window: TimeWindow): NextDeparturesOutcome {
    invariant(window.fromEpoch <= window.toEpoch, 'nextDepartures needs an ordered window');
    const resolution = this.serviceDays(window);
    if (resolution.kind !== 'active') {
      return resolution;
    }
    const daysByStation = new Map<string, ServiceDayVisits[]>();
    for (const day of resolution.days) {
      for (const { stationKey, visit } of readNextDepartures(this.db, day, daySeconds(day, window))) {
        const days = daysByStation.get(stationKey) ?? [];
        const last = days[days.length - 1];
        if (last !== undefined && last.day === day) {
          days[days.length - 1] = { day, visits: [...last.visits, visit] };
        } else {
          days.push({ day, visits: [visit] });
        }
        daysByStation.set(stationKey, days);
      }
    }
    const byStation = new Map([...daysByStation].map(([key, days]) => [key, firstPerDirection(assembleDepartures(window, days))] as const));
    invariant([...byStation.values()].every((list) => list.length > 0), 'a listed station has a departure');
    return { kind: 'next-departures', byStation };
  }

  /**
   * The vehicle's next stops at `epoch` by the timetable (M6.6): its block's trip at that instant (the
   * same placement the map draws), then up to three stops ahead, continuing onto the trip its car runs
   * next (next_trip_idx). A vehicle not out at `epoch` (or a key the timetable does not know) is not-running.
   */
  nextStops(vehicleKey: string, epoch: number): NextStopsOutcome {
    invariant(vehicleKey.length > 0, 'nextStops needs a vehicle key');
    const timetable = this.timetableAround(epoch, epoch);
    if (timetable.kind !== 'timetable') {
      return timetable;
    }
    const block = vehicleBlocks(timetable.days).find((candidate) => candidate.vehicleKey === vehicleKey);
    const placed = block === undefined ? null : blockPlacementAt(block.trips, epoch - block.baseEpoch);
    if (block === undefined || placed === null) {
      return { kind: 'not-running', vehicleKey };
    }
    const current = readTripRun(this.db, placed.trip.tripIdx);
    invariant(current !== null, `the timetable's trip ${placed.trip.tripId} has its stops`);
    const following = current.nextTripIdx === null ? null : readTripRun(this.db, current.nextTripIdx);
    invariant(current.nextTripIdx === null || following !== null, `trip ${placed.trip.tripId} links to a trip the schedule has`);
    const stops = nextStops({ baseEpoch: block.baseEpoch, s: epoch - block.baseEpoch, state: placed.state, current, following });
    const lineId = LINE_IDS.find((id) => id === placed.trip.lineId);
    invariant(lineId !== undefined, `trip ${placed.trip.tripId} runs a catalog line`);
    const destination = current.stops[current.stops.length - 1]?.name ?? '';
    return { kind: 'next-stops', vehicleKey, lineId, mode: placed.trip.mode, destination, stops };
  }

  /**
   * Whether rail and the Mover run at `epoch` by the timetable (mfix4, mode-status.ts decides): each
   * running, closed until its next trip (later this service day, or on a later one), or past its
   * bundled timetable — or why the calendar has no service day then. Reads each running day's trips
   * around [epoch, epoch + STARTING_SOON_S] and each mode's next start that day (two small statements
   * per day, on trip_by_service_start); later days come from the mode calendar, read once.
   */
  modeStatusAt(epoch: number): ModeStatusOutcome {
    invariant(Number.isSafeInteger(epoch), `modeStatusAt needs a whole epoch second, got ${epoch}`);
    const window = windowFrom(epoch, STARTING_SOON_S);
    const resolution = this.serviceDays(window);
    if (resolution.kind !== 'active') {
      return resolution;
    }
    const days = resolution.days.map((day) => {
      const seconds = daySeconds(day, window);
      return { day, trips: readModeTripsAround(this.db, day, seconds), startsAfter: readModeStartsAfter(this.db, day, seconds.fromS) };
    });
    const statuses = modeStatuses(epoch, { days, calendar: this.modeCalendar() });
    invariant(Object.values(statuses).every((status) => status.kind !== 'closed' || status.nextStart.epoch > epoch), 'a closed mode opens after the instant');
    return { kind: 'mode-status', ...statuses };
  }

  private modeCalendar(): ModeCalendar {
    const calendar = this.modeDays ?? readModeCalendar(this.db);
    this.modeDays = calendar;
    invariant(calendar.rail.length + calendar.mover.length > 0, 'the schedule DB has service days with trips');
    invariant(this.modeDays === calendar, 'the mode calendar is read once, then kept');
    return calendar;
  }

  private shapePaths(): ReadonlyMap<number, ShapePath> {
    const shapes = this.shapes ?? readShapePaths(this.db);
    this.shapes = shapes;
    invariant(shapes.size > 0, 'the schedule DB has shapes');
    invariant(this.shapes === shapes, 'the shapes are read once, then kept');
    return shapes;
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
