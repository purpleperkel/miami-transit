import { LINE_IDS, type LineId, lineById } from '../../domain/lines/line-catalog';
import type { LineTrack, LiveLineId } from '../../domain/live/types';
import type { Mode } from '../../domain/network/stations';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { bucketMetresPerPoint, offsetPolylineBy, planeOf, toPlane, type Vec, type ZoomBucket } from './mapGeometry';

/**
 * How the lines are laid out on the map (plan §4 "Lines"): each line is a casing under a stroke —
 * rail 5 pt, Mover 3.5 pt, the casing 3 pt wider — and where two lines run on the same track (Green
 * and Orange on the rail trunk; Omni, Brickell and the Inner Loop around downtown) they are drawn as
 * parallel lanes, side by side, instead of one on top of the other.
 *
 * Lanes are found once per schedule (layoutTracks); each zoom bucket then turns them into drawn
 * segments (lineSegments), spacing the lanes so their casings touch at that bucket's scale. Pure, with
 * relative imports only.
 */

export const RAIL_STROKE_PT = 5;
export const MOVER_STROKE_PT = 3.5;
/** The casing is this much wider than its stroke: 1.5 pt of edge on each side. */
export const CASING_EXTRA_PT = 3;

/** Two lines' tracks closer than this, running alongside each other, are one shared corridor. */
export const SHARED_TRACK_RADIUS_M = 20;
/** Tracks within 25° of parallel (either way) run alongside; a crossing does not make a corridor. */
const ALONGSIDE_COS = Math.cos((25 * Math.PI) / 180);

/** A track with each vertex's lane: 0 alone; with n lines alongside, rank − (n − 1) / 2 lane widths to the right of travel. */
export type LaidTrack = { readonly lineId: LineId; readonly points: readonly LatLon[]; readonly lanes: readonly number[] };

/** One line's track as drawn: its (possibly offset) coordinates, and whether it is dimmed. */
export type LineSegment = { readonly id: string; readonly lineId: LiveLineId; readonly coordinates: readonly LatLon[]; readonly dimmed: boolean };

type ProjectedTrack = { readonly lineId: LineId; readonly mode: Mode; readonly xy: readonly Vec[] };

const NO_LINES: ReadonlySet<LiveLineId> = new Set();

/** Rail for Green, Orange and the neutral rail trunk; the Mover for the rest. */
export function modeOfLine(lineId: LiveLineId): Mode {
  invariant(typeof lineId === 'string' && lineId.length > 0, 'a line id is named');
  const mode: Mode = lineId === 'RAIL_TRUNK' ? 'rail' : lineId === 'MM_TRUNK' ? 'mover' : lineById(lineId).mode;
  invariant(mode === 'rail' || mode === 'mover', `${lineId} runs on rail or the Mover`);
  return mode;
}

/** The stroke width of a line, in points (plan §4: rail 5, Mover 3.5). */
export function strokeWidthOf(lineId: LiveLineId): number {
  const width = modeOfLine(lineId) === 'rail' ? RAIL_STROKE_PT : MOVER_STROKE_PT;
  invariant(width > 0, 'a line has a visible stroke');
  invariant(width + CASING_EXTRA_PT > width, 'the casing is wider than the stroke');
  return width;
}

/** Every track with the lane of each vertex. */
export function layoutTracks(tracks: readonly LineTrack[]): LaidTrack[] {
  invariant(tracks.length > 0 && tracks.every((track) => track.points.length >= 2), 'every track has at least one segment');
  const plane = planeOf(tracks.flatMap((track) => track.points));
  const projected: ProjectedTrack[] = tracks.map((track) => ({
    lineId: track.lineId,
    mode: modeOfLine(track.lineId),
    xy: track.points.map((point) => toPlane(plane, point)),
  }));
  const laid = tracks.map((track, t) => ({ lineId: track.lineId, points: track.points, lanes: track.points.map((_, i) => laneAt(projected, t, i)) }));
  invariant(laid.every((track) => track.lanes.every(Number.isFinite)), 'every vertex has a lane');
  return laid;
}

/**
 * Vertex i of track t: which lines run alongside it there, and its lane among them. Lines are ranked
 * in catalog order; the lane is measured to the right of the first-ranked line's travel, as read off
 * that line's FIRST track near the vertex, so every line in the corridor shares one frame whichever
 * way each of its tracks runs.
 */
