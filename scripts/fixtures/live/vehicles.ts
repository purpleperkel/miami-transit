import { transit_realtime } from 'gtfs-realtime-bindings';

import type { ScheduleRepo } from '../../../src/data/schedule-repo';
import type { SqlExecutor } from '../../../src/data/sql-executor';
import { decodeFeedMessage } from '../../../src/domain/gtfsrt/decode-feed';
import type { LineId } from '../../../src/domain/lines/line-catalog';
import type { ScheduledVehicle } from '../../../src/domain/schedule/positions';
import { invariant } from '../../../src/lib/invariant';
import { oracleDisagreement } from '../../live/probe-transitland';
import { clockOf } from './clock';
import { bearingAlong, metresToPolyline } from './geometry';
import type { SeededRandom } from './prng';
import { type FixtureDay, type PatternStop, patternStops, shapePoints, stopCoordinates, tripFacts } from './schedule-facts';

/**
 * The synthetic whole-agency VehiclePositions feed (plan M8.3), in the field structure of the real
 * Miami-Dade feed as Transitland serves it: header (version, FULL_DATASET, timestamp); per vehicle an
 * id, a vehicle descriptor (id = label = the entity id), a position, a timestamp and — when on a
 * trip — the trip descriptor (trip_id, start time and date, SCHEDULED, route, direction), the stop it
 * is at or heading to, its stop sequence and status.
 *
 *  - Rail and Mover: EVERY vehicle the timetable runs at the fixture instant (ScheduleRepo.vehiclesAt),
 *    each seen a few seconds before the header, at its scheduled place ON its trip's shape — a real
 *    trip_id, a real shape, a synthetic moment.
 *  - Buses (out of scope): synthetic route, trip and stop ids (never schedule.db's), placed near the
 *    rail and Mover stops; and some vehicles on no trip at all, as the real feed has.
 * Every entity id is "syn-…", so nothing here can be mistaken for a captured vehicle.
 */

export type VehicleContext = {
  readonly db: SqlExecutor;
  readonly repo: ScheduleRepo;
  readonly rng: SeededRandom;
  readonly day: FixtureDay;
  /** The header timestamp: the fixture instant. */
  readonly feedEpoch: number;
};

export type VehicleFeed = {
  readonly bytes: Uint8Array;
  /** trip_id → line of every in-scope vehicle's trip (schedule.db), sorted by trip_id. */
  readonly tripLines: readonly (readonly [string, LineId])[];
  readonly counts: { readonly rail: number; readonly mover: number; readonly bus: number; readonly idle: number };
};

/** Out-of-scope vehicles: buses on synthetic trips, and vehicles on no trip. */
export const BUS_VEHICLES = 45;
export const IDLE_VEHICLES = 12;
/** Synthetic positions must sit ON the trip's shape: float32 rounding moves them well under this. */
const ON_SHAPE_TOLERANCE_M = 0.9;
/** A moving vehicle this close to its next stop reports INCOMING_AT it. */
const INCOMING_WITHIN_M = 150;

const { IN_TRANSIT_TO, STOPPED_AT, INCOMING_AT } = transit_realtime.VehiclePosition.VehicleStopStatus;
const { SCHEDULED } = transit_realtime.TripDescriptor.ScheduleRelationship;
const { FULL_DATASET } = transit_realtime.FeedHeader.Incrementality;

export function buildVehicleFeed(ctx: VehicleContext): VehicleFeed {
  const scheduled = scheduledAt(ctx, ctx.feedEpoch);
  invariant(scheduled.length > 0, 'the timetable runs vehicles at the fixture instant');
  const ids = fleetIds(ctx.rng, scheduled.length + BUS_VEHICLES + IDLE_VEHICLES);
  const railMover = scheduled.map((vehicle, i) => railMoverVehicle(ctx, vehicle, ids[i] as string));
  const anchors = stopCoordinates(ctx.db);
  const buses = Array.from({ length: BUS_VEHICLES }, (_, k) => busEntity(ctx, ids[scheduled.length + k] as string, k, anchors));
  const idle = Array.from({ length: IDLE_VEHICLES }, (_, k) => idleEntity(ctx, ids[scheduled.length + BUS_VEHICLES + k] as string, anchors));
  const bytes = encodeFeed(ctx.feedEpoch, ctx.rng.shuffle([...railMover.map((v) => v.entity), ...buses, ...idle]));
  const tripLines = new Map(railMover.map((v) => [v.tripId, v.lineId] as const));
  const rail = scheduled.filter((v) => v.mode === 'rail').length;
  invariant(rail > 0 && rail < scheduled.length, 'the instant has both rail and Mover vehicles');
  return {
    bytes,
    tripLines: [...tripLines].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    counts: { rail, mover: scheduled.length - rail, bus: BUS_VEHICLES, idle: IDLE_VEHICLES },
  };
}

