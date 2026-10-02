import type { StationListing } from '../../data/schedule-queries';
import { MODES, type ModeStatuses, type NextStart } from '../../domain/schedule/mode-status';
import type { Mode } from '../../domain/network/stations';
import { nearestPlatform, type Platform } from '../../domain/hurry/platform';
import { haversineMeters, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { HURRY_RANGE_M } from '../hurry/hurry-reading';
import { countdown } from '../trips/countdown';
import { type TripCardModel, sortByLeaveAt } from '../trips/trip-card';
import type { Timed } from '../trips/trip-copy';
import type { NowState } from './nowStore';

/**
 * Plan M7.7 "Home context": the single most relevant thing about now, which the Now bar says and the Map tab
 * acts on, in this order (mfix8, decision.miami_transit_bar_uses_saved_trips: SAVED TRIPS drive the bar — it
 * never judges a station the rider did not ask about):
 *
 *   trip       a saved trip's countdown is live (leave-by within the hour, or just missed) and the rider is
 *              NOT near its origin (or has no fix): its countdown
 *   nearTrip   the rider is within NEAR_TRIP_M of a saved trip's origin: hurry or chill for THAT trip (the
 *              soonest leave-by among the near trips the schedule can judge) — useNearTripVerdict
 *   noService  neither Metrorail nor Metromover runs now (01:30): the bar never claims a train, and says
 *              when service starts again
 *   station    the rider is within AT_STATION_M of a station: that station — and AUTO-PRESENT its sheet
 *              (its next trains), unless the rider moved the map in the last MAP_GESTURE_HOLD_S (someone
 *              exploring the map is never interrupted) or it was already presented on this visit
 *   unknown    otherwise: what the rider wants now is not known (no saved trip to count down or judge, and
 *              no station they stand at — or no position, or no stations yet)
 * The bar says "Where to?" for the last two; the Map tab auto-presents for `station`.
 *
 * Why a countdown is only for a trip the rider is NOT near (mfix8's resolved conflict): every saved trip with a
 * ride in the next hour has a live countdown, so a countdown first for every trip would leave no near trip
 * ever judged. Near its origin the verdict says more ("Jog · 1 min spare"); away from it, when to leave.
 *
 * Pure: the Now bar gathers the inputs (useHomeContext.ts) and the Map tab acts on `autoPresent`.
 */

/** "At a station": within this straight-line distance of its centre (a platform end is ~100 m out). */
export const AT_STATION_M = 150;
/** After a pan or zoom on the map, nothing is auto-presented for this long. */
export const MAP_GESTURE_HOLD_S = 300;
/**
 * mfix8: a saved trip is NEAR when the straight-line metres from the rider to its origin station's nearest
 * PLATFORM are at most this (inclusive) — m7c's hurry range: beyond it there is no train to hurry for.
 */
export const NEAR_TRIP_M = HURRY_RANGE_M;

export type ActiveTrip = { readonly card: TripCardModel; readonly status: Timed };

export type HomeContext =
  | { readonly kind: 'trip'; readonly trip: ActiveTrip; readonly nowS: number }
  | { readonly kind: 'nearTrip'; readonly card: TripCardModel; readonly nowS: number }
  | { readonly kind: 'noService'; readonly reopens: { readonly mode: Mode; readonly at: NextStart } | null }
  | { readonly kind: 'station'; readonly stationKey: string; readonly stationName: string; readonly distanceM: number; readonly autoPresent: boolean }
  | { readonly kind: 'unknown' };

const UNKNOWN: HomeContext = Object.freeze({ kind: 'unknown' });

export type HomeInput = {
  readonly nowS: number;
  readonly position: LatLon | null;
  readonly stations: readonly StationListing[];
  /** Every platform: a trip is near by its origin's nearest platform. */
  readonly platforms: readonly Platform[];
  /** Whether each mode runs now (ScheduleRepo.modeStatusAt); null while the schedule opens or has no day now. */
  readonly modes: ModeStatuses | null;
  /** The saved trips' cards (trip-card.ts), or none. */
  readonly cards: readonly TripCardModel[];
  /** The Now store's gesture and presentation marks. */
  readonly now: Pick<NowState, 'lastGestureS' | 'presentedKey'>;
};

export function homeContext(input: HomeInput): HomeContext {
  invariant(Number.isSafeInteger(input.nowS), 'a home context is read at a whole second');
  const near = input.cards.filter((card) => isNearTrip(card, input.position, input.platforms));
  const trip = activeTrip(input.cards.filter((card) => !near.includes(card)), input.nowS);
  if (trip !== null) {
    return { kind: 'trip', trip, nowS: input.nowS };
  }
  const judged = sortByLeaveAt(near.filter(isJudgeable))[0];
  if (judged !== undefined) {
    return { kind: 'nearTrip', card: judged, nowS: input.nowS };
  }
  if (input.modes !== null && MODES.every((mode) => input.modes?.[mode].kind !== 'running')) {
    return { kind: 'noService', reopens: firstReopening(input.modes) };
  }
  const nearest = nearestStation(input.position, input.stations);
  if (nearest === null || nearest.distanceM > AT_STATION_M) {
    return UNKNOWN;
  }
  const named = { stationKey: nearest.station.stationKey, stationName: nearest.station.name, distanceM: nearest.distanceM };
  const explored = input.now.lastGestureS !== null && input.nowS - input.now.lastGestureS < MAP_GESTURE_HOLD_S;
  const context: HomeContext = { kind: 'station', ...named, autoPresent: !explored && input.now.presentedKey !== named.stationKey };
  invariant(context.distanceM <= AT_STATION_M, 'a station context is about a station the rider is at');
  return context;
}

/** The rider is within NEAR_TRIP_M (straight line, inclusive) of the trip's origin station's nearest platform. */
export function isNearTrip(card: TripCardModel, position: LatLon | null, platforms: readonly Platform[]): boolean {
  invariant(card.trip.fromStationKey.includes(':'), 'a trip leaves from a station keyed mode:name');
  const origin = platforms.filter((platform) => platform.stationKey === card.trip.fromStationKey);
  const nearest = position === null ? null : nearestPlatform(position, origin, null);
  invariant(nearest === null || nearest.platform.stationKey === card.trip.fromStationKey, 'the distance is to a platform of the origin');
  return nearest !== null && nearest.walkMeters <= NEAR_TRIP_M;
}

/**
 * The schedule can judge the trip now: it has direct rides (counting down, or out of reach with this walk), or
 * nothing leaves its origin (night: "No more trains tonight"). A pair needing a transfer, a station the
 * timetable lacks or no timetable has no verdict to give.
 */
function isJudgeable(card: TripCardModel): boolean {
  const kind = card.status.kind;
  invariant(typeof kind === 'string', 'a card has a status');
  const judgeable = kind === 'leave' || kind === 'out-of-reach' || kind === 'no-service';
  invariant(!judgeable || card.trip.fromStationKey !== card.trip.toStationKey, 'a judged trip joins two stations');
  return judgeable;
}

/** The soonest trip whose countdown is live (within the hour, or just missed); null when none is. */
export function activeTrip(cards: readonly TripCardModel[], nowS: number): ActiveTrip | null {
  invariant(Number.isSafeInteger(nowS), 'a trip is judged at a whole second');
  for (const card of sortByLeaveAt(cards)) {
    if (card.status.kind === 'leave' && countdown(card.status.current.leaveByEpoch, nowS).state !== 'clock') {
      return { card, status: card.status };
    }
  }
  invariant(cards.every((card) => card.status.kind !== 'leave' || countdown(card.status.current.leaveByEpoch, nowS).state === 'clock'), 'no live countdown is passed over');
  return null;
}

/** The station whose centre is nearest the rider, with the distance; null without a position or stations. */
function nearestStation(position: LatLon | null, stations: readonly StationListing[]): { readonly station: StationListing; readonly distanceM: number } | null {
  invariant(stations.every((s) => s.stationKey.includes(':')), 'stations are keyed mode:name');
  let best: { station: StationListing; distanceM: number } | null = null;
  for (const station of position === null ? [] : stations) {
    const distanceM = haversineMeters(position as LatLon, station.coordinate);
    if (best === null || distanceM < best.distanceM) {
      best = { station, distanceM };
    }
  }
  invariant(best === null || best.distanceM >= 0, 'a distance is never negative');
  return best;
}

/** The closed mode that opens first, and when; null when no mode has a timetable left. */
function firstReopening(modes: ModeStatuses): { readonly mode: Mode; readonly at: NextStart } | null {
  invariant(MODES.every((mode) => modes[mode].kind !== 'running'), 'nothing runs now');
  let first: { mode: Mode; at: NextStart } | null = null;
  for (const mode of MODES) {
    const status = modes[mode];
    if (status.kind === 'closed' && (first === null || status.nextStart.epoch < first.at.epoch)) {
      first = { mode, at: status.nextStart };
    }
  }
  invariant(first === null || modes[first.mode].kind === 'closed', 'the first to reopen is a closed mode');
  return first;
}
