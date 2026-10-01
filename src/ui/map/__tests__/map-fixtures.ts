import type { ServiceDay } from '@/domain/gtfs/service-day';
import type { LiveBatch, LiveVehicle, ProviderId } from '@/domain/live/types';
import type { ScheduledTrip, ShapePath, TripStop } from '@/domain/schedule/positions';
import { buildShapeGeometry } from '@/domain/schedule/shape-geometry';
import type { LatLon } from '@/lib/geo';

import type { VehicleFrame } from '../vehicleFrames';

/**
 * Shared by the M5.9–M5.12 map tests: vehicle frames, a straight synthetic track with a timetable on
 * it, and live batches. Every coordinate is synthetic (the public-repo data rule): a 2 km line east
 * along 25.77° N through downtown Miami, inside the merge's Miami bounding box.
 */

/** Wednesday 2026-09-30, its service day starting at local midnight. */
export const WED: ServiceDay = { date: 20260930, baseEpoch: 1_790_740_800 };
/** 08:00 Wednesday as an epoch second. */
export const WED_0800 = WED.baseEpoch + 28_800;

/** A frame for one vehicle, scheduled unless a live provider and age are given. */
export function frame(overrides: Partial<VehicleFrame> = {}): VehicleFrame {
  const made: VehicleFrame = {
    key: '20260930:block-1',
    source: 'scheduled',
    mode: 'rail',
    lineId: 'ORANGE',
    coordinate: { latitude: 25.7743, longitude: -80.1955 },
    bearing: 180,
    live: null,
    ...overrides,
  };
  expect(made.key.length).toBeGreaterThan(0);
  expect((made.source === 'live') === (made.live !== null)).toBe(true);
  return made;
}

/** A live frame from `provider`, `ageS` seconds old. */
export function liveFrame(provider: ProviderId, ageS: number): VehicleFrame {
  const made = frame({ key: `live:${provider}-${ageS}`, source: 'live', live: { provider, ageS } });
  expect(made.live?.ageS).toBe(ageS);
  expect(made.live?.provider).toBe(provider);
  return made;
}

/** The track: due east along 25.77° N, about 2 km, one point every 0.004° of longitude (~400 m). */
export const TRACK_POINTS: readonly LatLon[] = [0, 1, 2, 3, 4, 5].map((i) => ({ latitude: 25.77, longitude: -80.21 + i * 0.004 }));

/** The track as a shape path, with the M2.11 cumulative haversine distances the DB stores. */
export function trackShape(): ShapePath {
  const shape = trackShapeOf(TRACK_POINTS);
  expect(shape.points).toHaveLength(TRACK_POINTS.length);
  expect(shape.distM[0]).toBe(0);
  return shape;
}

/** Any polyline as a shape path, measured the M2.11 way. */
export function trackShapeOf(points: readonly LatLon[]): ShapePath {
  const built = buildShapeGeometry(points);
  expect(built.ok).toBe(true);
  const geometry = built.ok ? built.value : null;
  expect(geometry?.points).toHaveLength(points.length);
  return { points: geometry?.points ?? [], distM: geometry?.cumulativeM ?? [] };
}

/** A trip on shape 0, stopping at each [arrS, depS, distM] (service-day seconds, metres along the track). */
export function trackTrip(stops: readonly (readonly [number, number, number])[], tripId = 'syn-trip-1', blockId = 'block-1'): ScheduledTrip {
  expect(stops.length).toBeGreaterThanOrEqual(2);
  const trip: ScheduledTrip = {
    tripIdx: 1,
    tripId,
    blockId,
    lineId: 'ORANGE',
    mode: 'rail',
    directionId: 0,
    shapeIdx: 0,
    stops: stops.map(([arrS, depS, distM]): TripStop => ({ arrS, depS, distM })),
  };
  expect(trip.stops.every((stop, i) => i === 0 || stop.arrS >= (trip.stops[i - 1]?.depS ?? 0))).toBe(true);
  return trip;
}

/** Three stops 1000 m apart from 08:00: dwell 30 s at the first, 30 s at the second, 30 s at the last. */
export const THREE_STOPS: readonly (readonly [number, number, number])[] = [
  [28_800, 28_830, 0],
  [28_920, 28_950, 1000],
  [29_040, 29_070, 2000],
];

/** A live vehicle (synthetic) at `position`, measured at `timestamp`, running `tripId`. */
export function liveVehicle(position: LatLon, timestamp: number, tripId: string | null = 'syn-trip-1'): LiveVehicle {
  const vehicle: LiveVehicle = {
    vehicleId: 'syn-vehicle-1',
    label: null,
    tripId,
    routeId: '31009',
    mode: 'rail',
    lineId: 'ORANGE',
    lineSource: 'trip',
    directionId: 0,
    position,
    bearing: 90,
    speedMps: null,
    stopId: null,
    stopStatus: null,
    timestamp,
  };
  expect(vehicle.position).toBe(position);
  expect(Number.isSafeInteger(vehicle.timestamp)).toBe(true);
  return vehicle;
}

/** A batch from `provider` holding `vehicles`, fetched at `fetchedAt`. */
export function liveBatch(provider: ProviderId, vehicles: readonly LiveVehicle[], fetchedAt: number): LiveBatch<LiveVehicle> {
  const batch: LiveBatch<LiveVehicle> = { provider, items: vehicles, feedTimestamp: fetchedAt, dropped: {}, fetchedAt, bytes: 1024 };
  expect(batch.items).toHaveLength(vehicles.length);
  expect(batch.provider).toBe(provider);
  return batch;
}
