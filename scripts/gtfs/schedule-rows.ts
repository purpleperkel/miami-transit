import { LINE_CATALOG, type LineDef } from '../../src/domain/lines/line-catalog';
import type { Station } from '../../src/domain/network/stations';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { groupStopTimes, type NetworkModel, type NetworkPattern, type NetworkShape, type NetworkTrip } from './build-network';
import type { ServiceCalendar, ServiceDay } from './calendar';
import { BUILDER_VERSION } from './idempotency';
import type { LoadedFeed, Stop } from './load-feed';
import { MODE_CODES, SCHEMA_VERSION, type Row, type ScheduleRows } from './schema';

/**
 * Plan §4 steps 7–12 → step 13 (M2.15): the network model, the expanded calendar and the feed's
 * stop details turned into the rows of every schedule-DB table (schema.ts).
 *
 * Every index is a dense 0-based position in a FIXED order — stations by key, stops by stop_id,
 * shapes by shape_id, services by service_id, patterns and trips in build-network's order — and
 * every list is emitted in that order, so the same zip always yields the same rows (and, written
 * the same way, the same bytes). Nothing here reads a clock.
 */

export type RowsInput = {
  readonly feed: LoadedFeed;
  readonly network: NetworkModel;
  readonly calendar: ServiceCalendar;
  /** SHA-256 of the zip the rows come from; stored as meta.feed_sha256. */
  readonly feedSha256: string;
};

export type RowsError = { readonly kind: 'rows'; readonly message: string };

type Indexes = {
  readonly station: ReadonlyMap<string, number>;
  readonly stop: ReadonlyMap<string, number>;
  readonly shape: ReadonlyMap<string, number>;
  readonly service: ReadonlyMap<string, number>;
};

const SECONDS_PER_DAY = 86_400;
const HALF_DAY_SECONDS = SECONDS_PER_DAY / 2;

export function buildScheduleRows(input: RowsInput): Result<ScheduleRows, RowsError> {
  invariant(/^[0-9a-f]{64}$/.test(input.feedSha256), 'the feed hash is a SHA-256 hex digest');
  invariant(input.network.trips.length === input.feed.trips.length, 'the network covers every loaded trip');
  const indexes = buildIndexes(input);
  const directions = patternDirections(input.network);
  if (!directions.ok) {
    return directions;
  }
  const lineShapes = lineShapeRows(input.network, directions.value, indexes);
  if (!lineShapes.ok) {
    return lineShapes;
  }
  const { network, calendar } = input;
  const rows: ScheduleRows = {
    meta: metaRows(input),
    line: LINE_CATALOG.map((line, sort) => ({ line_id: line.id, mode: MODE_CODES[line.mode], name: line.name, sort })),
    station: stationRows(network),
    stop: stopRows(input, indexes),
    shape: shapeRows(network),
    shape_point: shapePointRows(network),
    line_shape: lineShapes.value,
    pattern: network.patterns.map((pattern) => patternRow(pattern, directions.value, indexes)),
    pattern_stop: network.patterns.flatMap((pattern) => patternStopRows(pattern, indexes)),
    service: calendar.serviceIds.map((serviceId, i) => ({ service_idx: i, service_id: serviceId })),
    service_day: calendar.days.map((day) => ({ date: day.date, base_epoch: day.baseEpoch, noon_utc_offset_s: noonUtcOffsetSeconds(day) })),
    service_day_active: serviceDayActiveRows(calendar, indexes),
    trip: tripRows(network, indexes),
    stop_time: stopTimeRows(input, indexes),
    transfer: transferRows(network, indexes),
  };
  invariant(rows.trip.length === input.network.trips.length && rows.pattern.length === input.network.patterns.length, 'one row per trip and per pattern');
  return ok(rows);
}

/** Each id's position in a fixed order: stations by key, stops by stop_id, shapes by shape_id, services by id. */
function buildIndexes({ feed, network, calendar }: RowsInput): Indexes {
  invariant(network.stations.every((s, i) => i === 0 || (network.stations[i - 1]?.key ?? '') < s.key), 'stations arrive sorted by key');
  const indexes = {
    station: positions(network.stations.map((station) => station.key)),
    stop: positions(feed.stops.map((stop) => stop.stop_id).sort()),
    shape: positions(network.shapes.map((shape) => shape.shapeId)),
    service: positions(calendar.serviceIds),
  };
  invariant(network.trips.every((trip) => indexes.service.has(trip.serviceId)), 'every trip runs on a calendar service');
  return indexes;
}

