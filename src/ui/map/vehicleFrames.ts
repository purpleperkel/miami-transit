import { ON_TRACK_M } from '../../domain/live/constants';
import { mergeVehicles, type MergedVehicle } from '../../domain/live/merge';
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
import { placeOnShape, reconcileLive, type TrackFix } from './reconcileLive';

/**
 * The map's moving vehicles (plan §4 "Motion follows the track", M5.10), pure. Work is split by cost:
 *
 *   planFrames  once per SAMPLE (every SAMPLE_S, and whenever a new live batch arrives): the
 *               timetable read for the span (ScheduleRepo.timetableAround — the only SQL), the §4 merge
 *               of scheduled and live vehicles, and each live fix placed on its trip's track.
 *   framesAt    every frame tick (250 ms): each scheduled vehicle placed on its shape by the timetable
 *               at that very instant, each matched live vehicle reconciled along its track
 *               (reconcileLive.ts: projected, never backward under 50 m, snapped at 50 m). No SQL.
 *
 * Markers move only by these ticks (no native marker animation between coordinates), so every
 * position drawn lies on the track.
 */

/** A timetable sample spans this long; the span's first instant decides the merge (§4 rules 1–5). */
export const SAMPLE_S = 15;

/** One vehicle as one frame draws it. */
export type VehicleFrame = {
  readonly key: string;
  readonly source: 'live' | 'scheduled';
  readonly mode: Mode;
  readonly lineId: LiveLineId;
  readonly coordinate: LatLon;
  /** Degrees clockwise from north: along the track where it is on one, else the feed's; null when unknown. */
  readonly bearing: number | null;
  /** The live fix's provider and age at this frame; null for a scheduled vehicle. */
  readonly live: { readonly provider: ProviderId; readonly ageS: number } | null;
};

/** The timetable behind a sample: each running service day's trips around the span, and every shape. */
export type FrameTimetable = { readonly days: readonly ServiceDayTrips[]; readonly shapes: ReadonlyMap<number, ShapePath> };

/** A live vehicle on its trip's track: the trip it runs, that trip's day, its shape and its fix on it. */
type LiveTrack = { readonly trip: ScheduledTrip; readonly baseEpoch: number; readonly shape: ShapePath; readonly fix: TrackFix };
type PlannedLive = { readonly vehicle: MergedVehicle; readonly fix: LiveVehicle; readonly provider: ProviderId; readonly track: LiveTrack | null };

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
};

/** Where each live vehicle is drawn on its track (metres along its trip's shape), carried from frame to frame. */
export type ShownTracks = ReadonlyMap<string, { readonly tripIdx: number; readonly distM: number }>;
export const NO_SHOWN: ShownTracks = new Map();

const NO_SHAPES: ReadonlyMap<number, ShapePath> = new Map();

/** The plan for the span [fromS, fromS + SAMPLE_S]: the merge at fromS, ghost blocks, live tracks. */
export function planFrames(timetable: FrameTimetable | null, batch: LiveBatch<LiveVehicle> | null, fromS: number): FramePlan {
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
      live.push({ vehicle, fix: vehicle.live, provider: batch.provider, track: trackOf(vehicle, byKey, shapes) });
    }
  }
  const ghosts = blocks.filter((block) => !matched.has(block.vehicleKey) && !merge.freshModes.includes(block.mode));
  invariant(live.length === merge.vehicles.filter((v) => v.source === 'live').length, 'every live vehicle is planned');
  return { fromS, toS: fromS + SAMPLE_S, batch, ghosts, live, shapes };
}

