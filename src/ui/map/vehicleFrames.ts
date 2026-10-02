import { ON_TRACK_M, providerConfig } from '../../domain/live/constants';
import { mergeVehicles, type MergedVehicle } from '../../domain/live/merge';
import { type FeedClock, sightingOf } from '../../domain/live/staleness';
import type { LiveBatch, LiveLineId, LiveVehicle, ProviderId } from '../../domain/live/types';
import type { Mode } from '../../domain/network/stations';
import {
  placeVehicle,
  pointAlongShape,
  type ScheduledTrip,
  type ScheduledVehicle,
  type ServiceDayTrips,
  type ShapePath,
  type VehicleBlock,
  vehicleBlocks,
} from '../../domain/schedule/positions';
import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { LINE_PALETTE } from '../colors';
import { type MarkerLanes, NO_LANES } from './markerLanes';
import { placeOnShape, PROJECTION_MARGIN_S, reconcileTick, type ShownMarker, type TrackFix } from './reconcileLive';
import type { LiveSighting } from './vehicleVisual';

/**
 * The map's moving vehicles (plan §4 "Motion follows the track", M5.10; mfix3 §1–§4), pure. Work is
 * split by cost:
 *
 *   planFrames  once per SAMPLE (every SAMPLE_S, and whenever a new live batch arrives): the
 *               timetable read for the span (ScheduleRepo.timetableAround — the only SQL), the §4 merge
 *               of scheduled and live vehicles (the relative staleness rule drops), and each live fix
 *               placed on its trip's track with its projection clamp (fetchedAt + cadence + 30 s).
 *   framesAt    every frame tick (250 ms): each scheduled vehicle placed on its shape by the timetable
 *               at that very instant, each matched live vehicle reconciled along its track
 *               (reconcileLive.ts: projected, held at a station when the clamp runs out, corrections
 *               eased in, never backward, jumped at 500 m). A vehicle re-matched to its next trip keeps
 *               its drawn place, carried onto the new trip's shape. Every frame carries its lane
 *               (markerLanes.ts) and, for a live one, its sighting against its feed. No SQL.
 *
 * Markers move only by these ticks (no native marker animation between coordinates), so every
 * position drawn lies on the track — shifted into its line's lane by the Map tab, which knows the zoom.
 */

/** A timetable sample spans this long; the span's first instant decides the merge (§4 rules 1–5). */
export const SAMPLE_S = 15;

/** One vehicle as one frame draws it. */
export type VehicleFrame = {
  readonly key: string;
  readonly source: 'live' | 'scheduled';
  readonly mode: Mode;
  readonly lineId: LiveLineId;
  /** On its track (lane 0); the Map tab shifts it into its lane (markerLanes.ts framesInLanes). */
  readonly coordinate: LatLon;
  /** Degrees clockwise from north: along the track where it is on one, else the feed's; null when unknown. */
  readonly bearing: number | null;
  /** Lane widths to the right of its heading that its line is drawn in here; 0 alone on its track, or off any track. */
  readonly lane: number;
  /** The trip it runs (a scheduled vehicle in a layover: the one it runs next), or null when unknown. */
  readonly tripId: string | null;
  /** The live fix at this frame: its provider and age, its feed's age and its lag behind that feed; null for a scheduled vehicle. */
  readonly live: LiveSighting | null;
};

/** The timetable behind a sample: each running service day's trips around the span, and every shape. */
export type FrameTimetable = { readonly days: readonly ServiceDayTrips[]; readonly shapes: ReadonlyMap<number, ShapePath> };

/** A live vehicle on its trip's track: the trip it runs, that trip's day, its shape, its fix on it, and the timetable's own place for it. */
type LiveTrack = { readonly trip: ScheduledTrip; readonly baseEpoch: number; readonly shape: ShapePath; readonly fix: TrackFix; readonly hintM: number };
type PlannedLive = {
  readonly vehicle: MergedVehicle;
  readonly fix: LiveVehicle;
  readonly provider: ProviderId;
  readonly feed: FeedClock;
  readonly track: LiveTrack | null;
};

export type FramePlan = {
  /** The sample's span: frames inside [fromS, toS] reuse this plan. */
  readonly fromS: number;
  readonly toS: number;
  /** The live batch the plan was made from (a new batch means a new plan). */
  readonly batch: LiveBatch<LiveVehicle> | null;
  /** The blocks drawn as scheduled vehicles: not matched to a live one, and of a mode with no fresh feed (§4 rule 5). */
  readonly ghosts: readonly VehicleBlock[];
  readonly live: readonly PlannedLive[];
  readonly shapes: ReadonlyMap<number, ShapePath>;
  readonly lanes: MarkerLanes;
};

/** Where a live vehicle is drawn: on which trip, at which point, and its marker's place on that trip's track (carried frame to frame). */
export type ShownTrack = ShownMarker & { readonly tripIdx: number; readonly point: LatLon };
export type ShownTracks = ReadonlyMap<string, ShownTrack>;
export const NO_SHOWN: ShownTracks = new Map();