function positions(keys: readonly string[]): Map<string, number> {
  const map = new Map(keys.map((key, i) => [key, i]));
  invariant(map.size === keys.length, 'index keys are unique');
  invariant(keys.every((key) => key.length > 0), 'index keys are never empty');
  return map;
}

function lookup(index: ReadonlyMap<string, number>, key: string, what: string): number {
  const idx = index.get(key);
  invariant(idx !== undefined, `${what} ${key} has an index`);
  invariant(Number.isInteger(idx) && idx >= 0, 'indices are dense and 0-based');
  return idx;
}

/** meta: the facts a reader needs to trust the file — schema, builder, source zip, time zone. Sorted by key. */
function metaRows({ feed, feedSha256 }: RowsInput): Row<'meta'>[] {
  invariant(feed.timeZone.length > 0, 'the feed names its time zone');
  const rows = [
    { key: 'builder_version', value: String(BUILDER_VERSION) },
    { key: 'feed_sha256', value: feedSha256 },
    { key: 'schema_version', value: String(SCHEMA_VERSION) },
    { key: 'time_zone', value: feed.timeZone },
  ];
  invariant(rows.every((row, i) => i === 0 || (rows[i - 1]?.key ?? '') < row.key), 'meta keys are sorted');
  return rows;
}

function stationRows(network: NetworkModel): Row<'station'>[] {
  invariant(network.stations.length > 0, 'the network has stations');
  const rows = network.stations.map((station, i) => stationRow(station, i));
  invariant(rows.every((row, i) => row.station_idx === i), 'station rows sit at their index');
  return rows;
}

function stationRow(station: Station, idx: number): Row<'station'> {
  invariant(Number.isFinite(station.latitude) && Number.isFinite(station.longitude), `${station.key} is located`);
  invariant(idx >= 0, 'indices are 0-based');
  return { station_idx: idx, station_key: station.key, mode: MODE_CODES[station.mode], name: station.name, lat: station.latitude, lon: station.longitude };
}

const BOUND_SUFFIX = /\b(NORTH|SOUTH|EAST|WEST)BOUND\s*$/i;

/** The platform's direction from its feed name ("… RAIL SOUTHBOUND" → "S"), or null when it names none. */
export function boundOf(stopName: string): string | null {
  invariant(typeof stopName === 'string', 'a stop name is text');
  const word = BOUND_SUFFIX.exec(stopName)?.[1];
  const bound = word === undefined ? null : word.charAt(0).toUpperCase();
  invariant(bound === null || /^[NSEW]$/.test(bound), 'a bound is one compass letter');
  return bound;
}

function stopRows({ feed, network }: RowsInput, indexes: Indexes): Row<'stop'>[] {
  invariant(feed.stops.length === indexes.stop.size, 'every loaded stop is indexed');
  const sorted = [...feed.stops].sort((a, b) => lookup(indexes.stop, a.stop_id, 'stop') - lookup(indexes.stop, b.stop_id, 'stop'));
  const rows = sorted.map((stop, i) => stopRow(stop, i, lookup(indexes.station, network.stationOfStop.get(stop.stop_id) ?? '', 'station')));
  invariant(rows.every((row) => indexes.stop.get(row.stop_id) === row.stop_idx), 'stop rows sit at their index');
  return rows;
}

/** Shapes as DRAWN: length includes the M2.11 terminal extensions, each end's recorded in its own column. */
function shapeRows(network: NetworkModel): Row<'shape'>[] {
  invariant(network.shapes.every((shape, i) => i === 0 || (network.shapes[i - 1]?.shapeId ?? '') < shape.shapeId), 'shapes arrive sorted by id');
  const rows = network.shapes.map((shape, i) => shapeRow(shape, i));
  invariant(rows.every((row, i) => row.shape_idx === i), 'shape rows sit at their index');
  return rows;
}

function shapeRow({ shapeId, geometry }: NetworkShape, idx: number): Row<'shape'> {
  const { lengthM, extendedStartM, extendedEndM } = geometry;
  invariant(extendedStartM >= 0 && extendedEndM >= 0, `shape ${shapeId}: each end's extension is a length`);
  invariant(extendedStartM + extendedEndM < lengthM, `shape ${shapeId}: the extensions are parts of the drawn shape`);
  return { shape_idx: idx, shape_id: shapeId, length_m: lengthM, extended_start_m: extendedStartM, extended_end_m: extendedEndM };
}

