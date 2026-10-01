import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { LineId } from '../../../src/domain/lines/line-catalog';
import { haversineMeters } from '../../../src/lib/geo';
import { CASING_EXTRA_PT, type LaidTrack, layoutTracks, lineSegments, strokeWidthOf } from '../../../src/ui/map/lineLayout';
import { bucketMetresPerPoint, ZOOM_BUCKETS } from '../../../src/ui/map/mapGeometry';
import { openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * Plan §4 "the shared trunk as parallel offset lines", on the REAL schedule DB's full-resolution
 * tracks (the ones useLineGeometry reads through ScheduleRepo.liveNetwork): the corridor radius and
 * the alongside angle in src/ui/map/lineLayout.ts are checked against the county's own shapes here.
 */

const db = openRealScheduleDb();
after(() => db.close());
const tracks = openRealRepo(db).liveNetwork().tracks;
const laid = layoutTracks(tracks);

/** Every vertex lane of a line's tracks. */
function lanesOf(lineId: LineId): number[] {
  const own = laid.filter((track) => track.lineId === lineId);
  assert.ok(own.length > 0, `${lineId} has a track`);
  assert.ok(own.every((track) => track.lanes.length === track.points.length));
  return own.flatMap((track) => track.lanes);
}

/** The one track of a rail line (line_shape keeps its longest direction-0 shape). */
function railTrack(lineId: 'GREEN' | 'ORANGE'): LaidTrack {
  const own = laid.filter((track) => track.lineId === lineId);
  assert.equal(own.length, 1);
  assert.ok(own[0] !== undefined && own[0].points.length > 100);
  return own[0];
}

describe('shared-track lanes on the real schedule DB (plan §4)', () => {
  test('Green and Orange run the trunk as two lanes; Palmetto and the airport branch keep their own track', () => {
    const green = railTrack('GREEN');
    const orange = railTrack('ORANGE');
    const greenShared = green.lanes.filter((lane) => lane !== 0);
    const orangeShared = orange.lanes.filter((lane) => lane !== 0);
    assert.ok(greenShared.length > 150 && orangeShared.length > 150, `trunk vertices: Green ${greenShared.length}, Orange ${orangeShared.length}`);
    assert.deepEqual([...new Set(greenShared)], [-0.5]);
    assert.deepEqual([...new Set(orangeShared)], [0.5]);
    assert.deepEqual([green.lanes[0], orange.lanes[0], green.lanes.at(-1), orange.lanes.at(-1)], [0, 0, -0.5, 0.5]);
  });

  test('the downtown loop carries the Inner Loop, Omni and Brickell side by side', () => {
    assert.ok(lanesOf('MM_INNER').some((lane) => Math.abs(lane) === 1), 'the Inner Loop takes an outer lane of three');
    assert.ok(lanesOf('MM_BRICKELL').some((lane) => Math.abs(lane) === 1), 'Brickell takes the other outer lane');
    assert.ok(lanesOf('MM_OMNI').some((lane) => Math.abs(lane) === 0.5), 'Omni pairs with Brickell where only they share');
    assert.ok(lanesOf('MM_OMNI').every((lane) => Math.abs(lane) <= 0.5), 'Omni is never an outer lane of three');
  });

  test('at every zoom, each drawn vertex stays within its lane of the real track', () => {
    for (const bucket of ZOOM_BUCKETS) {
      const segments = lineSegments(laid, bucket);
      assert.equal(segments.length, laid.length);
      for (const [t, segment] of segments.entries()) {
        const track = laid[t] as LaidTrack;
        // The farthest a vertex may sit: its widest lane, plus 10 % for mitres and 1 m for the vertex-to-vertex measure.
        const widestM = Math.max(...track.lanes.map(Math.abs)) * (strokeWidthOf(track.lineId) + CASING_EXTRA_PT) * bucketMetresPerPoint(bucket);
        const farthest = Math.max(...segment.coordinates.map((p) => Math.min(...track.points.map((q) => haversineMeters(p, q)))));
        assert.ok(farthest <= widestM * 1.1 + 1, `${segment.id} at bucket ${bucket}: ${farthest.toFixed(1)} m from its track (lane ${widestM.toFixed(1)} m)`);
      }
    }
  });
});
