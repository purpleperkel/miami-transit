import { LINE_IDS, type LineId } from '../../domain/lines/line-catalog';
import type { LineTrack, LiveLineId } from '../../domain/live/types';
import type { ShapePath } from '../../domain/schedule/positions';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { CASING_EXTRA_PT, lanesAlongLines, strokeWidthOf } from './lineLayout';
import { bucketMetresPerPoint, fromPlane, planeOf, toPlane, type ZoomBucket } from './mapGeometry';
import type { VehicleFrame } from './vehicleFrames';

/**
 * Markers in their line's lane (mfix3 §3). Where two lines share track the map draws them as parallel
 * lanes (lineLayout.ts), so a marker drawn on the unshifted track sits between the two drawn lines —
 * Green and Orange trains were stacked 0.0 m apart on the trunk. Here each trip SHAPE gets the lane its
 * line is drawn in at every vertex (lineLayout's lanesAlongLines: the lines' own layout, judged against
 * the drawn lines), each frame carries the lane at its place (vehicleFrames.ts), and the Map tab, which
 * knows the zoom bucket, shifts the marker that many lane widths to the right of its heading — the lane
 * width segmentOf draws with: (stroke + casing) × the bucket's metres per point.
 *
 * A shape's lanes are found the first time a vehicle runs on it and kept, by shape index (the
 * schedule's shapes never change while it is open). Pure apart from that cache.
 */

/** The lane of a marker `distM` metres along a trip's shape, by the shape's index, its points and its line. */
export type MarkerLanes = { readonly laneAt: (shapeIdx: number, shape: ShapePath, lineId: string, distM: number) => number };

/** No drawn lines known (no schedule open, or a test of motion alone): every marker in lane 0, on its track. */
export const NO_LANES: MarkerLanes = Object.freeze({ laneAt: noLane });

function noLane(shapeIdx: number, shape: ShapePath): number {
  invariant(Number.isSafeInteger(shapeIdx), 'a shape is indexed');
  invariant(shape.points.length >= 2, 'a shape has a segment');
  return 0;
}

/** The marker lanes for trips run against these drawn lines (the schedule's line tracks, as useLineGeometry lays them). */
export function markerLanes(lines: readonly LineTrack[]): MarkerLanes {
  invariant(lines.length > 0, 'markers take their lanes from drawn lines');
  invariant(lines.every((line) => line.points.length >= 2), 'every drawn line has a segment');
  const byShape = new Map<number, { readonly shape: ShapePath; readonly lanes: readonly number[] }>();
  function laneAt(shapeIdx: number, shape: ShapePath, lineId: string, distM: number): number {
    invariant(Number.isSafeInteger(shapeIdx) && (LINE_IDS as readonly string[]).includes(lineId), `shape ${shapeIdx} belongs to a catalog line, got ${lineId}`);
    const known = byShape.get(shapeIdx);
    // The schedule repo hands out the same ShapePath objects for as long as it is open.
    invariant(known === undefined || known.shape === shape, `shape index ${shapeIdx} names one shape`);
    const laid = known ?? { shape, lanes: shapeLanes(lines, shape, lineId as LineId) };
    byShape.set(shapeIdx, laid);
    return laneAlong(shape, laid.lanes, distM);
  }
  return Object.freeze({ laneAt });
}

/** Each point's lane on one trip shape, laid against the drawn lines. */
function shapeLanes(lines: readonly LineTrack[], shape: ShapePath, lineId: LineId): readonly number[] {
  invariant(shape.points.length >= 2, 'a shape has a segment');
  const [laid] = lanesAlongLines(lines, [{ lineId, points: shape.points }]);
  invariant(laid !== undefined && laid.lanes.length === shape.points.length, 'the shape is laid point by point');
  return Object.freeze([...laid.lanes]);
}

/** The lane `distM` metres along the shape: its segment's two point lanes, interpolated as the drawn line's offsets are. */
export function laneAlong(shape: ShapePath, lanes: readonly number[], distM: number): number {
  const n = shape.points.length;
  invariant(n >= 2 && lanes.length === n && shape.distM.length === n, 'a lane for every point of the shape');
  let [lo, hi] = [0, n - 2];
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((shape.distM[mid] as number) <= distM) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const [fromM, toM] = [shape.distM[lo] as number, shape.distM[lo + 1] as number];
  const t = toM > fromM ? Math.min(1, Math.max(0, (distM - fromM) / (toM - fromM))) : 0;
  const lane = (lanes[lo] as number) + t * ((lanes[lo + 1] as number) - (lanes[lo] as number));
  invariant(Number.isFinite(lane), 'a lane is a finite number of lane widths');
  return lane;
}

/** One lane's width in metres at a zoom bucket: the line's stroke plus its casing, in that bucket's metres per point (as segmentOf draws). */
export function laneWidthM(lineId: LiveLineId, bucket: ZoomBucket): number {
  const metresPerPt = bucketMetresPerPoint(bucket);
  invariant(metresPerPt > 0, 'a bucket has a scale');
  const widthM = (strokeWidthOf(lineId) + CASING_EXTRA_PT) * metresPerPt;
  invariant(widthM > 0, 'a lane has a width');
  return widthM;
}

/** The point `offsetM` metres to the right of travel along `bearing` (degrees from north); negative is to the left. */
export function rightOf(point: LatLon, bearing: number, offsetM: number): LatLon {
  invariant(Number.isFinite(bearing) && Number.isFinite(offsetM), 'a sideways shift has a heading and a distance');
  const plane = planeOf([point]);
  const radians = (bearing * Math.PI) / 180;
  const here = toPlane(plane, point);
  // Travel is (sin θ, cos θ) east/north; its right-hand normal is (cos θ, −sin θ), as offsetPolylineBy uses.
  const shifted = fromPlane(plane, { x: here.x + offsetM * Math.cos(radians), y: here.y - offsetM * Math.sin(radians) });
  const back = toPlane(plane, shifted);
  invariant(Math.abs(Math.hypot(back.x - here.x, back.y - here.y) - Math.abs(offsetM)) < 1e-3, 'the point moved sideways by exactly the offset');
  return shifted;
}

/** The frame drawn in its lane at a zoom bucket: shifted lane × lane width to the right of its heading (unchanged in lane 0). */
export function frameInLane(frame: VehicleFrame, bucket: ZoomBucket): VehicleFrame {
  invariant(Number.isFinite(frame.lane), `vehicle ${frame.key} has a lane`);
  if (frame.lane === 0 || frame.bearing === null) {
    return frame;
  }
  const coordinate = rightOf(frame.coordinate, frame.bearing, frame.lane * laneWidthM(frame.lineId, bucket));
  invariant(coordinate !== frame.coordinate, 'a marker off lane 0 is moved into its lane');
  return { ...frame, coordinate };
}

/** Every frame drawn in its lane at a zoom bucket. */
export function framesInLanes(frames: readonly VehicleFrame[], bucket: ZoomBucket): readonly VehicleFrame[] {
  invariant(Array.isArray(frames), 'a frame is a list of vehicles');
  const laned = frames.map((frame) => frameInLane(frame, bucket));
  invariant(laned.length === frames.length, 'one drawn marker per vehicle');
  return laned;
}