/** The timetable's vehicles at `epoch` (one per block), in vehicle-key order. */
function scheduledAt(ctx: VehicleContext, epoch: number): readonly ScheduledVehicle[] {
  invariant(Number.isSafeInteger(epoch), 'an instant is a whole epoch second');
  const outcome = ctx.repo.vehiclesAt(epoch);
  invariant(outcome.kind === 'vehicles', `schedule.db runs service at ${epoch} (got ${outcome.kind})`);
  return outcome.vehicles;
}

/** `n` distinct synthetic fleet ids, "syn-100" … "syn-999", in a seeded order. */
function fleetIds(rng: SeededRandom, n: number): string[] {
  invariant(n > 0 && n <= 900, `${n} vehicles fit the synthetic id range`);
  const ids = rng.shuffle(Array.from({ length: 900 }, (_, i) => `syn-${100 + i}`)).slice(0, n);
  invariant(new Set(ids).size === n, 'fleet ids are distinct');
  return ids;
}

type RailMoverVehicle = { readonly entity: transit_realtime.IFeedEntity; readonly tripId: string; readonly lineId: LineId };

/** A rail or Mover vehicle: the scheduled vehicle as the timetable places it a few seconds before the header. */
function railMoverVehicle(ctx: VehicleContext, now: ScheduledVehicle, id: string): RailMoverVehicle {
  const ageS = ctx.rng.int(4, 45);
  const earlier = scheduledAt(ctx, ctx.feedEpoch - ageS).find((v) => v.vehicleKey === now.vehicleKey);
  const seen = earlier ?? now;
  const facts = tripFacts(ctx.db, seen.tripId);
  invariant(facts.lineId === seen.lineId, `trip ${seen.tripId}'s line is the scheduled vehicle's`);
  const call = currentCall(patternStops(ctx.db, facts.patternIdx), seen);
  const vehicle: transit_realtime.IVehiclePosition = {
    trip: { tripId: seen.tripId, startTime: clockOf(facts.startS), startDate: String(seen.serviceDate), scheduleRelationship: SCHEDULED, routeId: facts.routeId, directionId: facts.directionId },
    position: shapePosition(ctx, seen),
    currentStopSequence: call.stop.seq + 1,
    currentStatus: call.status,
    timestamp: earlier === undefined ? ctx.feedEpoch : ctx.feedEpoch - ageS,
    stopId: call.stop.stopId,
    vehicle: { id, label: id },
  };
  invariant(id.startsWith('syn-'), 'a synthetic vehicle id');
  return { entity: { id, vehicle }, tripId: seen.tripId, lineId: facts.lineId };
}

/** The stop a vehicle is at (STOPPED_AT) or heading to (IN_TRANSIT_TO, INCOMING_AT when under 150 m away). */
function currentCall(stops: readonly PatternStop[], at: ScheduledVehicle): { readonly stop: PatternStop; readonly status: number } {
  invariant(stops.length >= 2, 'a pattern has stops');
  if (at.state !== 'moving') {
    const nearest = stops.reduce((best, stop) => (Math.abs(stop.distM - at.distM) < Math.abs(best.distM - at.distM) ? stop : best));
    invariant(Math.abs(nearest.distM - at.distM) < 1, `a vehicle ${at.state} stands at a stop of its pattern`);
    return { stop: nearest, status: STOPPED_AT };
  }
  const next = stops.find((stop) => stop.distM > at.distM) ?? (stops[stops.length - 1] as PatternStop);
  invariant(next.distM >= at.distM, 'a moving vehicle heads to a stop ahead of it');
  return { stop: next, status: next.distM - at.distM < INCOMING_WITHIN_M ? INCOMING_AT : IN_TRANSIT_TO };
}

/** The scheduled coordinate as float32 (the wire type), checked ON the trip's shape; speed always, bearing about half the time. */
function shapePosition(ctx: VehicleContext, at: ScheduledVehicle): transit_realtime.IPosition {
  const latitude = Math.fround(at.position.latitude);
  const longitude = Math.fround(at.position.longitude);
  const points = shapePoints(ctx.db, at.shapeIdx);
  const off = metresToPolyline(latitude, longitude, points);
  invariant(off <= ON_SHAPE_TOLERANCE_M, `vehicle on trip ${at.tripId} sits ${off.toFixed(2)} m off its shape (want <= ${ON_SHAPE_TOLERANCE_M} m)`);
  const top = at.mode === 'rail' ? 24 : 8;
  const speed = at.state === 'moving' ? Math.round(ctx.rng.between(top / 3, top) * 10) / 10 : 0;
  invariant(speed >= 0 && speed <= top, 'a scheduled speed is a plausible metres per second');
  const bearing = ctx.rng.chance(0.55) ? { bearing: bearingAlong(points, at.distM) } : {};
  return { latitude, longitude, ...bearing, speed };
}

