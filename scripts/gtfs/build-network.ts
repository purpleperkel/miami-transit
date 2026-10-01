import { deriveLine } from '../../src/domain/lines/derive-line';
import { catalogStationKeys, LINE_CATALOG, type LineDef, type LineId, type LineVariant } from '../../src/domain/lines/line-catalog';
import { buildStations, type Mode, type Station, type StationIndex, type StopInput } from '../../src/domain/network/stations';
import { buildShapeGeometry, projectStops, type ShapeGeometry } from '../../src/domain/schedule/shape-geometry';
import type { LatLon } from '../../src/lib/geo';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { linkBlocks } from './block-links';
import type { LoadedFeed, StopTime, Trip } from './load-feed';
import { IN_SCOPE_ROUTE_IDS, modeOfRoute } from './scope';
import { buildTransfers, type Transfer } from './transfers';

/**
 * Plan §4 steps 7–9, 11 and 12 (M2.9–M2.13): turn the loaded feed into the network the schedule
 * DB stores — stations, stop patterns with their derived line and stop distances, trips with their
 * destination, note and block link, and transfers. Every contradiction is an Err (a build error):
 * a stop served by two modes, a renamed sentinel station, a pattern touching both branches, a stop
 * > 100 m off its shape, an overlapping block.
 *
 * Output order is fixed (patterns by key, trips by route/service/start/trip_id), so the same feed
 * always gives the same indices — the DB build is byte-for-byte reproducible.
 */

export type NetworkShape = { readonly shapeId: string; readonly geometry: ShapeGeometry };

/** One real pattern: a distinct (route, ordered stops, shape). */
export type NetworkPattern = {
  readonly idx: number;
  readonly routeId: string;
  readonly shapeId: string;
  readonly lineId: LineId;
  readonly variant: LineVariant;
  readonly stopIds: readonly string[];
  readonly stationKeys: readonly string[];
  /** Metres along the shape for each stop, non-decreasing. */
  readonly distancesM: readonly number[];
};

export type NetworkTrip = {
  readonly idx: number;
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly directionId: number;
  readonly blockId: string;
  /** As published. Never used as the destination: weekend Green trips say "EHT - CUL SINGLE TRACK…". */
  readonly headsign: string;
  readonly patternIdx: number;
  /** The trip's first station. */
  readonly originKey: string;
  /** The trip's last station: where it really goes. */
  readonly destinationKey: string;
  /** A rider-facing service note read from the headsign, or null. */
  readonly note: string | null;
  /** First departure and last arrival, in service seconds. */
  readonly startS: number;
  readonly endS: number;
  /** The trip the vehicle continues as with riders aboard (Mover joins), or null. */
  readonly nextTripIdx: number | null;
};

export type NetworkModel = {
  readonly stations: readonly Station[];
  readonly stationOfStop: ReadonlyMap<string, string>;
  readonly lines: readonly LineDef[];
  readonly shapes: readonly NetworkShape[];
  readonly patterns: readonly NetworkPattern[];
  readonly trips: readonly NetworkTrip[];
  readonly transfers: readonly Transfer[];
};

export type NetworkStep = 'stops' | 'stations' | 'catalog' | 'trips' | 'shapes' | 'lines' | 'blocks';
export type NetworkError = { readonly kind: 'network'; readonly step: NetworkStep; readonly message: string };

export function buildNetwork(feed: LoadedFeed): Result<NetworkModel, NetworkError> {
  invariant(feed.trips.length > 0 && feed.stopTimes.length > 0, 'the network is built from a loaded feed');
  invariant(IN_SCOPE_ROUTE_IDS.every((routeId) => LINE_CATALOG.some((line) => line.routeId === routeId)), 'every in-scope route has a line');
  const stations = buildStationIndex(feed);
  if (!stations.ok) {
    return stations;
  }
  const tripStops = groupStopTimes(feed);
  if (!tripStops.ok) {
    return tripStops;
  }
  const shapes = buildShapes(feed);
  if (!shapes.ok) {
    return shapes;
  }
  const patterns = buildPatterns(feed, tripStops.value, stations.value.stationOfStop, shapes.value);
  if (!patterns.ok) {
    return patterns;
  }
  const trips = buildTrips(feed.trips, tripStops.value, patterns.value);
  if (!trips.ok) {
    return trips;
  }
  const model: NetworkModel = {
    ...stations.value,
    lines: LINE_CATALOG,
    shapes: [...shapes.value].map(([shapeId, geometry]) => ({ shapeId, geometry })),
    patterns: patterns.value.patterns,
    trips: trips.value,
    transfers: buildTransfers(stations.value.stations),
  };
  invariant(model.trips.length === feed.trips.length, 'every loaded trip is in the network');
  return ok(model);
}

