import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import {
  AGENCY,
  CALENDAR,
  CALENDAR_DATES,
  FEED_INFO,
  FREQUENCIES,
  readTable,
  ROUTES,
  SHAPES,
  STOP_TIMES,
  STOPS,
  TRIPS,
  type RawRow,
  type TableError,
  type TableRow,
  type TableSchema,
} from './feed-tables';
import { FEED_TIME_ZONE, IN_SCOPE_ROUTE_IDS } from './scope';
import type { FeedFiles } from './unzip-feed';

/**
 * Steps 4–6 of the GTFS pipeline (plan §4): parse the unzipped feed, keep only the in-scope routes
 * (Metrorail 31009, Metromover 14457 and 14456) and everything they reference, and assert the feed
 * basics. Every one of these is an Err that names the file and the offending value:
 *  - agency_timezone is America/New_York (the Mac does all time-zone math in it);
 *  - every in-scope route exists;
 *  - in-scope stop_times allow boarding and alighting everywhere (pickup_type and drop_off_type 0) —
 *    checked AFTER scoping, because the real feed's bus rows do carry pickup_type=1;
 *  - every time is a GTFS time (the `time` column kind, in feed-tables.ts);
 *  - no in-scope trip is frequency-based;
 *  - every stop, shape and service an in-scope row references exists.
 */

export type Agency = TableRow<typeof AGENCY>;
export type Route = TableRow<typeof ROUTES>;
export type Trip = TableRow<typeof TRIPS>;
export type StopTime = TableRow<typeof STOP_TIMES>;
export type Stop = TableRow<typeof STOPS>;
export type CalendarRow = TableRow<typeof CALENDAR>;
export type CalendarDate = TableRow<typeof CALENDAR_DATES>;
export type ShapePoint = TableRow<typeof SHAPES>;
export type FeedInfo = TableRow<typeof FEED_INFO>;

/** The in-scope slice of the feed, in file order. */
export type LoadedFeed = {
  readonly timeZone: string;
  readonly routes: readonly Route[];
  readonly trips: readonly Trip[];
  readonly stopTimes: readonly StopTime[];
  readonly stops: readonly Stop[];
  readonly shapePoints: readonly ShapePoint[];
  readonly calendar: readonly CalendarRow[];
  /** Empty when the feed has no calendar_dates.txt. */
  readonly calendarDates: readonly CalendarDate[];
  readonly feedInfo: FeedInfo | null;
};

export type FeedCheckError = { readonly kind: 'feed'; readonly file: string; readonly message: string };
export type LoadError = TableError | FeedCheckError;

type Network = Pick<LoadedFeed, 'timeZone' | 'routes' | 'trips' | 'stopTimes'>;

export function loadFeed(files: FeedFiles): Result<LoadedFeed, LoadError> {
  invariant(IN_SCOPE_ROUTE_IDS.length > 0, 'the pipeline keeps at least one route');
  const network = loadNetwork(files);
  if (!network.ok) {
    return network;
  }
  const referenced = loadReferenced(files, network.value);
  if (!referenced.ok) {
    return referenced;
  }
  const feed: LoadedFeed = { ...network.value, ...referenced.value };
  invariant(feed.trips.every((trip) => IN_SCOPE_ROUTE_IDS.includes(trip.route_id)), 'only in-scope trips are loaded');
  return ok(feed);
}

/** The agency time zone, the in-scope routes, their trips, and those trips' stop_times. */
function loadNetwork(files: FeedFiles): Result<Network, LoadError> {
  invariant(files['agency.txt'] instanceof Uint8Array, 'loadNetwork reads the unzipped feed');
  const timeZone = loadTimeZone(files['agency.txt']);
  if (!timeZone.ok) {
    return timeZone;
  }
  const routes = loadRoutes(files['routes.txt']);
  if (!routes.ok) {
    return routes;
  }
  const inScope = new Set(IN_SCOPE_ROUTE_IDS);
  const trips = readTable(TRIPS, files['trips.txt'], (raw) => inScope.has(raw.route_id));
  if (!trips.ok) {
    return trips;
  }
  const stopTimes = loadStopTimes(files['stop_times.txt'], new Set(trips.value.map((trip) => trip.trip_id)));
  if (!stopTimes.ok) {
    return stopTimes;
  }
  invariant(trips.value.length > 0, 'an in-scope route has trips');
  return ok({ timeZone: timeZone.value, routes: routes.value, trips: trips.value, stopTimes: stopTimes.value });
}

