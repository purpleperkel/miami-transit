import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { type HurryDeparture, type HurryInput, type HurryVerdict, hurryVerdict } from '../hurry/verdict';
import type { LivePrediction } from '../live/types';
import type { ConnectionRisk, Itinerary, Leg } from './transitous';

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
 * A matched leg takes the predicted departure as from.epoch, its arrival moves by the same delay (a
 * prediction carries no arrival time) and it is marked live. The delay then follows the rider (mfix5):
 *   - a walk after a late leg starts when the rider gets there — both ends shifted, its duration kept;
 *   - a transit leg nobody predicts keeps its schedule, so its departure ABSORBS the delay when the rider
 *     still gets there at or before it, and every leg after it is unchanged;
 *   - when the delay overruns a transfer's slack, that next leg STILL keeps its time (a bus does not wait
 *     for a late train; no shifted time is invented for it), the legs after it follow that leg's own
 *     time, and the itinerary is flagged connectionAtRisk with the line that may be missed
 *     (ARBITER RULING 2026-10-02). Only the first such transfer is named: after it, the trip is moot.
 * A moved itinerary's endEpoch is its last leg's arrival and its durationS endEpoch - startEpoch. An
 * itinerary no prediction touches is returned as the very same object, an unpredicted leg is never marked
 * live, and the input is never mutated. A trip shared by two itineraries is updated in both.
 *
 * firstLegVerdict asks m7c's engine (hurryVerdict) whether to hurry for the first transit leg: the walk is
 * the straight line from the rider to that leg's boarding stop (the engine's 1.3 detour on top), the
 * departure is the leg's (live or scheduled) boarding time — and only that one, so with no following train a
 * jog that makes it is JOG. mfix8 (arbiter ruling): a caller whose rider is still where the itinerary starts
 * may opt in to the ROUTED walk instead — the metres Transitous routed for the walk legs before the first
 * ride, with no detour, since they already follow the streets. Opted in without a routed distance (no walk
 * leg before the ride, or one without distanceM), the straight line stands. mfix9: a caller may instead hand in
 * the walk it resolved itself (a FirstLegWalk) — the route chip off the plan start, whose walk is Transitous's
 * one-to-many street walk from the rider to the boarding stop, or that walk's straight-line estimate.
 */

/** Transitous's trip id prefix: the service day, the trip's first departure, the feed. */
const TRIP_PREFIX = /^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/;
/** Transitous's stop / route id prefix: the feed. */
const FEED_PREFIX = /^[A-Za-z0-9-]+_/;

/** The walking settings the verdict may override (HURRY_DEFAULTS otherwise). */
export type FirstLegPace = Omit<HurryInput, 'now' | 'walkMeters' | 'departures'>;

/** A walk to the first ride's boarding stop the caller resolved: metres, and the detour m7c's engine puts on them. */
export type FirstLegWalk = { readonly walkMeters: number; readonly detour: number };

/**
 * How firstLegVerdict walks to the boarding stop: false (m10a's default) the straight line from the rider with m7c's
 * detour; true (mfix8, opt-in) the routed walk legs before the ride, when Transitous gave their distances, else
 * that straight line; a FirstLegWalk (mfix9) the walk the caller resolved.
 */
export type FirstLegWalkRule = boolean | FirstLegWalk;

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

/** The itineraries with every boarding departure a live prediction covers moved to it, and its delay carried on. */
export function overlayLive(itineraries: readonly Itinerary[], predictions: readonly LivePrediction[]): Itinerary[] {
  invariant(itineraries.every((it) => it.legs.length > 0), 'every itinerary has legs (as parsed)');
  invariant(itineraries.every((it) => it.connectionAtRisk === undefined), 'the overlay reads itineraries as Transitous planned them');
  const live = liveIndex(predictions);
  const overlaid = itineraries.map((itinerary) => overlayItinerary(itinerary, live));
  invariant(overlaid.length === itineraries.length, 'every itinerary is kept, in order');
  invariant(overlaid.every((it, i) => it.legs.length === (itineraries[i] as Itinerary).legs.length), 'every leg is kept, in order');
  return overlaid;
}

