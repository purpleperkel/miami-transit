import { type ScheduledTrip, type ShapePath, type TripStop, tripProgressAt } from '../../domain/schedule/positions';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { planeOf, toPlane } from './mapGeometry';

/**
 * Live reconciliation (plan §3 "markers glide between updates", §4 "never backward", M5.10; reworked by
 * mfix3 §1–§2 from Jamie's 2026-10-01 screen recording). A live vehicle matched to its trip is drawn ON
 * ITS TRACK, as metres along the trip's shape:
 *
 *  - Projection. Between fixes the marker runs on from its last fix at the timetable's pace, keeping
 *    whatever delay the fix showed: the fix is placed on the timetable (the schedule second at which
 *    the trip passes that point), and the clock then advances that schedule second.
 *  - Time-based clamp. The projection runs until the fix's `untilS` — the batch's fetchedAt + the
 *    provider's cadence + PROJECTION_MARGIN_S (30 s after the next poll was due), measured from the
 *    FETCH, because Transitland's fixes are already 35–155 s old when fetched. It never ends mid-track:
 *    it goes no further than the last stop the timetable reaches at or before that instant (or the fix
 *    itself when it reaches none), so a train whose next fix is late waits AT a station.
 *  - Corrections. A gap under SNAP_DISTANCE_M (50 m) between the drawn marker and the projection is
 *    closed at once (a vehicle's own advance per frame tick). A larger forward gap is a correction,
 *    eased in over EASE_S frame tick by frame tick (reconcileTick); a backward one (never backward)
 *    holds the marker until the projection passes it; JUMP_DISTANCE_M (500 m) or more, either way,
 *    jumps it at once — the old place was wrong, and gliding would only draw a lie for longer.
 *
 * Pure (relative imports only); the frames module (vehicleFrames.ts) runs it once per vehicle per tick.
 */

/** A gap shorter than this is closed at once; at least this long it is a correction (eased forward, held backward). */
export const SNAP_DISTANCE_M = 50;
/** A correction this long or longer, either way, jumps the marker at once. */
export const JUMP_DISTANCE_M = 500;
/** A forward correction is eased in over this long. */
export const EASE_S = 1;
/** The projection runs until this long after the next poll was due (fetchedAt + cadence + this). */
export const PROJECTION_MARGIN_S = 30;

/**
 * A live fix placed on its trip's track: metres along the trip's shape, when it was measured (epoch s),
 * and the instant its projection may run to (fetchedAt + cadence + PROJECTION_MARGIN_S). A fix with no
 * `untilS` — no poll behind it — projects to the end of its trip.
 */
export type TrackFix = { readonly distM: number; readonly atS: number; readonly untilS?: number };

/** The timetable a live vehicle runs: its trip (service-day seconds, metres along the shape) and that service day's start. */
export type TripTimetable = { readonly trip: ScheduledTrip; readonly baseEpoch: number };

/** How the marker moved: first placement, forward glide, held still (never backward), eased in, or snapped. */
export type MarkerMove = 'place' | 'glide' | 'hold' | 'ease' | 'snap';
export type Reconciled = { readonly distM: number; readonly move: MarkerMove };

/** The schedule second at which the trip passes `distM` metres along its shape (a stop: the moment it arrives). */
export function scheduleSecondAt(trip: ScheduledTrip, distM: number): number {
  const stops = trip.stops;
  invariant(stops.length >= 2 && Number.isFinite(distM), `trip ${trip.tripId} has stops, and a place on it is a number`);
  const first = stops[0] as TripStop;
  const last = stops[stops.length - 1] as TripStop;
  const d = Math.min(last.distM, Math.max(first.distM, distM));
  let i = 0;
  while (i + 1 < stops.length && (stops[i + 1] as TripStop).distM <= d) {
    i += 1;
  }
  const stop = stops[i] as TripStop;
  const next = stops[i + 1];
  const second =
    d === stop.distM || next === undefined ? stop.arrS : stop.depS + ((d - stop.distM) / (next.distM - stop.distM)) * (next.arrS - stop.depS);
  invariant(second >= first.arrS && second <= last.depS, `the schedule second ${second} lies within trip ${trip.tripId}`);
  return second;
}