/** Stations from the loaded stops, checked against the line catalog: a sentinel the feed lacks is an Err. */
function buildStationIndex(feed: LoadedFeed): Result<StationIndex, NetworkError> {
  invariant(feed.stops.length > 0, 'stations are built from the loaded stops');
  const stops = networkStops(feed);
  if (!stops.ok) {
    return err(networkError('stops', stops.error.message));
  }
  const stations = buildStations(stops.value);
  if (!stations.ok) {
    return err(networkError('stations', stations.error.message));
  }
  const known = new Set(stations.value.stations.map((station) => station.key));
  const missing = catalogStationKeys().filter((key) => !known.has(key));
  if (missing.length > 0) {
    return err(networkError('catalog', `the line catalog names stations this feed lacks: ${missing.join(', ')}`));
  }
  invariant(stations.value.stationOfStop.size === stops.value.length, 'every stop has a station');
  return stations;
}

/** Every loaded stop with the mode of the routes serving it; a stop served by both modes is an Err. */
export function networkStops(feed: LoadedFeed): Result<StopInput[], { readonly message: string }> {
  invariant(feed.stops.length > 0, 'the feed has stops');
  const routeOfTrip = new Map(feed.trips.map((trip) => [trip.trip_id, trip.route_id]));
  const modeOfStop = new Map<string, Mode>();
  for (const row of feed.stopTimes) {
    const mode = modeOfRoute(routeOfTrip.get(row.trip_id) ?? '?');
    invariant(mode !== null, `stop_time of trip ${row.trip_id} belongs to an in-scope route`);
    if ((modeOfStop.get(row.stop_id) ?? mode) !== mode) {
      return err({ message: `stop ${row.stop_id} is served by both rail and Mover trips (trip ${row.trip_id})` });
    }
    modeOfStop.set(row.stop_id, mode);
  }
  const stops: StopInput[] = [];
  for (const stop of feed.stops) {
    const mode = modeOfStop.get(stop.stop_id);
    invariant(mode !== undefined, `loaded stop ${stop.stop_id} is served by an in-scope trip`);
    stops.push({ stopId: stop.stop_id, name: stop.stop_name, latitude: stop.stop_lat, longitude: stop.stop_lon, mode });
  }
  return ok(stops);
}

/** Each trip's stop_times in stop_sequence order; a trip needs two distinct stops in sequence. */
export function groupStopTimes(feed: LoadedFeed): Result<Map<string, StopTime[]>, NetworkError> {
  invariant(feed.stopTimes.length > 0, 'the feed has stop_times');
  const byTrip = new Map<string, StopTime[]>(feed.trips.map((trip) => [trip.trip_id, []]));
  for (const row of feed.stopTimes) {
    const rows = byTrip.get(row.trip_id);
    invariant(rows !== undefined, `stop_time trip ${row.trip_id} is a loaded trip`);
    rows.push(row);
  }
  for (const [tripId, rows] of byTrip) {
    rows.sort((a, b) => a.stop_sequence - b.stop_sequence);
    const repeated = rows.find((row, i) => i > 0 && rows[i - 1]?.stop_sequence === row.stop_sequence);
    if (rows.length < 2 || repeated !== undefined) {
      const problem = repeated === undefined ? `has ${rows.length} stop time(s)` : `repeats stop_sequence ${repeated.stop_sequence}`;
      return err(networkError('trips', `trip ${tripId} ${problem}; a trip visits at least two stops in sequence`));
    }
  }
  invariant([...byTrip.values()].every((rows) => rows.length >= 2), 'every trip has at least two stop times');
  return ok(byTrip);
}

