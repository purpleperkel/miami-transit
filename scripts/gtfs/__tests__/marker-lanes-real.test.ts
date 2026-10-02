import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { LineId } from '../../../src/domain/lines/line-catalog';
import { pointAlongShape, type ShapePath } from '../../../src/domain/schedule/positions';
import type { LatLon } from '../../../src/lib/geo';
import { layoutTracks, lineSegments } from '../../../src/ui/map/lineLayout';
import { planeOf, toPlane, ZOOM_BUCKETS } from '../../../src/ui/map/mapGeometry';
import { laneWidthM, markerLanes, rightOf } from '../../../src/ui/map/markerLanes';
import { placeOnShape } from '../../../src/ui/map/reconcileLive';
import { headingAlong } from '../../../src/ui/map/vehicleFrames';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * mfix3 §3 and §5 on the REAL schedule DB. Markers take their lanes from the drawn lines; here every trunk
 * segment the Green and Orange lines share is checked with the county's full-resolution trip shapes in BOTH
 * directions (direction 1 runs its own shape the other way), at every zoom bucket. And a tapped vehicle's
 * destination (the station of its trip's last stop) is read through ScheduleRepo.tripDestinations.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const tracks = repo.liveNetwork().tracks;
const laid = layoutTracks(tracks);

/** Every trip shape of the schedule, from one timetable read (Wed 2026-09-30 08:00). */
function allShapes(): ReadonlyMap<number, ShapePath> {
  const from = nyEpoch('2026-09-30T08:00-04:00');
  const timetable = repo.timetableAround(from, from + 15);
  assert.equal(timetable.kind, 'timetable');
  assert.ok(timetable.kind === 'timetable' && timetable.shapes.size === 15, 'the schedule has 15 shapes');
  return timetable.kind === 'timetable' ? timetable.shapes : new Map();
}

/** Metres from a point to a polyline, on a plane at the point. */
function metresTo(point: LatLon, line: readonly LatLon[]): number {
  assert.ok(line.length >= 2, 'a drawn line has a segment');
  const plane = planeOf([point]);
  const xy = line.map((p) => toPlane(plane, p));
  let best = Infinity;
  for (let i = 1; i < xy.length; i += 1) {
    const [a, b] = [xy[i - 1] as { x: number; y: number }, xy[i] as { x: number; y: number }];
    const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, -(a.x * (b.x - a.x) + a.y * (b.y - a.y)) / lengthSq));
    best = Math.min(best, Math.hypot(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
  }
  assert.ok(Number.isFinite(best) && best >= 0);
  return best;
}

/** The middle of every Green track segment whose two ends both lie in a shared lane: the trunk, segment by segment. */
function trunkPlaces(): LatLon[] {
  const green = laid.find((track) => track.lineId === 'GREEN');
  assert.ok(green !== undefined);
  const places: LatLon[] = [];
  for (let v = 0; v + 1 < green.points.length; v += 1) {
    if (green.lanes[v] !== 0 && green.lanes[v + 1] === green.lanes[v]) {
      const [a, b] = [green.points[v] as LatLon, green.points[v + 1] as LatLon];
      places.push({ latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 });
    }
  }
  assert.ok(places.length > 100, `the trunk has many shared segments (found ${places.length})`);
  return places;
}

describe('markers in their lane on the real trunk (mfix3 §3)', () => {
  test('green and orange markers in either direction lie on their drawn line at every bucket', () => {
    const shapes = allShapes();
    const lanes = markerLanes(tracks);
    // pattern.shape_idx: Green runs shapes 8 (direction 0) and 12 (direction 1), Orange 7 and 11.
    const runs: readonly (readonly [LineId, number])[] = [['GREEN', 8], ['GREEN', 12], ['ORANGE', 7], ['ORANGE', 11]];
    const worst = ZOOM_BUCKETS.map(() => 0);
    const counted = { onShape: 0, offShape: 0 };
    for (const place of trunkPlaces()) {
      for (const [lineId, shapeIdx] of runs) {
        const shape = shapes.get(shapeIdx) as ShapePath;
        const onShape = placeOnShape(shape, place, 0);
        // At the junction ends of the trunk a shape is already turning off the shared track (inside the 20 m corridor).
        if (onShape.offsetM > 5) {
          counted.offShape += 1;
          continue;
        }
        counted.onShape += 1;
        const lane = lanes.laneAt(shapeIdx, shape, lineId, onShape.distM);
        for (const bucket of ZOOM_BUCKETS) {
          const marker = rightOf(pointAlongShape(shape, onShape.distM), headingAlong(shape, onShape.distM), lane * laneWidthM(lineId, bucket));
          const drawn = lineSegments(laid, bucket).filter((segment) => segment.lineId === lineId);
          worst[bucket] = Math.max(worst[bucket] ?? 0, Math.min(...drawn.map((segment) => metresTo(marker, segment.coordinates))));
        }
      }
    }
    assert.ok(counted.offShape <= 0.02 * (counted.onShape + counted.offShape), `nearly every trunk place lies on every run's shape (${counted.offShape} off)`);
    // Measured 2026-10-01 over 674 markers: 1.89 / 0.37 / 0.06 / 0.00 m — at bucket 0 a lane is 282 m wide.
    assert.ok((worst[0] ?? Infinity) < 2, `bucket 0: within 2 m (worst ${worst[0]} m)`);
    assert.ok(worst.slice(1).every((metres) => metres < 0.5), `buckets 1–3: within 0.5 m (worst ${worst.slice(1).join(', ')} m)`);
  });
});

describe('ScheduleRepo.tripDestinations on the real DB (mfix3 §5)', () => {
  test('every trip runs to the station of its last stop; trip 4829149 runs to Government Center', () => {
    const destinations = repo.tripDestinations();
    assert.equal(destinations.size, db.value('SELECT count(*) FROM trip'));
    assert.equal(destinations.get('4829149'), db.value("SELECT station_key FROM station WHERE name = 'Government Center' AND mode = 1"));
    assert.equal(repo.tripDestinations(), destinations, 'read once, then kept');
  });
});