/**
 * The farthest place the projection may reach: the last stop at or ahead of the fix that the timetable
 * reaches (arrives at) by schedule second `untilSecond` — or the fix itself when it reaches none.
 */
export function projectionLimitM(trip: ScheduledTrip, fixM: number, untilSecond: number): number {
  invariant(Number.isFinite(fixM) && !Number.isNaN(untilSecond), 'a limit is found from a place and a schedule second');
  let limitM = fixM;
  for (const stop of trip.stops) {
    if (stop.distM >= fixM && stop.arrS <= untilSecond) {
      limitM = stop.distM;
    }
  }
  invariant(limitM >= fixM, 'the limit never lies behind the fix');
  return limitM;
}

/**
 * Where the vehicle is projected at `nowS`: the fix advanced along the timetable by the time since it
 * was measured, up to the projection limit (projectionLimitM at the fix's untilS) and the trip's end.
 */
export function projectFix(fix: TrackFix, timetable: TripTimetable, nowS: number): number {
  invariant(Number.isFinite(fix.distM) && Number.isFinite(fix.atS) && Number.isFinite(nowS), 'a projection runs from a fix to an instant');
  const { trip } = timetable;
  const last = trip.stops[trip.stops.length - 1] as TripStop;
  const elapsedS = Math.max(0, nowS - fix.atS);
  if (fix.distM >= last.distM || elapsedS === 0) {
    return fix.distM;
  }
  const fromSecond = scheduleSecondAt(trip, fix.distM);
  const untilSecond = fix.untilS === undefined ? last.depS : fromSecond + Math.max(0, fix.untilS - fix.atS);
  const progress = tripProgressAt(trip, Math.min(fromSecond + elapsedS, last.depS));
  invariant(progress !== null, `the projection's schedule second lies within trip ${trip.tripId}`);
  return Math.max(fix.distM, Math.min(progress.distM, projectionLimitM(trip, fix.distM, untilSecond)));
}

/**
 * The marker's next place, from where it is drawn now (null: not drawn yet) and the vehicle's latest
 * fix — the instant rule. A forward correction comes back as `ease` with the target to ease toward;
 * reconcileTick does the easing.
 */
export function reconcileLive(shownM: number | null, fix: TrackFix, timetable: TripTimetable, nowS: number): Reconciled {
  invariant(shownM === null || Number.isFinite(shownM), 'a drawn marker sits at a finite place on its track');
  const targetM = projectFix(fix, timetable, nowS);
  if (shownM === null) {
    return { distM: targetM, move: 'place' };
  }
  const correctionM = targetM - shownM;
  const reconciled: Reconciled =
    Math.abs(correctionM) >= JUMP_DISTANCE_M
      ? { distM: targetM, move: 'snap' }
      : correctionM < 0
        ? { distM: shownM, move: 'hold' }
        : correctionM < SNAP_DISTANCE_M
          ? { distM: targetM, move: 'glide' }
          : { distM: targetM, move: 'ease' };
  invariant(reconciled.move === 'snap' || reconciled.distM >= shownM, 'a marker moves backward only by snapping');
  return reconciled;
}

/** A marker as the frames carry it from tick to tick: its place on its track, the tick it was drawn at, and when an ease in progress ends. */
export type ShownMarker = { readonly distM: number; readonly atS: number; readonly easeUntilS: number | null };

/**
 * The marker at `nowS`, eased: reconcileLive's instant rule, with a forward correction closed over
 * EASE_S — each tick closes the share of the remaining gap that the tick's time is of the ease's
 * remaining time, so the marker reaches the (moving) projection exactly when the ease ends. A hold or
 * a snap ends an ease; a 5 s Reduce Motion tick finishes one at once.
 */