/** The stops, shape points and services the network references, plus the optional files. */
function loadReferenced(files: FeedFiles, network: Network): Result<Omit<LoadedFeed, keyof Network>, LoadError> {
  invariant(network.trips.length > 0 && network.stopTimes.length > 0, 'the network has trips and stop_times');
  const stopIds = new Set(network.stopTimes.map((row) => row.stop_id));
  const stops = loadByIds(STOPS, files['stops.txt'], 'stop_id', stopIds, 'in-scope stop_times');
  if (!stops.ok) {
    return stops;
  }
  const shapeIds = new Set(network.trips.map((trip) => trip.shape_id));
  const shapePoints = loadByIds(SHAPES, files['shapes.txt'], 'shape_id', shapeIds, 'in-scope trips');
  if (!shapePoints.ok) {
    return shapePoints;
  }
  const services = loadServices(files, new Set(network.trips.map((trip) => trip.service_id)));
  if (!services.ok) {
    return services;
  }
  const frequencies = assertNoFrequencies(files['frequencies.txt'], new Set(network.trips.map((trip) => trip.trip_id)));
  if (!frequencies.ok) {
    return frequencies;
  }
  const feedInfo = loadFeedInfo(files['feed_info.txt']);
  if (!feedInfo.ok) {
    return feedInfo;
  }
  invariant(stops.value.length === stopIds.size, 'exactly the referenced stops are loaded');
  return ok({ stops: stops.value, shapePoints: shapePoints.value, ...services.value, feedInfo: feedInfo.value });
}

function loadTimeZone(input: Uint8Array): Result<string, LoadError> {
  invariant(FEED_TIME_ZONE.length > 0, 'the expected time zone is configured');
  const agencies = readTable(AGENCY, input);
  if (!agencies.ok) {
    return agencies;
  }
  const wrong = agencies.value.find((agency) => agency.agency_timezone !== FEED_TIME_ZONE);
  if (agencies.value.length === 0 || wrong !== undefined) {
    const found = wrong === undefined ? 'no agency rows' : `agency_timezone ${JSON.stringify(wrong.agency_timezone)}`;
    return err(feedError('agency.txt', `${found}; the pipeline computes service days in ${FEED_TIME_ZONE}`));
  }
  invariant(agencies.value.every((agency) => agency.agency_timezone === FEED_TIME_ZONE), 'every agency shares the time zone');
  return ok(FEED_TIME_ZONE);
}

function loadRoutes(input: Uint8Array): Result<Route[], LoadError> {
  const inScope = new Set(IN_SCOPE_ROUTE_IDS);
  invariant(inScope.size === IN_SCOPE_ROUTE_IDS.length, 'in-scope route ids are distinct');
  const routes = readTable(ROUTES, input, (raw) => inScope.has(raw.route_id));
  if (!routes.ok) {
    return routes;
  }
  const missing = IN_SCOPE_ROUTE_IDS.find((id) => !routes.value.some((route) => route.route_id === id));
  if (missing !== undefined) {
    return err(feedError('routes.txt', `has no route_id ${missing}, which is in scope`));
  }
  invariant(routes.value.length >= inScope.size, 'every in-scope route is loaded');
  return ok(routes.value);
}

/** In-scope stop_times; each must let riders board and alight (pickup_type = drop_off_type = 0). */
function loadStopTimes(input: Uint8Array, tripIds: ReadonlySet<string>): Result<StopTime[], LoadError> {
  invariant(tripIds.size > 0, 'stop_times are loaded for at least one trip');
  const stopTimes = readTable(STOP_TIMES, input, (raw) => tripIds.has(raw.trip_id));
  if (!stopTimes.ok) {
    return stopTimes;
  }
  for (const row of stopTimes.value) {
    const column = row.pickup_type !== 0 ? 'pickup_type' : row.drop_off_type !== 0 ? 'drop_off_type' : null;
    if (column !== null) {
      const where = `trip ${row.trip_id} stop_sequence ${row.stop_sequence} (stop ${row.stop_id})`;
      return err(feedError('stop_times.txt', `${column}=${row[column]} on ${where}; in-scope trips must serve every stop`));
    }
  }
  invariant(stopTimes.value.every((row) => tripIds.has(row.trip_id)), 'only in-scope stop_times are loaded');
  return ok(stopTimes.value);
}

