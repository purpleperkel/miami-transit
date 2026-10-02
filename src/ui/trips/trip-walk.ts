import type { SavedTrip } from '../../data/saved-trips-repo';
import type { Platform } from '../../domain/hurry/platform';
import { HURRY_DEFAULTS } from '../../domain/hurry/verdict';
import type { Ride } from '../../domain/schedule/rides';
import { isWalkOverride } from '../../domain/trips/walk-estimate';
import type { WalkStop, WalkTo } from '../../domain/walk/walk-cache';
import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';

/**
 * mfix11 (Jamie, 2026-10-02 09:12: "Also says chill pace for getting to fifth but estimated walk time from Google Maps
 * would put me at 1 min after scheduled arrival"): a saved trip has ONE walk, decided here and nowhere else. The Now
 * bar's verdict (src/ui/hurry/trip-verdict.ts), the trip card's walk and leave-by (trip-card.ts: the Trips tab, the
 * trip screen and the bar's countdown) and the reminders (reminder-candidates.ts) all take it from savedTripWalk:
 *
 *   override   the trip's own walk minutes (Jamie's setting): exactly minutes x 60 s, needing no position
 *   routed     from the rider, when mfix9's walk (useWalkTo) knows the street walk to the boarding platform
 *   estimated  the straight line to the boarding platform x m7c's detour (HURRY_DEFAULTS.detour), from the rider, or
 *              — with no fix — from the trip's saved start; with neither there is no walk (null)
 *
 * WHERE FROM (arbiter ruling, 2026-10-02): the live screens walk from the rider whenever located, a trip with a saved
 * start included; the saved start is the origin only without a fix (reminders, which run with none, and a card read
 * before the first fix). mfix9's street walks start at the rider, so a walk from the saved start is the estimate.
 *
 * The platform is the trip's boarding platform NEAREST the walk's origin in a straight line (a tie keeps the first
 * listed), and only that platform's walk is asked for. The pace is always the caller's — Jamie's, readWalkingPace() —
 * and there is no default: a missing pace throws. walkS is whole seconds rounded UP, and `minutes`, what every screen
 * shows, is ceil(walkS / 60) (an override's own minutes): a walk is never shown shorter than it is, and since
 * ceil(ceil(x) / 60) = ceil(x / 60) the card's minutes are the bar's for the same metres.
 */

/** The trip's own walk minutes, set by Jamie: walked in exactly that time, to no platform in particular. */
type OverrideWalk = {
  readonly source: 'override';
  readonly from: 'setting';
  /** Whole seconds: the minutes x 60. */
  readonly walkS: number;
  /** The minutes Jamie set, shown as they are (0 stays 0). */
  readonly minutes: number;
  readonly stopId: null;
  readonly walkedM: null;
  readonly straightM: null;
};

/** A walk measured to the trip's boarding platform: Transitous's street walk ('routed') or the straight line x m7c's detour ('estimated'). */
type MeasuredWalk = {
  readonly source: 'routed' | 'estimated';
  /** It starts at the rider ('here') or, with no fix, at the trip's saved start ('start'). */
  readonly from: 'here' | 'start';
  /** Whole seconds at Jamie's pace, rounded up: ceil(walkedM / walkMps). */
  readonly walkS: number;
  /** What every screen shows: ceil(walkS / 60). */
  readonly minutes: number;
  /** The GTFS stop_id of the boarding platform walked to. */
  readonly stopId: string;
  /** The metres walked, the detour included, unrounded: what the bar's verdict walks. */
  readonly walkedM: number;
  /** The straight line from the walk's origin to that platform: what picked it. */
  readonly straightM: number;
};

export type SavedTripWalk = OverrideWalk | MeasuredWalk;

export type SavedTripWalkInput = {
  /** The trip's boarding platforms (boardingPlatforms). */
  readonly platforms: readonly WalkStop[];
  /** The rider's latest fix; null without one. */
  readonly position: LatLon | null;
  /** Jamie's walking pace, m/s: readWalkingPace().walkMps, from the caller. REQUIRED — never a default. */
  readonly walkMps: number;
  /** mfix9's useWalkTo over those platforms (asked with the platform itself): the walk from the RIDER, routed when Transitous gave one. */
  readonly walk?: WalkTo;
};