function stopRow(stop: Stop, idx: number, stationIdx: number): Row<'stop'> {
  invariant(idx >= 0 && stationIdx >= 0, 'a stop row has its indices');
  invariant(Number.isFinite(stop.stop_lat) && Number.isFinite(stop.stop_lon), `stop ${stop.stop_id} is located`);
  return { stop_idx: idx, stop_id: stop.stop_id, station_idx: stationIdx, code: stop.stop_code, bound: boundOf(stop.stop_name), lat: stop.stop_lat, lon: stop.stop_lon };
}

function shapePointRows(network: NetworkModel): Row<'shape_point'>[] {
  invariant(network.shapes.length > 0, 'the network has shapes');
  const rows = network.shapes.flatMap(({ geometry }, shapeIdx) =>
    geometry.points.map((point, seq) => ({ shape_idx: shapeIdx, seq, lat: point.latitude, lon: point.longitude, dist_m: geometry.cumulativeM[seq] ?? NaN })),
  );
  invariant(rows.every((row) => Number.isFinite(row.dist_m)), 'every shape point has its distance');
  return rows;
}

/** Each pattern's direction_id, from its trips; trips of one pattern disagreeing is a build error. */
function patternDirections(network: NetworkModel): Result<number[], RowsError> {
  invariant(network.patterns.every((pattern, i) => pattern.idx === i), 'patterns sit at their index');
  const directions = network.patterns.map(() => -1);
  for (const trip of network.trips) {
    const seen = directions[trip.patternIdx];
    if (seen !== -1 && seen !== trip.directionId) {
      return err({ kind: 'rows', message: `pattern ${trip.patternIdx} runs in direction ${seen} and ${trip.directionId} (trip ${trip.tripId})` });
    }
    directions[trip.patternIdx] = trip.directionId;
  }
  invariant(directions.every((direction) => direction === 0 || direction === 1), 'every pattern has trips and a direction');
  return ok(directions);
}

function patternRow(pattern: NetworkPattern, directions: readonly number[], indexes: Indexes): Row<'pattern'> {
  const destination = pattern.stationKeys[pattern.stationKeys.length - 1];
  invariant(destination !== undefined && pattern.stopIds.length >= 2, `pattern ${pattern.idx} has stops and a last station`);
  const row = {
    pattern_idx: pattern.idx,
    route_id: pattern.routeId,
    line_id: pattern.lineId,
    variant: pattern.variant,
    direction_id: directions[pattern.idx] ?? -1,
    shape_idx: lookup(indexes.shape, pattern.shapeId, 'shape'),
    dest_station_idx: lookup(indexes.station, destination, 'station'),
    stop_count: pattern.stopIds.length,
  };
  invariant(row.direction_id === 0 || row.direction_id === 1, 'a pattern runs in direction 0 or 1');
  return row;
}

function patternStopRows(pattern: NetworkPattern, indexes: Indexes): Row<'pattern_stop'>[] {
  invariant(pattern.distancesM.length === pattern.stopIds.length, `pattern ${pattern.idx} has a distance per stop`);
  const rows = pattern.stopIds.map((stopId, seq) => ({ pattern_idx: pattern.idx, seq, stop_idx: lookup(indexes.stop, stopId, 'stop'), dist_m: pattern.distancesM[seq] ?? NaN }));
  invariant(rows.every((row) => Number.isFinite(row.dist_m)), 'every pattern stop has its distance');
  return rows;
}

/**
 * line_shape (plan §4 DDL): a rail line is drawn with its LONGEST direction-0 shape; a Mover line
 * with every shape its patterns run on. A rail line with no direction-0 pattern is a build error.
 */
function lineShapeRows(network: NetworkModel, directions: readonly number[], indexes: Indexes): Result<Row<'line_shape'>[], RowsError> {
  invariant(directions.length === network.patterns.length, 'every pattern has a direction');
  const rows: Row<'line_shape'>[] = [];
  for (const line of LINE_CATALOG) {
    const shapes = lineShapeIndices(line, network, directions, indexes);
    if (shapes.length === 0) {
      return err({ kind: 'rows', message: `line ${line.id} has no ${line.mode === 'rail' ? 'direction-0 ' : ''}pattern to draw it with` });
    }
    rows.push(...shapes.map((shapeIdx) => ({ line_id: line.id, shape_idx: shapeIdx })));
  }
  invariant(rows.length >= LINE_CATALOG.length, 'every line is drawn');
  return ok(rows);
}