/** The rows of `schema` whose `column` is one of `ids`; an id with no row is an Err. */
function loadByIds<S extends TableSchema>(
  schema: S,
  input: Uint8Array,
  column: keyof RawRow<S> & string,
  ids: ReadonlySet<string>,
  referencedBy: string,
): Result<TableRow<S>[], LoadError> {
  invariant(ids.size > 0, `${schema.file}: at least one id is referenced`);
  const rows = readTable(schema, input, (raw) => ids.has(raw[column]));
  if (!rows.ok) {
    return rows;
  }
  const found = new Set(rows.value.map((row) => String(row[column])));
  const missing = [...ids].find((id) => !found.has(id));
  if (missing !== undefined) {
    return err(feedError(schema.file, `has no ${column} ${missing}, referenced by ${referencedBy}`));
  }
  invariant(found.size === ids.size, 'every referenced id was found');
  return ok(rows.value);
}

type Services = Pick<LoadedFeed, 'calendar' | 'calendarDates'>;

/** calendar.txt and (optional) calendar_dates.txt rows for the in-scope services, each defined somewhere. */
function loadServices(files: FeedFiles, serviceIds: ReadonlySet<string>): Result<Services, LoadError> {
  invariant(serviceIds.size > 0, 'in-scope trips reference at least one service');
  const calendar = readTable(CALENDAR, files['calendar.txt'], (raw) => serviceIds.has(raw.service_id));
  if (!calendar.ok) {
    return calendar;
  }
  const datesFile = files['calendar_dates.txt'];
  const dates = datesFile === undefined ? ok([]) : readTable(CALENDAR_DATES, datesFile, (raw) => serviceIds.has(raw.service_id));
  if (!dates.ok) {
    return dates;
  }
  const badException = dates.value.find((row) => row.exception_type !== 1 && row.exception_type !== 2);
  if (badException !== undefined) {
    return err(feedError('calendar_dates.txt', `exception_type ${badException.exception_type} is not 1 (added) or 2 (removed)`));
  }
  const defined = new Set([...calendar.value, ...dates.value].map((row) => row.service_id));
  const undefinedService = [...serviceIds].find((id) => !defined.has(id));
  if (undefinedService !== undefined) {
    return err(feedError('calendar.txt', `service_id ${undefinedService} is used by an in-scope trip but defined nowhere`));
  }
  invariant(defined.size === serviceIds.size, 'exactly the in-scope services are loaded');
  return ok({ calendar: calendar.value, calendarDates: dates.value });
}

/** Headway-based (frequencies.txt) service is not modelled; an in-scope trip using it is an Err. */
function assertNoFrequencies(input: Uint8Array | undefined, tripIds: ReadonlySet<string>): Result<null, LoadError> {
  invariant(tripIds.size > 0, 'the check covers at least one trip');
  if (input === undefined) {
    return ok(null);
  }
  const rows = readTable(FREQUENCIES, input, (raw) => tripIds.has(raw.trip_id));
  if (!rows.ok) {
    return rows;
  }
  const first = rows.value[0];
  if (first !== undefined) {
    return err(feedError('frequencies.txt', `in-scope trip ${first.trip_id} is frequency-based; only timetabled trips are modelled`));
  }
  invariant(rows.value.length === 0, 'no in-scope trip is frequency-based');
  return ok(null);
}

function loadFeedInfo(input: Uint8Array | undefined): Result<FeedInfo | null, LoadError> {
  invariant(input === undefined || input instanceof Uint8Array, 'feed_info.txt is absent or raw bytes');
  if (input === undefined) {
    return ok(null);
  }
  const rows = readTable(FEED_INFO, input);
  if (!rows.ok) {
    return rows;
  }
  if (rows.value.length > 1) {
    return err(feedError('feed_info.txt', `has ${rows.value.length} rows; GTFS allows one`));
  }
  invariant(rows.value.length <= 1, 'feed_info.txt holds at most one row');
  return ok(rows.value[0] ?? null);
}

function feedError(file: string, problem: string): FeedCheckError {
  invariant(file.endsWith('.txt'), 'a feed error names the GTFS file');
  const error: FeedCheckError = { kind: 'feed', file, message: `${file}: ${problem}` };
  invariant(error.message.startsWith(file), 'the message leads with the file');
  return error;
}
