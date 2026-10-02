import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';
import type { LineId } from '@/domain/lines/line-catalog';
import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import type { ScheduledTrip, ShapePath } from '@/domain/schedule/positions';
import { haversineMeters, type LatLon } from '@/lib/geo';

import { layoutTracks, lineSegments, modeOfLine } from '../lineLayout';
import { ZOOM_BUCKETS, type ZoomBucket } from '../mapGeometry';
import { framesInLanes, laneWidthM, markerLanes } from '../markerLanes';
import { placeOnShape } from '../reconcileLive';
import { type FrameTimetable, framesAt, NO_SHOWN, planFrames, type VehicleFrame } from '../vehicleFrames';
import { distanceToLine } from './geo-measure';
import { liveBatch, trackShapeOf, WED, WED_0800 } from './map-fixtures';

/**
 * mfix3 §3, markers in their line's lane, on the network's REAL geometry at station resolution
 * (test-network.ts: line_shape's shapes drawn through their real stops). The drawn lines are what
 * lineSegments draws at each zoom bucket; the markers come from the frames module (planFrames →
 * framesAt, lanes from markerLanes) shifted by framesInLanes, as the Map tab draws them. Trip shapes
 * are the line tracks themselves, one of them run in REVERSE (direction 1), so a lane must hold
 * whichever way a vehicle travels.
 */

const LAID = layoutTracks(TEST_TRACKS);

/** A vehicle to place: the line track it runs (index into TEST_TRACKS), which way, and whether it is a live sighting. */
type Rider = { readonly track: number; readonly reversed: boolean; readonly live: boolean };

