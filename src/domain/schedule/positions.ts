import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { ServiceDay } from '../gtfs/service-day';
import type { Mode } from '../network/stations';

/**
 * Plan §4 "On-device engine — Scheduled positions" (M3.5): where each vehicle is, by the timetable,
 * at one instant. Pure: the schedule repo fetches the trips around the instant and the shapes; this
 * module places the vehicles.
 *
 *  - A trip's distance along its shape is interpolated in TIME between consecutive stops (each
 *    stop's distance is its `pattern_stop.dist_m`); between a stop's arrival and departure the
 *    vehicle stands at that stop.
 *  - The distance becomes a coordinate by binary search on the shape's cumulative distances
 *    (`shape_point.dist_m`), then linear interpolation within that one segment.
 *  - A vehicle is a BLOCK: one vehicle runs a block's trips in turn. Its key is `date:block_id`,
 *    so a marker keeps its identity across the block's joins (the Inner Loop's half-trips) and
 *    does not flicker.
 *  - Between two trips of a block, a gap of at most MAX_LAYOVER_S parks the vehicle at the next
 *    trip's first stop. A longer gap, or no earlier trip, shows no vehicle until the trip starts.
 */

/** A block gap at most this long is a layover at the next trip's first stop (plan §4: ≤ 10 min). */
export const MAX_LAYOVER_S = 600;

/** One stop of a trip: arrival and departure in service-day seconds, and metres along the trip's shape. */
export type TripStop = { readonly arrS: number; readonly depS: number; readonly distM: number };

export type ScheduledTrip = {
  readonly tripIdx: number;
  readonly tripId: string;
  /** The vehicle's block; '' when the feed names none (the trip is then a vehicle on its own). */
  readonly blockId: string;
  readonly lineId: string;
  readonly mode: Mode;
  readonly directionId: number;
  readonly shapeIdx: number;
  /** The stops in trip order: times never decrease, distances never decrease. */
  readonly stops: readonly TripStop[];
};

/** The trips fetched for one running service day. */
export type ServiceDayTrips = { readonly day: ServiceDay; readonly trips: readonly ScheduledTrip[] };

/** A shape as the DB stores it: points with their cumulative distance (distM[0] = 0, never decreasing). */
export type ShapePath = { readonly points: readonly LatLon[]; readonly distM: readonly number[] };

/** Moving between stops, standing at a stop during its trip, or parked before its next trip. */
export type VehicleState = 'moving' | 'at-stop' | 'layover';

export type ScheduledVehicle = {
  /** `date:block_id` — stable for as long as the vehicle runs its block. */
  readonly vehicleKey: string;
  /** The service day (YYYYMMDD) whose block this is: the day BEFORE the clock date for a 24:xx trip. */
  readonly serviceDate: number;
  readonly state: VehicleState;
  /** The trip the vehicle is running — in a layover, the trip it runs next. */
  readonly tripIdx: number;
  readonly tripId: string;
  readonly lineId: string;
  readonly mode: Mode;
  readonly directionId: number;
  readonly shapeIdx: number;
  /** Metres along the trip's shape. */
  readonly distM: number;
  readonly position: LatLon;
};

/** Where a trip's vehicle is at a service-day second: metres along its shape, moving or at a stop. */
export type TripProgress = { readonly distM: number; readonly state: 'moving' | 'at-stop' };

/** Shape distances may overshoot an end by float noise; anything farther is a broken contract. */
const SHAPE_END_TOLERANCE_M = 0.01;

/**
 * The trip's progress at service-day second `s`, or null outside [first arrival, last departure].
 * Inside it, the last stop arrived at by `s` is found by binary search: still there (s ≤ its
 * departure) means at-stop, otherwise the vehicle is between it and the next stop, in time proportion.
 */