/** Where the rider stands after a leg: how far behind schedule (s), when they got there, and the transfer at risk. */
type Progress = {
  /** Seconds behind (or, for an early train, ahead of) the schedule that later walks inherit. */
  readonly carriedS: number;
  /** When the rider reaches the end of the previous leg, epoch s; null before the first leg. */
  readonly arrivedEpoch: number | null;
  /** A transit leg came before, so the next one is boarded at a transfer. */
  readonly rode: boolean;
  readonly risk: ConnectionRisk | null;
};

const SETTING_OFF: Progress = Object.freeze({ carriedS: 0, arrivedEpoch: null, rode: false, risk: null });

/** One itinerary, live: its legs walked in order with the delay they carry; the itinerary itself when nothing moved. */
function overlayItinerary(itinerary: Itinerary, live: LiveIndex): Itinerary {
  invariant(itinerary.endEpoch >= itinerary.startEpoch, 'an itinerary ends after it starts');
  const legs: Leg[] = [];
  let progress = SETTING_OFF;
  for (const [index, leg] of itinerary.legs.entries()) {
    const step = leg.tripId === null ? walkOn(leg, progress) : rideOn(leg, index, progress, live);
    legs.push(step.leg);
    progress = step.progress;
  }
  if (progress.risk === null && legs.every((leg, j) => leg === itinerary.legs[j])) {
    return itinerary;
  }
  const first = legs[0] as Leg;
  const startEpoch = first === itinerary.legs[0] ? itinerary.startEpoch : first.from.epoch;
  const endEpoch = (legs[legs.length - 1] as Leg).to.epoch;
  const moved: Itinerary = { ...itinerary, startEpoch, endEpoch, durationS: endEpoch - startEpoch, legs, ...(progress.risk === null ? {} : { connectionAtRisk: progress.risk }) };
  invariant(moved.legs.length === itinerary.legs.length, 'every leg is kept, in order');
  invariant(moved.durationS === moved.endEpoch - moved.startEpoch, 'the duration is the moved trip\'s own');
  return moved;
}

type Step = { readonly leg: Leg; readonly progress: Progress };

/** A walk starts when the rider gets there: both ends shifted by the delay carried so far. */
function walkOn(leg: Leg, progress: Progress): Step {
  invariant(leg.tripId === null && !leg.live, 'a walk rides no trip and is never live');
  const walked = progress.carriedS === 0 ? leg : shifted(leg, progress.carriedS);
  invariant(walked.durationS === leg.durationS, 'a shifted walk takes as long');
  return { leg: walked, progress: { ...progress, arrivedEpoch: walked.to.epoch } };
}

/**
 * A ride: its live departure (and an arrival moved by the same delay) when a prediction covers it, its
 * schedule otherwise. Boarded at a transfer the rider reaches after it leaves, it is the connection at risk.
 */
function rideOn(leg: Leg, index: number, progress: Progress, live: LiveIndex): Step {
  invariant(leg.tripId !== null, 'a ride rides a trip');
  const ridden = overlayLeg(leg, live);
  const touched = ridden !== leg || progress.carriedS !== 0;
  const missed = progress.rode && touched && progress.arrivedEpoch !== null && progress.arrivedEpoch > ridden.from.epoch;
  const risk = progress.risk ?? (missed ? { legIndex: index, line: leg.routeShortName ?? leg.mode } : null);
  const next: Progress = { carriedS: ridden.to.epoch - leg.to.epoch, arrivedEpoch: ridden.to.epoch, rode: true, risk };
  invariant(ridden === leg || ridden.live, 'only a predicted ride moves, and it is live');
  return { leg: ridden, progress: next };
}

