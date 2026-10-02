import { LINE_IDS, lineById } from '../../domain/lines/line-catalog';
import type { LiveLineId } from '../../domain/live/types';
import type { StationListing } from '../../data/schedule-queries';
import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { MODE_NAMES, stationLabel, vehicleName } from '../a11y';
import type { LineSegment } from './lineLayout';
import { bucketMetresPerPoint, planeOf, toPlane, type Vec, type ZoomBucket } from './mapGeometry';
import type { VehicleFrame } from './vehicleFrames';
import { MIN_HIT_AREA_PT } from './vehicleVisual';

/**
 * What a tap on the map names (mfix3 §5, Jamie 2026-10-01: "when u click one doesn't show name same with
 * lines"). Pure. Stations and vehicles are markers with their own onPress. Lines are not: on Apple Maps
 * react-native-maps 1.27.2 reports a Polyline press only for the ONE nearest line within 10 px
 * (ios/AirMaps/AIRMapManager.m handleMapTap), so the shared trunk could never name both of its lines —
 * and `tappable` is Google-Maps-only on iOS. So a press on the map itself is hit-tested here against the
 * DRAWN polylines (lane-shifted, as lineSegments draws them at the zoom bucket): every line within the
 * tap tolerance — half a 44 pt hit area, in the bucket's metres per point — is named.
 */

/** A press this close to a drawn line, in points, names it: half the 44 pt minimum hit area. */
export const TAP_TOLERANCE_PT = MIN_HIT_AREA_PT / 2;

/** The tap tolerance in metres at a zoom bucket. */
export function tapToleranceM(bucket: ZoomBucket): number {
  const metres = TAP_TOLERANCE_PT * bucketMetresPerPoint(bucket);
  invariant(TAP_TOLERANCE_PT === 22, 'the tolerance is half a 44 pt hit area');
  invariant(metres > 0, 'a tolerance is a distance');
  return metres;
}

/** Every line drawn within the tap tolerance of `point` at this bucket, in catalog order (none when the press is farther from all). */
export function linesNear(segments: readonly LineSegment[], point: LatLon, bucket: ZoomBucket): LiveLineId[] {
  invariant(isLatLon(point), 'a press lands on a real coordinate');
  const toleranceM = tapToleranceM(bucket);
  const plane = planeOf([point]);
  const near = new Set<LiveLineId>();
  for (const segment of segments) {
    if (!near.has(segment.lineId) && metresToPolyline(segment.coordinates.map((p) => toPlane(plane, p))) <= toleranceM) {
      near.add(segment.lineId);
    }
  }
  const lines = [...near].sort((a, b) => catalogRank(a) - catalogRank(b));
  invariant(lines.length <= segments.length, 'a line is named once');
  return lines;
}

/** A line's place in the catalog (a neutral trunk line after every catalog line). */
function catalogRank(lineId: LiveLineId): number {
  invariant(lineId.length > 0, 'a line is named');
  const rank = (LINE_IDS as readonly string[]).indexOf(lineId);
  invariant(rank >= -1 && rank < LINE_IDS.length, 'a rank is an index or none');
  return rank === -1 ? LINE_IDS.length : rank;
}

/** Metres from the plane's origin (the press) to the nearest point of a polyline in that plane. */
function metresToPolyline(xy: readonly Vec[]): number {
  invariant(xy.length >= 2, 'a drawn line has a segment');
  let best = Infinity;
  for (let i = 1; i < xy.length; i += 1) {
    const [a, b] = [xy[i - 1] as Vec, xy[i] as Vec];
    const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * (b.x - a.x) + a.y * (b.y - a.y)) / lengthSq));
    best = Math.min(best, Math.hypot(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
  }
  invariant(Number.isFinite(best) && best >= 0, 'a polyline is some distance away');
  return best;
}

/** A line as riders name it: "Green Line", "Orange Line"; the Mover's loops as "Metromover Omni". */
export function lineName(lineId: LiveLineId): string {
  invariant(lineId.length > 0, 'a line is named');
  const name =
    lineId === 'RAIL_TRUNK' ? MODE_NAMES.rail : lineId === 'MM_TRUNK' ? MODE_NAMES.mover : lineById(lineId).mode === 'rail' ? lineById(lineId).name : `${MODE_NAMES.mover} ${lineById(lineId).name}`;
  invariant(name.length > 0, 'every line has a name');
  return name;
}