export function tripProgressAt(trip: ScheduledTrip, s: number): TripProgress | null {
  invariant(trip.stops.length >= 2, `trip ${trip.tripId} has at least two stops`);
  invariant(Number.isFinite(s), 'a service-day second is a number');
  if (s < at(trip.stops, 0).arrS || s > at(trip.stops, trip.stops.length - 1).depS) {
    return null;
  }
  const i = lastIndexAtOrBefore(trip.stops, (stop) => stop.arrS, s);
  const stop = at(trip.stops, i);
  if (s <= stop.depS) {
    return { distM: stop.distM, state: 'at-stop' };
  }
  // s lies after this stop's departure and before the next arrival (else the search had found that stop).
  const next = at(trip.stops, i + 1);
  const fraction = (s - stop.depS) / (next.arrS - stop.depS);
  invariant(fraction > 0 && fraction < 1, `trip ${trip.tripId} is strictly between stops ${i} and ${i + 1}`);
  return { distM: stop.distM + fraction * (next.distM - stop.distM), state: 'moving' };
}

/** The coordinate `distM` metres along the shape: binary search for its segment, then linear interpolation. */
export function pointAlongShape(shape: ShapePath, distM: number): LatLon {
  const n = shape.points.length;
  invariant(n >= 2 && shape.distM.length === n && at(shape.distM, 0) === 0, 'a shape path has >= 2 points, each with its distance, from 0');
  const lengthM = at(shape.distM, n - 1);
  invariant(
    distM >= -SHAPE_END_TOLERANCE_M && distM <= lengthM + SHAPE_END_TOLERANCE_M,
    `${distM} m lies on the shape (0..${lengthM} m)`,
  );
  const d = Math.min(lengthM, Math.max(0, distM));
  const k = Math.min(lastIndexAtOrBefore(shape.distM, (m) => m, d), n - 2);
  const [from, to] = [at(shape.points, k), at(shape.points, k + 1)];
  const legM = at(shape.distM, k + 1) - at(shape.distM, k);
  const t = legM > 0 ? (d - at(shape.distM, k)) / legM : 0;
  const point = { latitude: from.latitude + t * (to.latitude - from.latitude), longitude: from.longitude + t * (to.longitude - from.longitude) };
  invariant(t >= 0 && t <= 1 && isLatLon(point), 'the point lies on segment k of the shape');
  return point;
}

/**
 * Every scheduled vehicle at `epoch`, one per block per running service day, sorted by key.
 * `days` must hold, for each running service day, every trip that runs within MAX_LAYOVER_S of the
 * instant (start ≤ s + 600 and end ≥ s − 600): a layover needs both trips either side of its gap.
 */
export function scheduledVehicles(
  epoch: number,
  days: readonly ServiceDayTrips[],
  shapes: ReadonlyMap<number, ShapePath>,
): ScheduledVehicle[] {
  invariant(Number.isSafeInteger(epoch), `an instant is a whole epoch second, got ${epoch}`);
  invariant(days.every((d, i) => i === 0 || at(days, i - 1).day.date < d.day.date), 'service days come in date order, each once');
  const vehicles: ScheduledVehicle[] = [];
  for (const { day, trips } of days) {
    const s = epoch - day.baseEpoch;
    for (const [groupKey, blockTrips] of groupByVehicle(trips)) {
      const placed = blockPlacementAt(blockTrips, s);
      if (placed !== null) {
        vehicles.push(toVehicle(`${day.date}:${groupKey}`, day.date, placed, shapes));
      }
    }
  }
  vehicles.sort((a, b) => (a.vehicleKey < b.vehicleKey ? -1 : a.vehicleKey > b.vehicleKey ? 1 : 0));
  invariant(vehicles.every((v, i) => i === 0 || at(vehicles, i - 1).vehicleKey < v.vehicleKey), 'one vehicle per key');
  return vehicles;
}

export type BlockPlacement = { readonly trip: ScheduledTrip; readonly distM: number; readonly state: VehicleState };

/**
 * The block's vehicle at second `s` (its trips in start order). A trip running at `s` places it —
 * at a join, where one trip ends as the next starts, the later trip wins. Otherwise a gap of at most
 * MAX_LAYOVER_S between the trips either side of `s` parks it at the next trip's first stop.
 */
