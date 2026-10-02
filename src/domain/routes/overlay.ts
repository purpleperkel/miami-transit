import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { type HurryDeparture, type HurryInput, type HurryVerdict, hurryVerdict } from '../hurry/verdict';
import type { LivePrediction } from '../live/types';
import type { Itinerary, Leg } from './transitous';

/**
 * Plan M10a.2 — the live overlay and the first-leg verdict, pure.
 *
 * Transitous's Miami times are schedule-only (every leg realTime:false), so the app corrects them with
 * m4a's live predictions. Transitous prefixes the county's GTFS ids, the predictions carry them plain:
 *   tripId  20261001_14:57_us-fl-miami-dade_6283524  →  6283524   (<service day>_<hh:mm>_<feed>_<trip_id>)
 *   stopId  us-fl-miami-dade_9512                    →  9512      (<feed>_<stop_id>)
 * A leg matches a prediction on (trip_id, BOARDING stop_id), prefixes stripped. Only a usable prediction
 * counts: a realtime estimate (Transitland STATIC rows are scheduled, with epoch null), not canceled, with
 * an epoch. The same trip predicted at another stop — the alighting station, say — never moves a boarding
 * departure. m4a predicts the rail and Mover routes only, so in effect only those legs ever go live.
 *
 * A matched leg takes the predicted departure as from.epoch and is marked live; every other leg (and
 * every itinerary without a match) is returned as the very same object, and the input is never mutated.
 * A trip shared by two itineraries is updated in both.
 *
 * firstLegVerdict asks m7c's engine (hurryVerdict) whether to hurry for the first transit leg: the walk is
 * the straight line from the rider to that leg's boarding stop, the departure is the leg's (live or
 * scheduled) boarding time — and only that one, so with no following train a jog that makes it is JOG.
 */

/** Transitous's trip id prefix: the service day, the trip's first departure, the feed. */
const TRIP_PREFIX = /^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/;
/** Transitous's stop / route id prefix: the feed. */
const FEED_PREFIX = /^[A-Za-z0-9-]+_/;

/** The walking settings the verdict may override (HURRY_DEFAULTS otherwise). */
export type FirstLegPace = Omit<HurryInput, 'now' | 'walkMeters' | 'departures'>;

/** trip_id → boarding stop_id → predicted departure (epoch s), from the usable predictions only. */
type LiveIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** The county's GTFS trip_id inside a Transitous trip id (an id without the prefix is returned as is). */
export function gtfsTripId(transitousTripId: string): string {
  invariant(transitousTripId.length > 0, 'a trip id is non-empty');
  const tripId = transitousTripId.replace(TRIP_PREFIX, '');
  invariant(tripId.length > 0 && transitousTripId.endsWith(tripId), 'the GTFS trip_id is the tail of the Transitous id');
  return tripId;
}

/** The county's GTFS stop_id inside a Transitous stop id (an id without the prefix is returned as is). */
export function gtfsStopId(transitousStopId: string): string {
  invariant(transitousStopId.length > 0, 'a stop id is non-empty');
  const stopId = transitousStopId.replace(FEED_PREFIX, '');
  invariant(stopId.length > 0 && transitousStopId.endsWith(stopId), 'the GTFS stop_id is the tail of the Transitous id');
  return stopId;
}

/** The itineraries with every boarding departure a live prediction covers moved to it and marked live. */
export function overlayLive(itineraries: readonly Itinerary[], predictions: readonly LivePrediction[]): Itinerary[] {
  invariant(itineraries.every((it) => it.legs.length > 0), 'every itinerary has legs (as parsed)');
  const live = liveIndex(predictions);
  const overlaid = itineraries.map((itinerary) => {
    const legs = itinerary.legs.map((leg) => overlayLeg(leg, live));
    return legs.every((leg, j) => leg === itinerary.legs[j]) ? itinerary : { ...itinerary, legs };
  });
  invariant(overlaid.length === itineraries.length, 'every itinerary is kept, in order');
  invariant(overlaid.every((it, i) => it.legs.length === (itineraries[i] as Itinerary).legs.length), 'every leg is kept, in order');
  return overlaid;
}

/** m7c's hurry-or-chill verdict for an itinerary's first transit leg, or null for a walk-only itinerary. */
export function firstLegVerdict(itinerary: Itinerary, position: LatLon, now: number, pace: FirstLegPace = {}): HurryVerdict | null {
  invariant(isLatLon(position), `the rider's position is a valid coordinate: ${position.latitude},${position.longitude}`);
  invariant(Number.isFinite(now), 'the verdict is taken at an instant');
  const leg = itinerary.legs.find((candidate) => candidate.tripId !== null);
  if (leg === undefined) {
    return null;
  }
  const stop: LatLon = { latitude: leg.from.latitude, longitude: leg.from.longitude };
  const departure: HurryDeparture = { epoch: leg.from.epoch, live: leg.live, lineId: leg.routeShortName, headsign: leg.headsign };
  const verdict = hurryVerdict({ ...pace, now, walkMeters: haversineMeters(position, stop), departures: [departure] });
  invariant(verdict.departure === null || verdict.departure.epoch === leg.from.epoch, 'the verdict is about the boarding departure of the first leg');
  return verdict;
}

/** The usable predictions — realtime, not canceled, with an epoch, a trip and a stop — by trip and stop. */
function liveIndex(predictions: readonly LivePrediction[]): LiveIndex {
  invariant(predictions.every((p) => typeof p.realtime === 'boolean'), 'every prediction says whether it is realtime');
  const index = new Map<string, Map<string, number>>();
  for (const p of predictions) {
    if (!p.realtime || p.canceled || p.epoch === null || p.tripId === null || p.stopId === null) {
      continue;
    }
    const stops = index.get(p.tripId) ?? new Map<string, number>();
    if (!stops.has(p.stopId)) {
      stops.set(p.stopId, p.epoch);
    }
    index.set(p.tripId, stops);
  }
  invariant([...index.values()].every((stops) => stops.size > 0), 'every indexed trip has a predicted stop');
  return index;
}

/** The leg with its boarding departure live, when a usable prediction covers it; else the leg itself. */
function overlayLeg(leg: Leg, live: LiveIndex): Leg {
  invariant(Number.isFinite(leg.from.epoch), 'a leg departs at an instant');
  if (leg.tripId === null || leg.from.stopId === null) {
    return leg;
  }
  const epoch = live.get(gtfsTripId(leg.tripId))?.get(gtfsStopId(leg.from.stopId));
  if (epoch === undefined) {
    return leg;
  }
  const overlaid: Leg = { ...leg, from: { ...leg.from, epoch }, live: true };
  invariant(overlaid.to === leg.to && overlaid.tripId === leg.tripId, 'only the boarding departure and the live flag change');
  return overlaid;
}