/** A bus on a synthetic route and trip near the rail and Mover stops: out of scope for the app. */
function busEntity(ctx: VehicleContext, id: string, k: number, anchors: readonly { latitude: number; longitude: number }[]): transit_realtime.IFeedEntity {
  invariant(k >= 0 && k < BUS_VEHICLES, 'a bus index is in range');
  const { rng } = ctx;
  const localS = ctx.feedEpoch - ctx.day.baseEpoch;
  const vehicle: transit_realtime.IVehiclePosition = {
    trip: {
      tripId: `syn-bus-trip-${1000 + k}`,
      startTime: clockOf(Math.max(0, localS - rng.int(5, 60) * 60 - (localS % 60))),
      startDate: String(ctx.day.date),
      scheduleRelationship: SCHEDULED,
      routeId: `syn-bus-route-${rng.int(1, 40)}`,
      directionId: rng.int(0, 1),
    },
    position: nearPosition(rng, anchors, 0.7, 0.35),
    currentStopSequence: rng.int(1, 60),
    currentStatus: rng.chance(0.55) ? STOPPED_AT : IN_TRANSIT_TO,
    timestamp: ctx.feedEpoch - rng.int(1, 600),
    stopId: `syn-bus-stop-${rng.int(100, 999)}`,
    vehicle: { id, label: id },
  };
  invariant(vehicle.trip?.routeId?.startsWith('syn-') === true, 'a bus route id is synthetic');
  return { id, vehicle };
}

/** A vehicle on no trip (deadheading or parked): an id, a position and a timestamp only. */
function idleEntity(ctx: VehicleContext, id: string, anchors: readonly { latitude: number; longitude: number }[]): transit_realtime.IFeedEntity {
  invariant(id.startsWith('syn-'), 'an idle vehicle id is synthetic');
  const vehicle: transit_realtime.IVehiclePosition = {
    position: nearPosition(ctx.rng, anchors, 0.7, 0.2),
    timestamp: ctx.feedEpoch - ctx.rng.int(1, 600),
    vehicle: { id, label: id },
  };
  invariant(vehicle.trip === undefined, 'an idle vehicle reports no trip');
  return { id, vehicle };
}

/** A float32 coordinate within ~2 km of a random stop (mostly west of it, inland); speed and bearing each with a chance. */
function nearPosition(rng: SeededRandom, anchors: readonly { latitude: number; longitude: number }[], pSpeed: number, pBearing: number): transit_realtime.IPosition {
  invariant(pSpeed >= 0 && pSpeed <= 1 && pBearing >= 0 && pBearing <= 1, 'presence rates are probabilities');
  const anchor = rng.pick(anchors);
  const latitude = Math.fround(anchor.latitude + rng.between(-0.02, 0.02));
  const longitude = Math.fround(anchor.longitude + rng.between(-0.03, 0.005));
  invariant(latitude > 25.1 && latitude < 26 && longitude > -80.9 && longitude < -80.1, 'a synthetic bus is in Miami-Dade');
  const speed = rng.chance(pSpeed) ? { speed: Math.round(rng.between(0, 15) * 10) / 10 } : {};
  const bearing = rng.chance(pBearing) ? { bearing: rng.int(0, 359) } : {};
  return { latitude, longitude, ...bearing, ...speed };
}

/** The feed encoded by the reference bindings, then read back by OUR decoder and checked against the oracle (R5). */
function encodeFeed(feedEpoch: number, entity: transit_realtime.IFeedEntity[]): Uint8Array {
  invariant(entity.length >= 50, 'a realistic whole-agency feed has at least 50 vehicles');
  const plain: transit_realtime.IFeedMessage = { header: { gtfsRealtimeVersion: '2.0', incrementality: FULL_DATASET, timestamp: feedEpoch }, entity };
  const problem = transit_realtime.FeedMessage.verify(plain);
  invariant(problem === null, `the synthetic feed is a valid FeedMessage: ${String(problem)}`);
  const bytes = Uint8Array.from(transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject(plain)).finish());
  const decoded = decodeFeedMessage(bytes);
  invariant(decoded.ok && decoded.value.entity.length === entity.length, 'our decoder reads every synthetic entity');
  const disagreement = oracleDisagreement(bytes, decoded.value);
  invariant(disagreement === null, `our decoder agrees with the oracle on the synthetic feed: ${disagreement ?? ''}`);
  return bytes;
}
