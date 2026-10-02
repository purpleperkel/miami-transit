import type { StationListing } from '../../data/schedule-queries';
import { MODES, type ModeStatuses, type NextStart } from '../../domain/schedule/mode-status';
import type { Mode } from '../../domain/network/stations';
import { haversineMeters, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { countdown } from '../trips/countdown';
import { type TripCardModel, sortByLeaveAt } from '../trips/trip-card';
import type { Timed } from '../trips/trip-copy';
import type { NowState } from './nowStore';

/**
 * Plan M7.7 "Home context": the single most relevant thing about now, which the Now strip says (plan §4:
 * "at a station → its next train; active trip → 'Leave in 6 min'; otherwise the nearest station"), in
 * this order:
 *
 *   trip       a saved trip's leave-by is within the hour (or just missed): its countdown
 *   noService  neither Metrorail nor Metromover runs now (01:30): the strip never claims a train, and
 *              says when service starts again
 *   station    the rider is within AT_STATION_M of a station: that station — and AUTO-PRESENT its sheet
 *              (its next trains), unless the rider moved the map in the last MAP_GESTURE_HOLD_S (someone
 *              exploring the map is never interrupted) or it was already presented on this visit
 *   nearest    otherwise the nearest station
 *   unknown    no position (or no stations yet)
 *
 * Pure: the Now strip gathers the inputs (useHomeContext.ts) and the Map tab acts on `autoPresent`.
 */

/** "At a station": within this straight-line distance of its centre (a platform end is ~100 m out). */
export const AT_STATION_M = 150;
/** After a pan or zoom on the map, nothing is auto-presented for this long. */
export const MAP_GESTURE_HOLD_S = 300;

export type ActiveTrip = { readonly card: TripCardModel; readonly status: Timed };

export type HomeContext =
  | { readonly kind: 'trip'; readonly trip: ActiveTrip; readonly nowS: number }
  | { readonly kind: 'noService'; readonly reopens: { readonly mode: Mode; readonly at: NextStart } | null }
  | { readonly kind: 'station'; readonly stationKey: string; readonly stationName: string; readonly distanceM: number; readonly autoPresent: boolean }
  | { readonly kind: 'nearest'; readonly stationKey: string; readonly stationName: string; readonly distanceM: number }
  | { readonly kind: 'unknown' };

export type HomeInput = {
  readonly nowS: number;
  readonly position: LatLon | null;
  readonly stations: readonly StationListing[];
  /** Whether each mode runs now (ScheduleRepo.modeStatusAt); null while the schedule opens or has no day now. */
  readonly modes: ModeStatuses | null;
  /** The saved trips' cards (trip-card.ts), or none. */
  readonly cards: readonly TripCardModel[];
  /** The Now store's gesture and presentation marks. */
  readonly now: Pick<NowState, 'lastGestureS' | 'presentedKey'>;
};

export function homeContext(input: HomeInput): HomeContext {
  invariant(Number.isSafeInteger(input.nowS), 'a home context is read at a whole second');
  const trip = activeTrip(input.cards, input.nowS);
  if (trip !== null) {
    return { kind: 'trip', trip, nowS: input.nowS };
  }
  if (input.modes !== null && MODES.every((mode) => input.modes?.[mode].kind !== 'running')) {
    return { kind: 'noService', reopens: firstReopening(input.modes) };
  }
  const nearest = nearestStation(input.position, input.stations);
  if (nearest === null) {
    return { kind: 'unknown' };
  }
  const named = { stationKey: nearest.station.stationKey, stationName: nearest.station.name, distanceM: nearest.distanceM };
  if (nearest.distanceM > AT_STATION_M) {
    return { kind: 'nearest', ...named };
  }
  const explored = input.now.lastGestureS !== null && input.nowS - input.now.lastGestureS < MAP_GESTURE_HOLD_S;
  const context: HomeContext = { kind: 'station', ...named, autoPresent: !explored && input.now.presentedKey !== named.stationKey };
  invariant(context.distanceM <= AT_STATION_M, 'a station context is about a station the rider is at');
  return context;
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