/** Each in-scope shape's geometry, from its points in shape_pt_sequence order, keyed (and sorted) by shape_id. */
function buildShapes(feed: LoadedFeed): Result<Map<string, ShapeGeometry>, NetworkError> {
  invariant(feed.shapePoints.length > 0, 'the feed has shape points');
  const pointsOf = new Map<string, { sequence: number; point: LatLon }[]>();
  for (const row of feed.shapePoints) {
    const points = pointsOf.get(row.shape_id) ?? [];
    points.push({ sequence: row.shape_pt_sequence, point: { latitude: row.shape_pt_lat, longitude: row.shape_pt_lon } });
    pointsOf.set(row.shape_id, points);
  }
  const shapes = new Map<string, ShapeGeometry>();
  for (const shapeId of [...pointsOf.keys()].sort()) {
    const points = (pointsOf.get(shapeId) ?? []).sort((a, b) => a.sequence - b.sequence).map((entry) => entry.point);
    const geometry = buildShapeGeometry(points);
    if (!geometry.ok) {
      return err(networkError('shapes', `shape ${shapeId}: ${geometry.error.message}`));
    }
    shapes.set(shapeId, geometry.value);
  }
  invariant(feed.trips.every((trip) => shapes.has(trip.shape_id)), 'every trip has a built shape');
  return ok(shapes);
}

type PatternDraft = { readonly routeId: string; readonly shapeId: string; readonly stopIds: readonly string[] };
type Patterns = { readonly patterns: readonly NetworkPattern[]; readonly patternOfTrip: ReadonlyMap<string, number> };
type PatternContext = {
  readonly stationOfStop: ReadonlyMap<string, string>;
  readonly coordinates: ReadonlyMap<string, LatLon>;
  readonly shapes: ReadonlyMap<string, ShapeGeometry>;
};

/** The distinct (route, stops, shape) patterns, in key order, and each trip's pattern index. */
function buildPatterns(
  feed: LoadedFeed,
  tripStops: ReadonlyMap<string, readonly StopTime[]>,
  stationOfStop: ReadonlyMap<string, string>,
  shapes: ReadonlyMap<string, ShapeGeometry>,
): Result<Patterns, NetworkError> {
  invariant(tripStops.size === feed.trips.length, 'every trip has its stop times');
  const keyOfTrip = new Map<string, string>();
  const drafts = new Map<string, PatternDraft>();
  for (const trip of feed.trips) {
    const stopIds = (tripStops.get(trip.trip_id) ?? []).map((row) => row.stop_id);
    const key = `${trip.route_id}|${trip.shape_id}|${stopIds.join(',')}`;
    keyOfTrip.set(trip.trip_id, key);
    drafts.set(key, { routeId: trip.route_id, shapeId: trip.shape_id, stopIds });
  }
  const coordinates = new Map(feed.stops.map((stop) => [stop.stop_id, { latitude: stop.stop_lat, longitude: stop.stop_lon }]));
  const context: PatternContext = { stationOfStop, coordinates, shapes };
  const keys = [...drafts.keys()].sort();
  const patterns: NetworkPattern[] = [];
  for (const [idx, key] of keys.entries()) {
    const pattern = buildPattern(idx, drafts.get(key), context);
    if (!pattern.ok) {
      return pattern;
    }
    patterns.push(pattern.value);
  }
  const indexOf = new Map(keys.map((key, idx) => [key, idx]));
  const patternOfTrip = new Map([...keyOfTrip].map(([tripId, key]) => [tripId, indexOf.get(key) ?? -1]));
  invariant([...patternOfTrip.values()].every((idx) => idx >= 0), 'every trip has a pattern');
  return ok({ patterns, patternOfTrip });
}

/** One pattern: its stations, its line derived from them (never the headsign), and its stops along the shape. */
function buildPattern(idx: number, draft: PatternDraft | undefined, context: PatternContext): Result<NetworkPattern, NetworkError> {
  invariant(draft !== undefined, 'every pattern key has its draft');
  const shape = context.shapes.get(draft.shapeId);
  invariant(shape !== undefined, `shape ${draft.shapeId} was built`);
  const stationKeys: string[] = [];
  const stops: LatLon[] = [];
  for (const stopId of draft.stopIds) {
    const [station, at] = [context.stationOfStop.get(stopId), context.coordinates.get(stopId)];
    invariant(station !== undefined && at !== undefined, `stop ${stopId} is clustered and located`);
    stationKeys.push(station);
    stops.push(at);
  }
  const line = deriveLine(draft.routeId, stationKeys);
  if (!line.ok) {
    return err(networkError('lines', `shape ${draft.shapeId}: ${line.error.message}`));
  }
  const distancesM = projectStops(shape, stops);
  if (!distancesM.ok) {
    const where = distancesM.error.index === null ? '' : ` (stop_id ${draft.stopIds[distancesM.error.index]})`;
    return err(networkError('shapes', `route ${draft.routeId} shape ${draft.shapeId}: ${distancesM.error.message}${where}`));
  }
  const { line: lineId, variant } = line.value;
  return ok({ idx, ...draft, lineId, variant, stationKeys, distancesM: distancesM.value });
}