/** A matched live vehicle's track, or null: unmatched, or its fix lies off its trip's shape (> ON_TRACK_M). */
function trackOf(vehicle: MergedVehicle, blocks: ReadonlyMap<string, VehicleBlock>, shapes: ReadonlyMap<number, ShapePath>): LiveTrack | null {
  invariant(vehicle.source === 'live' && vehicle.live !== null, 'only a live vehicle has a fix to place');
  const ghost = vehicle.scheduled;
  const block = ghost === null ? undefined : blocks.get(vehicle.key);
  const trip = ghost === null ? undefined : block?.trips.find((candidate) => candidate.tripIdx === ghost.tripIdx);
  const shape = trip === undefined ? undefined : shapes.get(trip.shapeIdx);
  if (ghost === null || block === undefined || trip === undefined || shape === undefined) {
    return null;
  }
  const onShape = placeOnShape(shape, vehicle.live.position, ghost.distM);
  invariant(onShape.offsetM >= 0, 'an offset is a distance');
  return onShape.offsetM > ON_TRACK_M ? null : { trip, baseEpoch: block.baseEpoch, shape, fix: { distM: onShape.distM, atS: vehicle.live.timestamp } };
}

/** Every vehicle at `nowS` (fractions of a second included), and where the live ones are now drawn. */
export function framesAt(plan: FramePlan, nowS: number, shown: ShownTracks): { readonly frames: readonly VehicleFrame[]; readonly shown: ShownTracks } {
  invariant(Number.isFinite(nowS) && nowS >= plan.fromS, 'a frame falls at or after its plan');
  const frames: VehicleFrame[] = [];
  for (const block of plan.ghosts) {
    const vehicle = placeVehicle(block, nowS, plan.shapes);
    if (vehicle !== null) {
      frames.push(ghostFrame(vehicle, plan.shapes));
    }
  }
  const nextShown = new Map<string, { tripIdx: number; distM: number }>();
  for (const planned of plan.live) {
    const prior = shown.get(planned.vehicle.key);
    const frame = liveFrame(planned, nowS, prior !== undefined && prior.tripIdx === planned.track?.trip.tripIdx ? prior.distM : null);
    frames.push(frame.frame);
    if (frame.distM !== null && planned.track !== null) {
      nextShown.set(planned.vehicle.key, { tripIdx: planned.track.trip.tripIdx, distM: frame.distM });
    }
  }
  invariant(new Set(frames.map((frame) => frame.key)).size === frames.length, 'one frame per vehicle');
  return { frames, shown: nextShown };
}

function ghostFrame(vehicle: ScheduledVehicle, shapes: ReadonlyMap<number, ShapePath>): VehicleFrame {
  const shape = shapes.get(vehicle.shapeIdx);
  invariant(shape !== undefined, `vehicle ${vehicle.vehicleKey} runs on a known shape`);
  const frame: VehicleFrame = {
    key: vehicle.vehicleKey,
    source: 'scheduled',
    mode: vehicle.mode,
    lineId: liveLineId(vehicle.lineId),
    coordinate: vehicle.position,
    bearing: headingAlong(shape, vehicle.distM),
    live: null,
  };
  invariant(frame.coordinate === vehicle.position, 'a scheduled vehicle is drawn where the timetable places it');
  return frame;
}

/** A live vehicle's frame: reconciled along its track when it has one, else drawn at its fix. */
function liveFrame(planned: PlannedLive, nowS: number, shownM: number | null): { readonly frame: VehicleFrame; readonly distM: number | null } {
  const { vehicle, fix, track } = planned;
  invariant(fix.vehicleId.length > 0, 'a live vehicle has an id');
  const base = { key: vehicle.key, source: 'live' as const, mode: vehicle.mode, lineId: fix.lineId, live: { provider: planned.provider, ageS: Math.max(0, nowS - fix.timestamp) } };
  if (track === null) {
    return { frame: { ...base, coordinate: fix.position, bearing: fix.bearing }, distM: null };
  }
  const reconciled = reconcileLive(shownM, track.fix, { trip: track.trip, baseEpoch: track.baseEpoch }, nowS);
  const coordinate = pointAlongShape(track.shape, reconciled.distM);
  invariant(reconciled.move === 'snap' || shownM === null || reconciled.distM >= shownM, 'a live marker never slides backward');
  return { frame: { ...base, coordinate, bearing: headingAlong(track.shape, reconciled.distM) }, distM: reconciled.distM };
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