function laneAt(tracks: readonly ProjectedTrack[], t: number, i: number): number {
  const self = tracks[t];
  invariant(self !== undefined && self.xy[i] !== undefined, `track ${t} has vertex ${i}`);
  const here = self.xy[i] as Vec;
  const dir = directionAt(self.xy, i);
  const alongside = new Map<LineId, Vec>();
  for (const other of tracks) {
    const near = other.mode === self.mode && !alongside.has(other.lineId) ? segmentAlongside(other.xy, here, dir) : null;
    if (near !== null) {
      alongside.set(other.lineId, near);
    }
  }
  const lines = [...alongside.keys()].sort((a, b) => LINE_IDS.indexOf(a) - LINE_IDS.indexOf(b));
  invariant(lines.includes(self.lineId), 'a track runs alongside itself');
  const reference = alongside.get(lines[0] as LineId) as Vec;
  const sign = reference.x * dir.x + reference.y * dir.y >= 0 ? 1 : -1;
  return lines.length === 1 ? 0 : sign * (lines.indexOf(self.lineId) - (lines.length - 1) / 2);
}

/** The unit direction of travel at vertex i: toward the next distinct point (at the end, from the previous one). */
function directionAt(xy: readonly Vec[], i: number): Vec {
  const p = xy[i];
  invariant(p !== undefined, `vertex ${i} is on the track`);
  const ahead = xy.slice(i + 1).find((q) => q.x !== p.x || q.y !== p.y);
  const [from, to] = ahead !== undefined ? [p, ahead] : [xy.slice(0, i).reverse().find((q) => q.x !== p.x || q.y !== p.y), p];
  invariant(from !== undefined, 'a track has two distinct points');
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/**
 * The direction of the track's nearest segment that runs alongside `dir` within SHARED_TRACK_RADIUS_M
 * of p, or null when none does. (At a corner the nearest segment may be the other leg; only a segment
 * running the same way, or the opposite way, counts.)
 */
function segmentAlongside(xy: readonly Vec[], p: Vec, dir: Vec): Vec | null {
  invariant(xy.length >= 2, 'a track has a segment');
  let best: { distanceM: number; dir: Vec } | null = null;
  for (let s = 1; s < xy.length; s += 1) {
    const a = xy[s - 1] as Vec;
    const b = xy[s] as Vec;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const unit = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    if (length === 0 || Math.abs(unit.x * dir.x + unit.y * dir.y) < ALONGSIDE_COS) {
      continue;
    }
    const along = Math.min(length, Math.max(0, (p.x - a.x) * unit.x + (p.y - a.y) * unit.y));
    const distanceM = Math.hypot(a.x + along * unit.x - p.x, a.y + along * unit.y - p.y);
    if (distanceM <= SHARED_TRACK_RADIUS_M && (best === null || distanceM < best.distanceM)) {
      best = { distanceM, dir: unit };
    }
  }
  invariant(best === null || best.distanceM <= SHARED_TRACK_RADIUS_M, 'a segment alongside lies within the corridor radius');
  return best === null ? null : best.dir;
}

/** The tracks as drawn at one zoom bucket: lanes spaced so neighbouring casings touch; `dimmed` lines marked. */
export function lineSegments(laid: readonly LaidTrack[], bucket: ZoomBucket, dimmed: ReadonlySet<LiveLineId> = NO_LINES): LineSegment[] {
  const metresPerPt = bucketMetresPerPoint(bucket);
  invariant(metresPerPt > 0, 'a bucket has a scale');
  const segments = laid.map((track, index) => segmentOf(track, `${track.lineId}:${index}`, metresPerPt, dimmed.has(track.lineId)));
  invariant(new Set(segments.map((segment) => segment.id)).size === segments.length, 'every segment has its own id');
  return segments;
}

function segmentOf(track: LaidTrack, id: string, metresPerPt: number, dimmed: boolean): LineSegment {
  invariant(track.lanes.length === track.points.length, 'one lane per vertex');
  const laneM = (strokeWidthOf(track.lineId) + CASING_EXTRA_PT) * metresPerPt;
  const shared = track.lanes.some((lane) => lane !== 0);
  const coordinates = shared ? offsetPolylineBy(track.points, track.lanes.map((lane) => lane * laneM)) : track.points;
  invariant(coordinates.length >= 2, 'a drawn line has at least one segment');
  return { id, lineId: track.lineId, coordinates, dimmed };
}
