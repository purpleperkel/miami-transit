import { type ScheduledTrip, type ShapePath, type TripStop, tripProgressAt } from '../../domain/schedule/positions';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { planeOf, toPlane } from './mapGeometry';

/**
 * Live reconciliation (plan §3 "markers glide between updates", §4 "never backward", M5.10). A live
 * vehicle matched to its trip is drawn ON ITS TRACK, as metres along the trip's shape:
 *
 *  - Projection. Between fixes the marker runs on from its last fix at the timetable's pace, keeping
 *    whatever delay the fix showed: the fix is placed on the timetable (the schedule second at which
 *    the trip passes that point), and the clock then advances that schedule second. The projection is
 *    clamped to the NEXT STOP + 20 s — the schedule second 20 s after the trip reaches the first stop
 *    ahead of the fix — so a train whose next fix is late runs into its station, dwells, and waits
 *    there instead of running away down the line on a guess.
 *  - Never backward. When a fresh fix (or the projection) puts the vehicle behind the marker by less
 *    than 50 m, the marker holds still until the projection passes it; it never slides back.
 *  - Snap. A correction of 50 m or more, either way, jumps the marker to the new place at once (50 m
 *    exactly snaps): the old position was wrong, and gliding would only draw a lie for longer.
 *
 * Pure (relative imports only); the frames module (vehicleFrames.ts) runs it once per vehicle per tick.
 */

/** A correction at least this long snaps the marker; anything shorter backward holds it still. */
export const SNAP_DISTANCE_M = 50;
/** The projection may run this long past the schedule's arrival at the next stop ahead of the fix. */
export const PROJECTION_GRACE_S = 20;

/** A live fix placed on its trip's track: metres along the trip's shape, and when it was measured (epoch s). */
export type TrackFix = { readonly distM: number; readonly atS: number };

/** The timetable a live vehicle runs: its trip (service-day seconds, metres along the shape) and that service day's start. */
export type TripTimetable = { readonly trip: ScheduledTrip; readonly baseEpoch: number };

/** How the marker moved: first placement, forward glide, held still (never backward), or a snap. */
export type MarkerMove = 'place' | 'glide' | 'hold' | 'snap';
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
 * Where the vehicle is projected at `nowS`: the fix advanced along the timetable by the time since
 * it was measured, clamped to the next stop ahead of the fix + PROJECTION_GRACE_S (and to the trip's
 * end). A fix at or past the last stop is not projected.
 */
export function projectFix(fix: TrackFix, timetable: TripTimetable, nowS: number): number {
  invariant(Number.isFinite(fix.distM) && Number.isFinite(fix.atS) && Number.isFinite(nowS), 'a projection runs from a fix to an instant');
  const { trip } = timetable;
  const next = trip.stops.find((stop) => stop.distM > fix.distM);
  const elapsedS = Math.max(0, nowS - fix.atS);
  if (next === undefined || elapsedS === 0) {
    return fix.distM;
  }
  const last = trip.stops[trip.stops.length - 1] as TripStop;
  const second = Math.min(scheduleSecondAt(trip, fix.distM) + elapsedS, next.arrS + PROJECTION_GRACE_S, last.depS);
  const progress = tripProgressAt(trip, second);
  invariant(progress !== null, `the projection's schedule second ${second} lies within trip ${trip.tripId}`);
  return Math.max(fix.distM, progress.distM);
}

/** The marker's next place, from where it is drawn now (null: not drawn yet) and the vehicle's latest fix. */
export function reconcileLive(shownM: number | null, fix: TrackFix, timetable: TripTimetable, nowS: number): Reconciled {
  invariant(shownM === null || Number.isFinite(shownM), 'a drawn marker sits at a finite place on its track');
  const targetM = projectFix(fix, timetable, nowS);
  if (shownM === null) {
    return { distM: targetM, move: 'place' };
  }
  const correctionM = targetM - shownM;
  const reconciled: Reconciled =
    Math.abs(correctionM) >= SNAP_DISTANCE_M
      ? { distM: targetM, move: 'snap' }
      : correctionM < 0
        ? { distM: shownM, move: 'hold' }
        : { distM: targetM, move: 'glide' };
  invariant(reconciled.move === 'snap' || reconciled.distM >= shownM, 'a marker moves backward only by snapping');
  return reconciled;
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