/** The ONE place a saved trip's walk is decided (see the module comment); null when nothing tells how far it is. */
export function savedTripWalk(trip: Pick<SavedTrip, 'start' | 'walkOverrideMin'>, input: SavedTripWalkInput): SavedTripWalk | null {
  invariant(Number.isFinite(input.walkMps) && input.walkMps > 0, `a saved trip walks at Jamie's pace, passed in by its caller, got ${String(input.walkMps)} m/s`);
  invariant(trip.walkOverrideMin === null || isWalkOverride(trip.walkOverrideMin), `a trip's own walk is whole minutes, got ${trip.walkOverrideMin}`);
  if (trip.walkOverrideMin !== null) {
    const minutes = trip.walkOverrideMin;
    return { source: 'override', from: 'setting', walkS: minutes * 60, minutes, stopId: null, walkedM: null, straightM: null };
  }
  if (input.position !== null) {
    return measuredWalk(input.position, 'here', input);
  }
  return trip.start === null ? null : measuredWalk(trip.start, 'start', input);
}

/** The walk from `origin` to the boarding platform nearest it: routed when it starts at the rider and mfix9 knows the street walk, else estimated. */
function measuredWalk(origin: LatLon, from: MeasuredWalk['from'], input: SavedTripWalkInput): MeasuredWalk {
  const nearest = nearestStop(origin, input.platforms);
  const street = from === 'here' && input.walk !== undefined ? input.walk(nearest.stop) : null;
  invariant(street === null || (Number.isFinite(street.walkMeters) && street.walkMeters >= 0 && street.detour >= 1), `mfix9's walk to ${nearest.stop.stopId} is a real distance`);
  const routed = street !== null && street.source === 'routed';
  const walkedM = routed ? street.walkMeters * street.detour : nearest.straightM * HURRY_DEFAULTS.detour;
  const walkS = Math.ceil(walkedM / input.walkMps);
  const walk: MeasuredWalk = { source: routed ? 'routed' : 'estimated', from, walkS, minutes: Math.ceil(walkS / 60), stopId: nearest.stop.stopId, walkedM, straightM: nearest.straightM };
  invariant(Number.isSafeInteger(walk.walkS) && walk.walkS >= walkedM / input.walkMps && walk.minutes * 60 >= walk.walkS, 'neither the seconds nor the minutes shown ever understate the walk');
  return walk;
}

/** The stop nearest `origin` in a straight line (a tie keeps the first listed), with the metres to it. */
function nearestStop(origin: LatLon, stops: readonly WalkStop[]): { readonly stop: WalkStop; readonly straightM: number } {
  invariant(isLatLon(origin), 'a walk starts at a real coordinate');
  let nearest: { readonly stop: WalkStop; readonly straightM: number } | null = null;
  for (const stop of stops) {
    const straightM = haversineMeters(origin, stop);
    if (nearest === null || straightM < nearest.straightM) {
      nearest = { stop, straightM };
    }
  }
  invariant(nearest !== null, 'a saved trip has a boarding platform to walk to');
  return nearest;
}

/**
 * A saved trip's boarding platforms: those its `rides` board at, else — no ride to board — every platform of its origin
 * station. The card, the bar's countdown and the reminders walk to the nearest of these (savedTripWalk).
 */
export function boardingPlatforms(platforms: readonly Platform[], fromStationKey: string, rides: readonly Ride[]): readonly Platform[] {
  invariant(fromStationKey.includes(':'), `a trip leaves from a station keyed mode:name, got "${fromStationKey}"`);
  const origin = platforms.filter((platform) => platform.stationKey === fromStationKey);
  const boards = new Set(rides.map((ride) => ride.boardStopId));
  const boarding = origin.filter((platform) => boards.has(platform.stopId));
  invariant(boarding.length === boards.size, `every ride from ${fromStationKey} boards at one of its platforms`);
  return boarding.length > 0 ? boarding : origin;
}