export function reconcileTick(shown: ShownMarker | null, fix: TrackFix, timetable: TripTimetable, nowS: number): ShownMarker & { readonly move: MarkerMove } {
  invariant(shown === null || (Number.isFinite(shown.atS) && Number.isFinite(shown.distM)), 'a drawn marker was drawn at an instant and a place');
  const instant = reconcileLive(shown?.distM ?? null, fix, timetable, nowS);
  const easing = shown !== null && shown.easeUntilS !== null && (instant.move === 'ease' || instant.move === 'glide');
  if (shown === null || (instant.move !== 'ease' && !easing)) {
    return { distM: instant.distM, atS: nowS, easeUntilS: null, move: instant.move };
  }
  const untilS = shown.easeUntilS ?? shown.atS + EASE_S;
  const fraction = untilS <= shown.atS ? 1 : Math.min(1, Math.max(0, (nowS - shown.atS) / (untilS - shown.atS)));
  const distM = shown.distM + (instant.distM - shown.distM) * fraction;
  invariant(distM >= shown.distM, 'an ease only ever moves the marker forward');
  return { distM, atS: nowS, easeUntilS: fraction >= 1 ? null : untilS, move: fraction >= 1 ? instant.move : 'ease' };
}

/** A position placed on a shape: metres along it, and how far off the shape the position lies. */
export type OnShape = { readonly distM: number; readonly offsetM: number };

/**
 * Two parts of a shape about equally near a position (offsets within 1 m) yet far apart along it
 * (over 20 m: a loop passing the same place twice, not two segments meeting at a vertex) are told
 * apart by the hint; otherwise the nearer part wins.
 */
const SAME_OFFSET_M = 1;
const OTHER_PASS_M = 20;

/**
 * `position` placed on `shape`: the nearest point of the shape, measured along it. Where two parts of
 * the shape lie about equally near (a loop passing the same place twice), the one nearer `hintM` —
 * the timetable's own place for the vehicle — wins.
 */
export function placeOnShape(shape: ShapePath, position: LatLon, hintM: number): OnShape {
  invariant(shape.points.length >= 2 && shape.distM.length === shape.points.length, 'a shape has points, each with its distance');
  invariant(Number.isFinite(hintM), 'the hint is a place along the shape');
  const plane = planeOf(shape.points);
  const p = toPlane(plane, position);
  let best: OnShape | null = null;
  let a = toPlane(plane, shape.points[0] as LatLon);
  for (let k = 1; k < shape.points.length; k += 1) {
    const b = toPlane(plane, shape.points[k] as LatLon);
    const length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length2));
    const offsetM = Math.hypot(a.x + t * (b.x - a.x) - p.x, a.y + t * (b.y - a.y) - p.y);
    const from = shape.distM[k - 1] as number;
    const candidate = { distM: from + t * ((shape.distM[k] as number) - from), offsetM };
    if (best === null || closer(candidate, best, hintM)) {
      best = candidate;
    }
    a = b;
  }
  invariant(best !== null && best.offsetM >= 0, 'every shape has a nearest point');
  return best;
}

/** Whether `a` beats `b`: nearer the position — unless both are as near on two passes of a loop, where the one nearer the hint wins. */
function closer(a: OnShape, b: OnShape, hintM: number): boolean {
  invariant(a.offsetM >= 0 && b.offsetM >= 0, 'offsets are distances');
  invariant(Number.isFinite(hintM), 'the hint is finite');
  const twoPasses = Math.abs(a.offsetM - b.offsetM) <= SAME_OFFSET_M && Math.abs(a.distM - b.distM) > OTHER_PASS_M;
  return twoPasses ? Math.abs(a.distM - hintM) < Math.abs(b.distM - hintM) : a.offsetM < b.offsetM;
}