const NO_SHAPES: ReadonlyMap<number, ShapePath> = new Map();

/** The plan for the span [fromS, fromS + SAMPLE_S]: the merge at fromS, ghost blocks, live tracks, and the lanes markers take. */
export function planFrames(timetable: FrameTimetable | null, batch: LiveBatch<LiveVehicle> | null, fromS: number, lanes: MarkerLanes = NO_LANES): FramePlan {
  invariant(Number.isSafeInteger(fromS), `a sample starts at a whole epoch second, got ${fromS}`);
  const blocks = timetable === null ? [] : vehicleBlocks(timetable.days);
  const shapes = timetable?.shapes ?? NO_SHAPES;
  const scheduled = blocks.map((block) => placeVehicle(block, fromS, shapes)).filter((v): v is ScheduledVehicle => v !== null);
  const merge = mergeVehicles(scheduled, batch, fromS);
  const matched = new Set(merge.vehicles.filter((v) => v.source === 'live' && v.scheduled !== null).map((v) => v.key));
  const byKey = new Map(blocks.map((block) => [block.vehicleKey, block]));
  const live: PlannedLive[] = [];
  for (const vehicle of merge.vehicles) {
    if (vehicle.source === 'live' && vehicle.live !== null && batch !== null) {
      live.push({ vehicle, fix: vehicle.live, provider: batch.provider, feed: batch, track: trackOf(vehicle, byKey, shapes, projectionUntilS(batch)) });
    }
  }
  const ghosts = blocks.filter((block) => !matched.has(block.vehicleKey) && !merge.freshModes.includes(block.mode));
  invariant(live.length === merge.vehicles.filter((v) => v.source === 'live').length, 'every live vehicle is planned');
  return { fromS, toS: fromS + SAMPLE_S, batch, ghosts, live, shapes, lanes };
}

/**
 * The instant a batch's projections run to: fetchedAt + the provider's cadence + PROJECTION_MARGIN_S —
 * 30 s after the next poll was due (Transitland 90 s, Swiftly 60 s after the fetch). Measured from the
 * FETCH, not the fix: Transitland's fixes are already 35–155 s old when they arrive.
 */
export function projectionUntilS(batch: LiveBatch<LiveVehicle>): number {
  const { cadenceS } = providerConfig(batch.provider);
  invariant(Number.isFinite(batch.fetchedAt) && cadenceS > 0, 'a batch was fetched at an instant, on a cadence');
  const untilS = batch.fetchedAt + cadenceS + PROJECTION_MARGIN_S;
  invariant(untilS > batch.fetchedAt, 'the projection runs past the fetch');
  return untilS;
}

/** A matched live vehicle's track, or null: unmatched, or its fix lies off its trip's shape (> ON_TRACK_M). */
function trackOf(vehicle: MergedVehicle, blocks: ReadonlyMap<string, VehicleBlock>, shapes: ReadonlyMap<number, ShapePath>, untilS: number): LiveTrack | null {
  invariant(vehicle.source === 'live' && vehicle.live !== null, 'only a live vehicle has a fix to place');
  const ghost = vehicle.scheduled;
  const block = ghost === null ? undefined : blocks.get(vehicle.key);
  const trip = ghost === null ? undefined : block?.trips.find((candidate) => candidate.tripIdx === ghost.tripIdx);
  const shape = trip === undefined ? undefined : shapes.get(trip.shapeIdx);
  if (ghost === null || block === undefined || trip === undefined || shape === undefined) {
    return null;
  }
  const onShape = placeOnShape(shape, vehicle.live.position, ghost.distM);
  invariant(onShape.offsetM >= 0 && Number.isFinite(untilS), 'an offset is a distance, and the projection runs to an instant');
  const fix: TrackFix = { distM: onShape.distM, atS: vehicle.live.timestamp, untilS };
  return onShape.offsetM > ON_TRACK_M ? null : { trip, baseEpoch: block.baseEpoch, shape, fix, hintM: ghost.distM };
}

/** Every vehicle at `nowS` (fractions of a second included), and where the live ones are now drawn. */
export function framesAt(plan: FramePlan, nowS: number, shown: ShownTracks): { readonly frames: readonly VehicleFrame[]; readonly shown: ShownTracks } {
  invariant(Number.isFinite(nowS) && nowS >= plan.fromS, 'a frame falls at or after its plan');
  const frames: VehicleFrame[] = [];
  for (const block of plan.ghosts) {
    const vehicle = placeVehicle(block, nowS, plan.shapes);
    if (vehicle !== null) {
      frames.push(ghostFrame(vehicle, plan));
    }
  }
  const nextShown = new Map<string, ShownTrack>();
  for (const planned of plan.live) {
    const drawn = liveFrame(planned, nowS, carried(shown.get(planned.vehicle.key), planned.track), plan.lanes);
    frames.push(drawn.frame);
    if (drawn.shown !== null) {
      nextShown.set(planned.vehicle.key, drawn.shown);
    }
  }
  invariant(new Set(frames.map((frame) => frame.key)).size === frames.length, 'one frame per vehicle');
  return { frames, shown: nextShown };
}