export function blockPlacementAt(trips: readonly ScheduledTrip[], s: number): BlockPlacement | null {
  invariant(trips.length > 0, 'a block has at least one trip');
  invariant(trips.every((t, i) => i === 0 || startS(at(trips, i - 1)) <= startS(t)), 'block trips come in start order');
  let running: BlockPlacement | null = null;
  for (const trip of trips) {
    const progress = tripProgressAt(trip, s);
    if (progress !== null) {
      running = { trip, distM: progress.distM, state: progress.state };
    }
  }
  if (running !== null) {
    return running;
  }
  const next = trips.findIndex((trip) => startS(trip) > s);
  if (next <= 0) {
    return null; // before the block's first trip (0) or after its last (-1)
  }
  const [before, after] = [at(trips, next - 1), at(trips, next)];
  return startS(after) - endS(before) <= MAX_LAYOVER_S ? { trip: after, distM: at(after.stops, 0).distM, state: 'layover' } : null;
}

/** Trips grouped into vehicles: by block, in start order; a block-less trip is a vehicle of its own. */
function groupByVehicle(trips: readonly ScheduledTrip[]): Map<string, ScheduledTrip[]> {
  invariant(new Set(trips.map((t) => t.tripIdx)).size === trips.length, 'each trip is listed once');
  const groups = new Map<string, ScheduledTrip[]>();
  for (const trip of trips) {
    const key = trip.blockId !== '' ? trip.blockId : `trip:${trip.tripId}`;
    const members = groups.get(key);
    if (members === undefined) {
      groups.set(key, [trip]);
    } else {
      members.push(trip);
    }
  }
  for (const members of groups.values()) {
    members.sort((a, b) => startS(a) - startS(b) || a.tripIdx - b.tripIdx);
  }
  invariant([...groups.values()].reduce((n, members) => n + members.length, 0) === trips.length, 'every trip is in one group');
  return groups;
}

function toVehicle(vehicleKey: string, serviceDate: number, placed: BlockPlacement, shapes: ReadonlyMap<number, ShapePath>): ScheduledVehicle {
  const shape = shapes.get(placed.trip.shapeIdx);
  invariant(shape !== undefined, `trip ${placed.trip.tripId} runs on shape ${placed.trip.shapeIdx}, which the shapes include`);
  const { tripIdx, tripId, lineId, mode, directionId, shapeIdx } = placed.trip;
  const vehicle = { vehicleKey, serviceDate, state: placed.state, tripIdx, tripId, lineId, mode, directionId, shapeIdx, distM: placed.distM };
  invariant(vehicleKey.startsWith(`${serviceDate}:`), 'the key starts with its service date');
  return { ...vehicle, position: pointAlongShape(shape, placed.distM) };
}

function startS(trip: ScheduledTrip): number {
  invariant(trip.stops.length >= 2, `trip ${trip.tripId} has at least two stops`);
  const first = at(trip.stops, 0);
  invariant(first.arrS <= first.depS, `trip ${trip.tripId} departs its first stop no earlier than it arrives`);
  return first.arrS;
}

function endS(trip: ScheduledTrip): number {
  invariant(trip.stops.length >= 2, `trip ${trip.tripId} has at least two stops`);
  const last = at(trip.stops, trip.stops.length - 1);
  invariant(last.arrS <= last.depS, `trip ${trip.tripId} leaves its last stop no earlier than it arrives`);
  return last.depS;
}

/**
 * The index of the last item whose key is ≤ x, in a list sorted by key (binary search, bounded by
 * log2 of the length), or -1 when x precedes every key.
 */
function lastIndexAtOrBefore<T>(items: readonly T[], key: (item: T) => number, x: number): number {
  invariant(items.length > 0, 'a search needs a non-empty list');
  invariant(Number.isFinite(x), 'a search needs a finite target');
  let [lo, hi, found] = [0, items.length - 1, -1];
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (key(at(items, mid)) <= x) {
      [found, lo] = [mid, mid + 1];
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Indexed read that fails loudly instead of yielding undefined. */
function at<T>(list: readonly T[], index: number): T {
  invariant(Number.isInteger(index) && index >= 0 && index < list.length, `index ${index} is inside a list of ${list.length}`);
  const value = list[index];
  invariant(value !== undefined, `item ${index} is present`);
  return value;
}
