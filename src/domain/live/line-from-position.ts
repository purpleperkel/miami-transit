import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { lineById, type LineId, linesOfRoute } from '../lines/line-catalog';
import { ON_TRACK_M, TRUNK_LINE_OF_ROUTE } from './constants';
import type { LineSource, LineTrack, LiveLineId, LiveNetwork } from './types';

/**
 * Which line a live vehicle is on (M4.2; arbiter ruling R-c, 2026-10-01). The county feed names a
 * route, not a line: Metrorail 31009 carries Green and Orange, Metromover 14456 carries Omni and
 * Brickell. So, in order:
 *   1. a route with one line (14457, the Inner Loop) is that line;
 *   2. a vehicle whose trip the schedule knows takes its trip's pattern line (the M2.10 derivation);
 *   3. otherwise its POSITION decides: on track only one of the route's lines uses (the Green branch
 *      north of Earlington Heights, the Orange airport branch, the Omni or Brickell loop), that line;
 *      on track both lines share — or off every track — the route's neutral trunk id (RAIL_TRUNK,
 *      MM_TRUNK), because a position cannot tell the two lines apart there. Never the headsign.
 */

export type ResolvedLine = { readonly lineId: LiveLineId; readonly lineSource: LineSource };

const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

/** The line of a vehicle on in-scope `routeId`: by route, else by known trip, else by position. */
export function resolveLine(routeId: string, tripId: string | null, position: LatLon, network: LiveNetwork): ResolvedLine {
  const lines = linesOfRoute(routeId);
  invariant(lines.length > 0, `route ${routeId} carries a catalog line (out-of-scope routes are dropped before this)`);
  invariant(isLatLon(position), 'a vehicle is placed at a coordinate');
  const [only] = lines;
  if (lines.length === 1 && only !== undefined) {
    return { lineId: only.id, lineSource: 'route' };
  }
  const fromTrip = tripLineOnRoute(tripId, routeId, network.lineOfTrip);
  if (fromTrip !== null) {
    return { lineId: fromTrip, lineSource: 'trip' };
  }
  const near = linesNear(routeId, position, network.tracks);
  const trunk = TRUNK_LINE_OF_ROUTE.get(routeId);
  invariant(trunk !== undefined, `route ${routeId} shares track between ${lines.length} lines, so it has a neutral trunk id`);
  return { lineId: near.length === 1 && near[0] !== undefined ? near[0] : trunk, lineSource: 'position' };
}

/** The schedule line of `tripId` when that line runs on `routeId`; null for no trip, an unknown trip or a line elsewhere. */
export function tripLineOnRoute(tripId: string | null, routeId: string, lineOfTrip: LiveNetwork['lineOfTrip']): LineId | null {
  invariant(routeId.length > 0, 'a route id is never empty');
  const line = tripId === null ? null : lineOfTrip(tripId);
  const onRoute = line !== null && lineById(line).routeId === routeId ? line : null;
  invariant(onRoute === null || linesOfRoute(routeId).some((candidate) => candidate.id === onRoute), 'the line runs on the route');
  return onRoute;
}

/** The lines of `routeId` whose track passes within ON_TRACK_M of `point`, in catalog order. */
export function linesNear(routeId: string, point: LatLon, tracks: readonly LineTrack[]): LineId[] {
  invariant(isLatLon(point), 'a position is a coordinate');
  invariant(tracks.every((track) => track.points.length >= 2), 'every track has at least one segment');
  const near = linesOfRoute(routeId)
    .map((line) => line.id)
    .filter((id) => tracks.some((track) => track.lineId === id && distanceToTrackM(point, track.points) <= ON_TRACK_M));
  invariant(near.every((id) => lineById(id).routeId === routeId), 'only the route\'s own lines are candidates');
  return near;
}

/**
 * Metres from `point` to the nearest point of a polyline: per segment, a local planar frame at the
 * segment's start (exact enough over one segment, as in shape-geometry.ts), clamped to the segment.
 */
export function distanceToTrackM(point: LatLon, track: readonly LatLon[]): number {
  invariant(track.length >= 2, 'a track has at least one segment');
  let best = Infinity;
  for (let i = 0; i + 1 < track.length; i += 1) {
    const from = track[i];
    const to = track[i + 1];
    invariant(from !== undefined && to !== undefined, 'segment ends are inside the track');
    const east = Math.cos((from.latitude * Math.PI) / 180) * METRES_PER_DEGREE;
    const [qx, qy] = [(to.longitude - from.longitude) * east, (to.latitude - from.latitude) * METRES_PER_DEGREE];
    const [px, py] = [(point.longitude - from.longitude) * east, (point.latitude - from.latitude) * METRES_PER_DEGREE];
    const lengthSquared = qx * qx + qy * qy;
    const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (px * qx + py * qy) / lengthSquared));
    best = Math.min(best, Math.hypot(px - t * qx, py - t * qy));
  }
  invariant(Number.isFinite(best) && best >= 0, 'a distance to the track is a finite number of metres');
  return best;
}
