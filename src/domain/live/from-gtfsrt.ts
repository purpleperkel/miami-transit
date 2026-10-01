import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { FeedEntity, FeedMessage, StopTimeEvent, StopTimeUpdate, VehiclePosition } from '../gtfsrt/types';
import { StopTimeScheduleRelationship, TripScheduleRelationship, VehicleStopStatus } from '../gtfsrt/types';
import { lineById, type LineId, linesOfRoute } from '../lines/line-catalog';
import { countDrop, type Drops } from './drops';
import { resolveLine, tripLineOnRoute } from './line-from-position';
import type { DropReason, LiveNetwork, LivePrediction, LiveVehicle, MappedFeed, StopStatus } from './types';

/**
 * Plan M4.2: one GTFS-realtime mapper for both providers — Swiftly's vehicle positions and trip
 * updates, Transitland's vehicle positions (both are standard GTFS-rt protobuf, decoded by
 * src/domain/gtfsrt). Pure: the schedule facts it needs (trip → line, stop → station, line tracks)
 * are injected as a LiveNetwork.
 *
 *  - Only routes 31009 / 14456 / 14457 are kept (the line catalog's routes). A trip descriptor with
 *    no route_id takes the route of its trip's line, when the schedule knows the trip.
 *  - A vehicle's line: line-from-position.ts (route → known trip → position; neutral on a trunk).
 *  - Every entity left out is counted by reason in `dropped` — none disappears silently.
 *  - The age rules (merge rule 1) are NOT applied here: the mapper keeps measured times; merge.ts
 *    judges them against the provider's thresholds at merge time.
 */

/** Every in-scope vehicle in the feed, one per vehicle id (the newest wins), sorted by id. */
export function vehiclesFromFeed(feed: FeedMessage, network: LiveNetwork): MappedFeed<LiveVehicle> {
  invariant(Array.isArray(feed.entity), 'a decoded feed lists its entities');
  const dropped: Drops = {};
  const byId = new Map<string, LiveVehicle>();
  for (const entity of feed.entity) {
    if (entity.vehicle === null) {
      continue; // not a vehicle (a trip update in a combined feed): predictionsFromFeed reads it
    }
    const mapped = entity.isDeleted === true ? 'deleted' : vehicleFromEntity(entity, entity.vehicle, feed.header.timestamp, network);
    if (typeof mapped === 'string') {
      countDrop(dropped, mapped);
      continue;
    }
    const seen = byId.get(mapped.vehicleId);
    if (seen !== undefined) {
      countDrop(dropped, 'duplicate');
    }
    if (seen === undefined || mapped.timestamp > seen.timestamp) {
      byId.set(mapped.vehicleId, mapped);
    }
  }
  const items = [...byId.values()].sort((a, b) => (a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : 0));
  invariant(items.every((v) => linesOfRoute(v.routeId).length > 0), 'only in-scope vehicles are kept');
  return { items, feedTimestamp: feed.header.timestamp, dropped };
}

/** One vehicle entity as a LiveVehicle, or the reason it is left out. */
function vehicleFromEntity(entity: FeedEntity, vp: VehiclePosition, headerTimestamp: number | null, network: LiveNetwork): LiveVehicle | DropReason {
  invariant(entity.vehicle === vp, 'the vehicle belongs to its entity');
  const tripId = nonEmpty(vp.trip?.tripId ?? null);
  const routeId = inScopeRoute(vp.trip?.routeId ?? null, tripId, network);
  if (routeId === null) {
    return 'out-of-scope';
  }
  const position: LatLon | null = vp.position === null ? null : { latitude: vp.position.latitude, longitude: vp.position.longitude };
  if (position === null || !isLatLon(position)) {
    return 'no-position';
  }
  const timestamp = vp.timestamp ?? headerTimestamp;
  if (timestamp === null) {
    return 'no-timestamp';
  }
  const line = resolveLine(routeId, tripId, position, network);
  const vehicle: LiveVehicle = {
    vehicleId: nonEmpty(vp.vehicle?.id ?? null) ?? entity.id,
    label: nonEmpty(vp.vehicle?.label ?? null),
    tripId,
    routeId,
    mode: lineById(lineOfRoute(routeId)).mode,
    lineId: line.lineId,
    lineSource: line.lineSource,
    directionId: vp.trip?.directionId ?? null,
    position,
    bearing: vp.position?.bearing ?? null,
    speedMps: vp.position?.speed ?? null,
    stopId: nonEmpty(vp.stopId),
    stopStatus: stopStatusOf(vp.currentStatus),
    timestamp,
  };
  invariant(vehicle.vehicleId.length > 0, 'a live vehicle has an id');
  return vehicle;
}