function lineShapeIndices(line: LineDef, network: NetworkModel, directions: readonly number[], indexes: Indexes): number[] {
  const patterns = network.patterns.filter((p) => p.lineId === line.id && (line.mode === 'mover' || directions[p.idx] === 0));
  const shapeIdx = [...new Set(patterns.map((p) => lookup(indexes.shape, p.shapeId, 'shape')))].sort((a, b) => a - b);
  invariant(shapeIdx.every((idx) => network.shapes[idx] !== undefined), 'line shapes exist');
  if (line.mode === 'mover' || shapeIdx.length === 0) {
    return shapeIdx;
  }
  const lengths = shapeIdx.map((idx) => network.shapes[idx]?.geometry.lengthM ?? 0);
  // The longest; on a tie the first by shape_id (shapeIdx is sorted), so the choice is stable.
  const longest = shapeIdx[lengths.indexOf(Math.max(...lengths))] ?? -1;
  invariant(shapeIdx.includes(longest), 'the drawn shape is one of the line’s');
  return [longest];
}

function serviceDayActiveRows(calendar: ServiceCalendar, indexes: Indexes): Row<'service_day_active'>[] {
  invariant(calendar.days.length > 0, 'the calendar has service days');
  const rows = calendar.days.flatMap((day) => day.serviceIds.map((id) => ({ date: day.date, service_idx: lookup(indexes.service, id, 'service') })));
  invariant(rows.length > 0, 'some service runs on some day');
  return rows;
}

function transferRows(network: NetworkModel, indexes: Indexes): Row<'transfer'>[] {
  invariant(network.transfers.length >= network.stations.length, 'every station at least transfers to itself');
  const rows = network.transfers.map((transfer) => ({
    from_station_idx: lookup(indexes.station, transfer.fromKey, 'station'),
    to_station_idx: lookup(indexes.station, transfer.toKey, 'station'),
    walk_s: transfer.seconds,
  }));
  invariant(rows.every((row) => row.walk_s > 0), 'every transfer takes time');
  return rows;
}

function tripRows(network: NetworkModel, indexes: Indexes): Row<'trip'>[] {
  invariant(network.trips.every((trip, i) => trip.idx === i), 'trips sit at their index');
  const rows = network.trips.map((trip) => tripRow(trip, lookup(indexes.service, trip.serviceId, 'service')));
  invariant(rows.every((row) => row.start_s <= row.end_s), 'every trip ends no earlier than it starts');
  return rows;
}

function tripRow(trip: NetworkTrip, serviceIdx: number): Row<'trip'> {
  invariant(serviceIdx >= 0 && trip.idx >= 0, 'a trip row has its indices');
  invariant(trip.nextTripIdx === null || trip.nextTripIdx !== trip.idx, 'a trip never continues as itself');
  return {
    trip_idx: trip.idx,
    trip_id: trip.tripId,
    service_idx: serviceIdx,
    pattern_idx: trip.patternIdx,
    block_id: trip.blockId,
    start_s: trip.startS,
    end_s: trip.endS,
    note: trip.note,
    next_trip_idx: trip.nextTripIdx,
  };
}

/** Every trip's stop times in stop_sequence order, numbered 0.. like its pattern's stops. */
function stopTimeRows({ feed, network }: RowsInput, indexes: Indexes): Row<'stop_time'>[] {
  const grouped = groupStopTimes(feed);
  invariant(grouped.ok, `the network was built from these stop times, so they group: ${grouped.ok ? '' : grouped.error.message}`);
  const rows: Row<'stop_time'>[] = [];
  for (const trip of network.trips) {
    const times = grouped.value.get(trip.tripId) ?? [];
    const pattern = network.patterns[trip.patternIdx];
    invariant(pattern !== undefined && times.map((t) => t.stop_id).join(',') === pattern.stopIds.join(','), `trip ${trip.tripId} visits its pattern's stops`);
    times.forEach((t, seq) => rows.push({ trip_idx: trip.idx, seq, stop_idx: lookup(indexes.stop, t.stop_id, 'stop'), arr_s: t.arrival_time, dep_s: t.departure_time }));
  }
  return rows;
}

/** The UTC offset (seconds) at local noon of a service day — what `base_epoch` was computed against. */
export function noonUtcOffsetSeconds(day: ServiceDay): number {
  const [year, month, dayOfMonth] = [Math.floor(day.date / 10000), Math.floor(day.date / 100) % 100, day.date % 100];
  invariant(month >= 1 && month <= 12 && dayOfMonth >= 1 && dayOfMonth <= 31, `${day.date} is a YYYYMMDD date`);
  const offset = Date.UTC(year, month - 1, dayOfMonth, 12) / 1000 - (day.baseEpoch + HALF_DAY_SECONDS);
  invariant(Number.isInteger(offset) && Math.abs(offset) <= 14 * 3600 && offset % 60 === 0, `${day.date}: a whole-minute offset within ±14 h`);
  return offset;
}