/**
 * The marker's last drawn place, on the track it runs now. On the same trip it is kept as it was. When
 * the plan re-matched the vehicle to another trip (its next one), the drawn point is placed on the NEW
 * trip's shape — the timetable's place for it as the hint, for a loop passing one point twice — so the
 * marker carries on from where it was instead of jumping; a point off that shape starts afresh.
 */
function carried(prior: ShownTrack | undefined, track: LiveTrack | null): ShownMarker | null {
  invariant(prior === undefined || Number.isFinite(prior.distM), 'a drawn marker sits at a finite place');
  if (prior === undefined || track === null) {
    return null;
  }
  if (prior.tripIdx === track.trip.tripIdx) {
    return prior;
  }
  const onShape = placeOnShape(track.shape, prior.point, track.hintM);
  invariant(onShape.offsetM >= 0, 'an offset is a distance');
  return onShape.offsetM > ON_TRACK_M ? null : { distM: onShape.distM, atS: prior.atS, easeUntilS: null };
}

function ghostFrame(vehicle: ScheduledVehicle, plan: FramePlan): VehicleFrame {
  const shape = plan.shapes.get(vehicle.shapeIdx);
  invariant(shape !== undefined, `vehicle ${vehicle.vehicleKey} runs on a known shape`);
  const frame: VehicleFrame = {
    key: vehicle.vehicleKey,
    source: 'scheduled',
    mode: vehicle.mode,
    lineId: liveLineId(vehicle.lineId),
    coordinate: vehicle.position,
    bearing: headingAlong(shape, vehicle.distM),
    lane: plan.lanes.laneAt(vehicle.shapeIdx, shape, vehicle.lineId, vehicle.distM),
    tripId: vehicle.tripId,
    live: null,
  };
  invariant(frame.coordinate === vehicle.position, 'a scheduled vehicle is drawn where the timetable places it');
  return frame;
}

/** A live vehicle's frame: reconciled along its track when it has one, else drawn at its fix (lane 0). */
function liveFrame(planned: PlannedLive, nowS: number, shown: ShownMarker | null, lanes: MarkerLanes): { readonly frame: VehicleFrame; readonly shown: ShownTrack | null } {
  const { vehicle, fix, track } = planned;
  invariant(fix.vehicleId.length > 0, 'a live vehicle has an id');
  const live: LiveSighting = { ...sightingOf(planned.provider, planned.feed, fix.timestamp, nowS), ageS: Math.max(0, nowS - fix.timestamp) };
  const base = { key: vehicle.key, source: 'live' as const, mode: vehicle.mode, lineId: fix.lineId, tripId: vehicle.tripId, live };
  if (track === null) {
    return { frame: { ...base, coordinate: fix.position, bearing: fix.bearing, lane: 0 }, shown: null };
  }
  const tick = reconcileTick(shown, track.fix, { trip: track.trip, baseEpoch: track.baseEpoch }, nowS);
  const coordinate = pointAlongShape(track.shape, tick.distM);
  invariant(tick.move === 'snap' || shown === null || tick.distM >= shown.distM, 'a live marker never slides backward');
  const lane = lanes.laneAt(track.trip.shapeIdx, track.shape, track.trip.lineId, tick.distM);
  const frame: VehicleFrame = { ...base, coordinate, bearing: headingAlong(track.shape, tick.distM), lane };
  return { frame, shown: { distM: tick.distM, atS: tick.atS, easeUntilS: tick.easeUntilS, tripIdx: track.trip.tripIdx, point: coordinate } };
}

/** The direction of travel `distM` metres along the shape: the bearing of the segment it lies on (degrees from north). */
export function headingAlong(shape: ShapePath, distM: number): number {
  const n = shape.points.length;
  invariant(n >= 2 && shape.distM.length === n, 'a shape has points, each with its distance');
  let [lo, hi] = [0, n - 2];
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((shape.distM[mid] as number) <= distM) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const [a, b] = [shape.points[lo] as LatLon, shape.points[lo + 1] as LatLon];
  const east = (b.longitude - a.longitude) * Math.cos((a.latitude * Math.PI) / 180);
  const bearing = ((Math.atan2(east, b.latitude - a.latitude) * 180) / Math.PI + 360) % 360;
  invariant(bearing >= 0 && bearing < 360, 'a bearing is a compass angle');
  return bearing;
}

/** A schedule line id as the palette knows it (the timetable's lines are catalog lines). */
function liveLineId(lineId: string): LiveLineId {
  invariant(lineId.length > 0, 'a vehicle runs a line');
  invariant(Object.hasOwn(LINE_PALETTE, lineId), `"${lineId}" is a line the map can colour`);
  return lineId as LiveLineId;
}