/** Every usable stop prediction in the feed's trip updates, in feed order; a canceled trip is one trip-wide row. */
export function predictionsFromFeed(feed: FeedMessage, network: LiveNetwork): MappedFeed<LivePrediction> {
  invariant(Array.isArray(feed.entity), 'a decoded feed lists its entities');
  const dropped: Drops = {};
  const items: LivePrediction[] = [];
  for (const entity of feed.entity) {
    const update = entity.tripUpdate;
    if (update === null) {
      continue; // not a trip update (a vehicle in a combined feed): vehiclesFromFeed reads it
    }
    const tripId = nonEmpty(update.trip.tripId);
    const routeId = entity.isDeleted === true ? null : inScopeRoute(update.trip.routeId, tripId, network);
    if (routeId === null) {
      countDrop(dropped, entity.isDeleted === true ? 'deleted' : 'out-of-scope');
      continue;
    }
    const base = { tripId, routeId, lineId: tripLineOnRoute(tripId, routeId, network.lineOfTrip), headsign: null };
    if (update.trip.scheduleRelationship === TripScheduleRelationship.CANCELED) {
      items.push({ ...base, stopId: null, stationKey: null, epoch: null, scheduledEpoch: null, delayS: null, realtime: true, canceled: true });
      continue;
    }
    for (const stopUpdate of update.stopTimeUpdate) {
      const mapped = predictionFromStopUpdate(base, stopUpdate, network);
      if (typeof mapped === 'string') {
        countDrop(dropped, mapped);
      } else {
        items.push(mapped);
      }
    }
  }
  invariant(items.every((p) => p.canceled || p.epoch !== null || p.delayS !== null), 'every kept prediction says when, or that it will not run');
  return { items, feedTimestamp: feed.header.timestamp, dropped };
}

type PredictionBase = Pick<LivePrediction, 'tripId' | 'routeId' | 'lineId' | 'headsign'>;

/** One StopTimeUpdate as a prediction at a schedule stop, or the reason it is left out. */
function predictionFromStopUpdate(base: PredictionBase, update: StopTimeUpdate, network: LiveNetwork): LivePrediction | DropReason {
  invariant(base.routeId.length > 0, 'a prediction belongs to an in-scope route');
  const stopId = nonEmpty(update.stopId);
  if (stopId === null) {
    return 'no-stop'; // a stop given by stop_sequence alone cannot be placed without the trip's own pattern
  }
  const stationKey = network.stationOfStop(stopId);
  if (stationKey === null) {
    return 'unknown-stop';
  }
  if (update.scheduleRelationship === StopTimeScheduleRelationship.NO_DATA) {
    return 'no-data';
  }
  const canceled = update.scheduleRelationship === StopTimeScheduleRelationship.SKIPPED;
  const event = informative(update.departure) ?? informative(update.arrival);
  if (!canceled && event === null) {
    return 'no-data';
  }
  const prediction = { ...base, stopId, stationKey, epoch: event?.time ?? null, scheduledEpoch: null, delayS: event?.delay ?? null, realtime: true, canceled };
  invariant(prediction.stationKey.includes(':'), 'a station key is mode:name');
  return prediction;
}

/** The event when it carries a time or a delay; null when absent or empty. */
function informative(event: StopTimeEvent | null): StopTimeEvent | null {
  invariant(event === null || typeof event === 'object', 'a stop-time event is an object or absent');
  const useful = event !== null && (event.time !== null || event.delay !== null) ? event : null;
  invariant(useful === null || useful.time !== null || useful.delay !== null, 'an informative event says when');
  return useful;
}

/** The in-scope route a descriptor names, else its trip's route when the schedule knows the trip; null = out of scope. */
function inScopeRoute(routeId: string | null, tripId: string | null, network: LiveNetwork): string | null {
  invariant(routeId === null || typeof routeId === 'string', 'a route_id is a string or absent');
  const named = nonEmpty(routeId);
  if (named !== null) {
    return linesOfRoute(named).length > 0 ? named : null;
  }
  const line = tripId === null ? null : network.lineOfTrip(tripId);
  const route = line === null ? null : lineById(line).routeId;
  invariant(route === null || linesOfRoute(route).length > 0, 'a trip\'s route is a catalog route');
  return route;
}

/** Any line of an in-scope route (they share a mode). */
function lineOfRoute(routeId: string): LineId {
  const [first, ...rest] = linesOfRoute(routeId);
  invariant(first !== undefined, `route ${routeId} is in scope`);
  invariant(rest.every((line) => line.mode === first.mode), `the lines of route ${routeId} share a mode`);
  return first.id;
}

function stopStatusOf(status: number | null): StopStatus | null {
  invariant(status === null || Number.isInteger(status), 'a stop status is an enum number or absent');
  const named: StopStatus | null =
    status === VehicleStopStatus.INCOMING_AT ? 'incoming' : status === VehicleStopStatus.STOPPED_AT ? 'stopped' : status === VehicleStopStatus.IN_TRANSIT_TO ? 'in-transit' : null;
  invariant(named !== null || status === null || status > VehicleStopStatus.IN_TRANSIT_TO || status < 0, 'every known status is named');
  return named;
}

/** A string field, with the empty string read as absent (proto3-style producers send ''). */
function nonEmpty(value: string | null): string | null {
  invariant(value === null || typeof value === 'string', 'a string field is a string or absent');
  const result = value === null || value.length === 0 ? null : value;
  invariant(result === null || result.length > 0, 'a present string is non-empty');
  return result;
}