/** "Green Line · Orange Line": every line a press named. */
export function linesCaption(lineIds: readonly LiveLineId[]): string {
  invariant(lineIds.length > 0, 'a caption names at least one line');
  const caption = lineIds.map(lineName).join(' · ');
  invariant(caption.length > 0, 'a caption has words');
  return caption;
}

/** "Government Center, Metrorail" (the name alone is ambiguous: two stations are named Government Center). */
export function stationCaption(station: StationListing): string {
  const caption = stationLabel(station);
  invariant(caption.includes(station.name), 'a station caption names the station');
  invariant(caption.length > station.name.length, 'and its system');
  return caption;
}

/** An age as a caption says it: "40 s ago" under a minute, else "3 min ago". */
export function agoText(ageS: number): string {
  invariant(Number.isFinite(ageS) && ageS >= 0, `an age is a non-negative number of seconds, got ${ageS}`);
  const text = ageS < 60 ? `${Math.floor(ageS)} s ago` : `${Math.floor(ageS / 60)} min ago`;
  invariant(text.endsWith(' ago'), 'an age reads as time ago');
  return text;
}

/**
 * What a tapped vehicle is: its line and kind, where it is going (the station at its trip's last stop),
 * and how it is known — "Green Line train to Dadeland South · live, 40 s ago", or "· timetable estimate"
 * for a scheduled vehicle. A destination the schedule does not know is left out.
 */
export function vehicleCaption(vehicle: VehicleFrame, destination: string | null): string {
  invariant(destination === null || destination.trim().length > 0, 'a destination has a name');
  const what = destination === null ? vehicleName(vehicle.lineId) : `${vehicleName(vehicle.lineId)} to ${destination}`;
  const how = vehicle.live === null ? 'timetable estimate' : `live, ${agoText(vehicle.live.ageS)}`;
  invariant((vehicle.source === 'live') === (vehicle.live !== null), 'a live vehicle carries its sighting, and only a live one does');
  return `${what} · ${how}`;
}

/** What the map's caption shows: the last thing tapped, or a one-line note (e.g. why there is no blue dot). */
export type Caption =
  | { readonly kind: 'station'; readonly stationKey: string }
  | { readonly kind: 'lines'; readonly lineIds: readonly LiveLineId[] }
  | { readonly kind: 'vehicle'; readonly vehicleKey: string }
  | { readonly kind: 'note'; readonly text: string };

/** What the caption reads its words from: the stations, the vehicles of the latest frame, and each trip's destination station. */
export type CaptionSources = {
  readonly stations: readonly StationListing[];
  readonly vehicles: readonly VehicleFrame[];
  readonly tripDestinations: ReadonlyMap<string, string> | undefined;
};

/** The caption's words now — a tapped vehicle's age moves on with every frame — or null when what was tapped is gone. */
export function captionText(caption: Caption, sources: CaptionSources): string | null {
  invariant(typeof caption.kind === 'string', 'a caption has a kind');
  let text: string | null;
  switch (caption.kind) {
    case 'station': {
      const station = sources.stations.find((candidate) => candidate.stationKey === caption.stationKey);
      text = station === undefined ? null : stationCaption(station);
      break;
    }
    case 'lines':
      text = linesCaption(caption.lineIds);
      break;
    case 'vehicle': {
      const vehicle = sources.vehicles.find((candidate) => candidate.key === caption.vehicleKey);
      text = vehicle === undefined ? null : vehicleCaption(vehicle, destinationOf(vehicle, sources));
      break;
    }
    case 'note':
      text = caption.text;
      break;
  }
  invariant(text === null || text.trim().length > 0, 'a caption is never blank');
  return text;
}

/** The name of the station at the end of the vehicle's trip, or null when the schedule does not say. */
function destinationOf(vehicle: VehicleFrame, sources: CaptionSources): string | null {
  invariant(vehicle.key.length > 0, 'a vehicle is keyed');
  const stationKey = vehicle.tripId === null ? undefined : sources.tripDestinations?.get(vehicle.tripId);
  const station = stationKey === undefined ? undefined : sources.stations.find((candidate) => candidate.stationKey === stationKey);
  invariant(station === undefined || station.name.length > 0, 'a destination station has a name');
  return station?.name ?? null;
}