/** A leg moved `byS` seconds, both ends (its duration unchanged). */
function shifted(leg: Leg, byS: number): Leg {
  invariant(Number.isFinite(byS) && byS !== 0, 'a shift moves the leg');
  const moved: Leg = { ...leg, from: { ...leg.from, epoch: leg.from.epoch + byS }, to: { ...leg.to, epoch: leg.to.epoch + byS } };
  invariant(moved.to.epoch - moved.from.epoch === leg.to.epoch - leg.from.epoch, 'a shifted leg takes as long');
  return moved;
}

/**
 * m7c's hurry-or-chill verdict for an itinerary's first transit leg, or null for a walk-only itinerary, walking to
 * the boarding stop by `walk` (FirstLegWalkRule): by default the straight line from `position`.
 */
export function firstLegVerdict(itinerary: Itinerary, position: LatLon, now: number, pace: FirstLegPace = {}, walk: FirstLegWalkRule = false): HurryVerdict | null {
  invariant(isLatLon(position), `the rider's position is a valid coordinate: ${position.latitude},${position.longitude}`);
  invariant(Number.isFinite(now), 'the verdict is taken at an instant');
  invariant(typeof walk === 'boolean' || (Number.isFinite(walk.walkMeters) && walk.walkMeters >= 0 && walk.detour >= 1), 'a walk handed in is a real distance with a detour of at least 1');
  const first = itinerary.legs.findIndex((candidate) => candidate.tripId !== null);
  const leg = itinerary.legs[first];
  if (leg === undefined) {
    return null;
  }
  const stop: LatLon = { latitude: leg.from.latitude, longitude: leg.from.longitude };
  const routed = walk === true ? routedWalkMeters(itinerary.legs.slice(0, first)) : null;
  const walked = typeof walk === 'object' ? walk : routed === null ? { walkMeters: haversineMeters(position, stop) } : { walkMeters: routed, detour: 1 };
  const departure: HurryDeparture = { epoch: leg.from.epoch, live: leg.live, lineId: leg.routeShortName, headsign: leg.headsign };
  const verdict = hurryVerdict({ ...pace, now, ...walked, departures: [departure] });
  invariant(verdict.departure === null || verdict.departure.epoch === leg.from.epoch, 'the verdict is about the boarding departure of the first leg');
  return verdict;
}

/** The routed metres of the walk legs before the first ride; null with no walk leg, or one Transitous gave no distance. */
function routedWalkMeters(beforeRide: readonly Leg[]): number | null {
  invariant(beforeRide.every((leg) => leg.tripId === null), 'nothing before the first ride rides a trip');
  const walks = beforeRide.filter((leg) => leg.mode === 'WALK');
  let meters: number | null = walks.length === 0 ? null : 0;
  for (const leg of walks) {
    meters = meters === null || leg.distanceM === null ? null : meters + leg.distanceM;
  }
  invariant(meters === null || (Number.isFinite(meters) && meters >= 0), 'a routed walk is a non-negative distance');
  return meters;
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

/**
 * The leg live, when a usable prediction covers its boarding: the predicted departure, the arrival moved by
 * the same delay (m4a predicts no arrival), its duration kept; else the leg itself.
 */
function overlayLeg(leg: Leg, live: LiveIndex): Leg {
  invariant(Number.isFinite(leg.from.epoch), 'a leg departs at an instant');
  if (leg.tripId === null || leg.from.stopId === null) {
    return leg;
  }
  const epoch = live.get(gtfsTripId(leg.tripId))?.get(gtfsStopId(leg.from.stopId));
  if (epoch === undefined) {
    return leg;
  }
  const delayS = epoch - leg.from.epoch;
  const overlaid: Leg = { ...leg, from: { ...leg.from, epoch }, to: { ...leg.to, epoch: leg.to.epoch + delayS }, live: true };
  invariant(overlaid.tripId === leg.tripId && overlaid.durationS === overlaid.to.epoch - overlaid.from.epoch, 'the ride moves whole: same trip, same duration');
  return overlaid;
}