type TripDraft = Omit<NetworkTrip, 'idx' | 'nextTripIdx'>;

/** Trips in a fixed order (route, service, start, trip_id), each with its pattern, destination, note and block link. */
function buildTrips(
  feedTrips: readonly Trip[],
  tripStops: ReadonlyMap<string, readonly StopTime[]>,
  { patterns, patternOfTrip }: Patterns,
): Result<NetworkTrip[], NetworkError> {
  invariant(patterns.length > 0, 'trips are built over their patterns');
  const drafts = feedTrips.map((trip) => tripDraft(trip, tripStops.get(trip.trip_id) ?? [], patterns[patternOfTrip.get(trip.trip_id) ?? -1]));
  drafts.sort(
    (a, b) => compareText(a.routeId, b.routeId) || compareText(a.serviceId, b.serviceId) || a.startS - b.startS || compareText(a.tripId, b.tripId),
  );
  const next = linkBlocks(drafts.map((draft, idx) => ({ ...draft, idx })));
  if (!next.ok) {
    return err(networkError('blocks', next.error));
  }
  const trips = drafts.map((draft, idx) => ({ idx, ...draft, nextTripIdx: next.value[idx] ?? null }));
  invariant(trips.every((trip) => trip.destinationKey === patterns[trip.patternIdx]?.stationKeys.at(-1)), 'each destination is its last station');
  return ok(trips);
}

/** A trip before ordering: its destination is its pattern's LAST STATION, whatever the headsign says. */
function tripDraft(trip: Trip, rows: readonly StopTime[], pattern: NetworkPattern | undefined): TripDraft {
  const [first, last] = [rows[0], rows[rows.length - 1]];
  invariant(pattern !== undefined && first !== undefined && last !== undefined, `trip ${trip.trip_id} has a pattern and stop times`);
  const [originKey, destinationKey] = [pattern.stationKeys[0], pattern.stationKeys[pattern.stationKeys.length - 1]];
  invariant(originKey !== undefined && destinationKey !== undefined, `pattern ${pattern.idx} has a first and a last station`);
  return {
    tripId: trip.trip_id,
    routeId: trip.route_id,
    serviceId: trip.service_id,
    directionId: trip.direction_id,
    blockId: trip.block_id,
    headsign: trip.trip_headsign,
    patternIdx: pattern.idx,
    originKey,
    destinationKey,
    note: tripNote(trip.trip_headsign),
    startS: first.departure_time,
    endS: last.arrival_time,
  };
}

const SINGLE_TRACK = /\bSINGLE[\s-]*TRACK\b/i;
const AFTER_TIME = /\bAFTER\s*(\d{1,2})(?::(\d{2}))?\s*([AP])\.?\s*M\b/i;

/**
 * The rider-facing note a headsign carries. The weekend Green trips are signed
 * "EHT - CUL SINGLE TRACK AFTER 8PM" (one direction) and "… AFTER 8 PM" (the other); both read
 * "Single-track service after 8 PM". Any other headsign carries no note.
 */
export function tripNote(headsign: string): string | null {
  invariant(typeof headsign === 'string', 'a headsign is text (possibly empty)');
  if (!SINGLE_TRACK.test(headsign)) {
    return null;
  }
  const after = AFTER_TIME.exec(headsign);
  const minutes = after?.[2] === undefined ? '' : `:${after[2]}`;
  const time = after === null ? '' : ` after ${after[1]}${minutes} ${(after[3] ?? '').toUpperCase()}M`;
  const note = `Single-track service${time}`;
  invariant(note.startsWith('Single-track service'), 'a single-track note names the operation');
  return note;
}

function networkError(step: NetworkStep, message: string): NetworkError {
  invariant(message.length > 0, 'a network error explains itself');
  const error: NetworkError = { kind: 'network', step, message: `build-network (${step}): ${message}` };
  invariant(error.message.endsWith(message), 'the message keeps the cause');
  return error;
}

function compareText(a: string, b: string): number {
  invariant(typeof a === 'string', 'compares text');
  invariant(typeof b === 'string', 'compares text');
  return a < b ? -1 : a > b ? 1 : 0;
}