/** Where the segment `s` of track `k` is half-way along: a place on that line's track. */
function midSegment(k: number, s: number): LatLon {
  const points = (TEST_TRACKS[k] as (typeof TEST_TRACKS)[number]).points;
  const [a, b] = [points[s] as LatLon, points[s + 1] as LatLon];
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  return { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
}

/** A trip on `shape` (index `idx`) running its whole length at 10 m/s, `atM` metres along it at 08:00. */
function tripThrough(idx: number, lineId: LineId, shape: ShapePath, atM: number): ScheduledTrip {
  const lengthM = shape.distM.at(-1) ?? 0;
  const startS = 28_800 - atM / 10;
  const trip: ScheduledTrip = {
    tripIdx: idx,
    tripId: `lane-trip-${idx}`,
    blockId: `lane-block-${idx}`,
    lineId,
    mode: modeOfLine(lineId),
    directionId: 0,
    shapeIdx: idx,
    stops: [
      { arrS: startS, depS: startS, distM: 0 },
      { arrS: startS + lengthM / 10, depS: startS + lengthM / 10, distM: lengthM },
    ],
  };
  expect(atM).toBeGreaterThan(0);
  expect(atM).toBeLessThan(lengthM);
  return trip;
}

/** A live sighting at `position` on `trip`, measured at 08:00. */
function sighting(trip: ScheduledTrip, position: LatLon): LiveVehicle {
  const vehicle: LiveVehicle = {
    vehicleId: `car-${trip.tripIdx}`,
    label: null,
    tripId: trip.tripId,
    routeId: trip.mode === 'rail' ? '31009' : '14456',
    mode: trip.mode,
    lineId: trip.lineId as LineId,
    lineSource: 'trip',
    directionId: 0,
    position,
    bearing: null,
    speedMps: null,
    stopId: null,
    stopStatus: null,
    timestamp: WED_0800,
  };
  expect(vehicle.tripId).toBe(trip.tripId);
  expect(vehicle.mode).toBe(trip.mode);
  return vehicle;
}

/** Every rider at `place` at 08:00, as frames from planFrames → framesAt (in track order). */
function framesAtPlace(place: LatLon, riders: readonly Rider[]): VehicleFrame[] {
  const shapes = new Map<number, ShapePath>();
  const trips: ScheduledTrip[] = [];
  const fixes: LiveVehicle[] = [];
  for (const [idx, rider] of riders.entries()) {
    const track = TEST_TRACKS[rider.track] as (typeof TEST_TRACKS)[number];
    const shape = trackShapeOf(rider.reversed ? [...track.points].reverse() : track.points);
    const trip = tripThrough(idx, track.lineId, shape, placeOnShape(shape, place, 0).distM);
    shapes.set(idx, shape);
    trips.push(trip);
    if (rider.live) {
      fixes.push(sighting(trip, place));
    }
  }
  const timetable: FrameTimetable = { days: [{ day: WED, trips }], shapes };
  const batch: LiveBatch<LiveVehicle> | null = fixes.length === 0 ? null : liveBatch('transitland', fixes, WED_0800);
  // Fresh lanes per scenario: the shape indices below name different shapes in different scenarios.
  const frames = framesAt(planFrames(timetable, batch, WED_0800, markerLanes(TEST_TRACKS)), WED_0800, NO_SHOWN).frames;
  expect(frames).toHaveLength(riders.length);
  expect(frames.every((frame) => (frame.source === 'live') === riders[Number(frame.key.split('lane-block-')[1])]?.live)).toBe(true);
  return [...frames].sort((a, b) => a.key.localeCompare(b.key));
}

/** Metres from a marker to its own line's drawn polylines at a bucket (the nearest, for a line drawn as two tracks). */
function offOwnLine(marker: VehicleFrame, bucket: ZoomBucket): number {
  const drawn = lineSegments(LAID, bucket).filter((segment) => segment.lineId === marker.lineId);
  expect(drawn.length).toBeGreaterThan(0);
  const metres = Math.min(...drawn.map((segment) => distanceToLine(marker.coordinate, segment.coordinates)));
  expect(Number.isFinite(metres)).toBe(true);
  return metres;
}

/** At every bucket: each marker's distance to its own drawn line, and the two markers' distance apart in lane widths. */
function measured(place: LatLon, riders: readonly Rider[]): { bucket: ZoomBucket; off: number[]; lanesApart: number }[] {
  const frames = framesAtPlace(place, riders);
  const rows = ZOOM_BUCKETS.map((bucket) => {
    const drawn = framesInLanes(frames, bucket);
    const [a, b] = [drawn[0] as VehicleFrame, drawn[drawn.length - 1] as VehicleFrame];
    return { bucket, off: drawn.map((marker) => offOwnLine(marker, bucket)), lanesApart: haversineMeters(a.coordinate, b.coordinate) / laneWidthM(a.lineId, bucket) };
  });
  expect(rows).toHaveLength(ZOOM_BUCKETS.length);
  expect(frames.every((frame) => Number.isFinite(frame.lane))).toBe(true);
  return rows;
}

/** On the rail trunk (Green track segment 15, shared with Orange): Green live northbound-as-drawn, Orange live the other way. */
const TRUNK = midSegment(0, 15);
const TRUNK_RIDERS: readonly Rider[] = [
  { track: 0, reversed: false, live: true },
  { track: 1, reversed: true, live: true },
];

describe('markers in their lane on the rail trunk (mfix3 §3)', () => {
  it('g and o markers at one trunk place are at least 0.9 lane widths apart at every zoom bucket', () => {
    const rows = measured(TRUNK, TRUNK_RIDERS);
    expect(rows.map((row) => [row.bucket, row.lanesApart >= 0.9])).toEqual(ZOOM_BUCKETS.map((bucket) => [bucket, true]));
    expect(framesAtPlace(TRUNK, TRUNK_RIDERS).map((frame) => frame.lineId)).toEqual(['GREEN', 'ORANGE']);
  });

  it('each trunk marker lies within 1 m of its own drawn line at every zoom bucket', () => {
    const rows = measured(TRUNK, TRUNK_RIDERS);
    expect(rows.map((row) => [row.bucket, row.off.every((m) => m < 1)])).toEqual(ZOOM_BUCKETS.map((bucket) => [bucket, true]));
    expect(rows.every((row) => row.off.length === 2)).toBe(true);
  });
});

/**
 * Downtown, on the Mover loop the Inner Loop, Omni and Brickell share in three lanes (Inner Loop track 7,
 * segment 4: Inner Loop one side, Omni in the middle, Brickell the other side).
 */
const LOOP = midSegment(7, 4);

describe('markers in their lane on the Mover loop and on unshared track (mfix3 §3)', () => {
  it('mover markers on shared track sit in their own lanes', () => {
    // An Inner Loop car and an Omni car, scheduled, each running its own track's direction.
    const rows = measured(LOOP, [
      { track: 7, reversed: false, live: false },
      { track: 3, reversed: false, live: false },
    ]);
    expect(rows.map((row) => [row.bucket, row.lanesApart >= 0.9])).toEqual(ZOOM_BUCKETS.map((bucket) => [bucket, true]));
    expect(rows.map((row) => [row.bucket, row.off.every((m) => m < 1)])).toEqual(ZOOM_BUCKETS.map((bucket) => [bucket, true]));
  });

  it('a marker on unshared track lies within 1 m of its own drawn line at every zoom bucket', () => {
    // A Green train toward Palmetto (Green track segment 1), where only Green is drawn, unshifted: a fixed
    // per-line offset (Green always one side) would miss its line here by half a lane at every bucket.
    const rows = measured(midSegment(0, 1), [{ track: 0, reversed: true, live: false }]);
    expect(rows.map((row) => [row.bucket, (row.off[0] as number) < 1])).toEqual(ZOOM_BUCKETS.map((bucket) => [bucket, true]));
    expect(framesAtPlace(midSegment(0, 1), [{ track: 0, reversed: true, live: false }]).map((frame) => frame.lane)).toEqual([0]);
  });
});
