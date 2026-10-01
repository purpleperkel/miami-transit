import { Text } from 'react-native';

import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';
import type { LiveLineId } from '@/domain/live/types';
import type { LatLon } from '@/lib/geo';

import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { CASING_EXTRA_PT, type LaidTrack, type LineSegment, layoutTracks, lineSegments, RAIL_STROKE_PT } from '../lineLayout';
import { bucketMetresPerPoint } from '../mapGeometry';
import { useLineGeometry } from '../use-line-geometry';
import { distanceToLine } from './geo-measure';

/**
 * Plan §4 "the shared trunk as parallel offset lines": lanes found on the network's real tracks at
 * station resolution (test-network.ts: line_shape's shapes, drawn through their real stops), then
 * offset at the street zoom bucket. The real DB's full-resolution tracks get the same lanes (Green
 * 171 and Orange 169 shared vertices, measured 2026-10-01).
 */

const LAID = layoutTracks(TEST_TRACKS);
const STREET = lineSegments(LAID, 3);

afterEach(async () => {
  await unmountAll();
});

/** The one laid track (and its drawn segment) of a rail line. */
function railLine(lineId: LiveLineId): { readonly laid: LaidTrack; readonly drawn: LineSegment } {
  const index = LAID.findIndex((track) => track.lineId === lineId);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(LAID.filter((track) => track.lineId === lineId)).toHaveLength(1);
  return { laid: LAID[index] as LaidTrack, drawn: STREET[index] as LineSegment };
}

/** Every vertex lane of a line's tracks. */
function lanesOf(lineId: LiveLineId): number[] {
  const tracks = LAID.filter((track) => track.lineId === lineId);
  expect(tracks.length).toBeGreaterThan(0);
  expect(tracks.every((track) => track.lanes.length === track.points.length)).toBe(true);
  return tracks.flatMap((track) => track.lanes);
}

describe('shared-track lanes (plan §4)', () => {
  it('Green and Orange share the rail trunk as two lanes, either side of the track', () => {
    const green = railLine('GREEN');
    const orange = railLine('ORANGE');
    // Palmetto and the airport are each one line's own; both run on to Dadeland South side by side.
    expect([green.laid.lanes[0], green.laid.lanes.at(-1), orange.laid.lanes[0], orange.laid.lanes.at(-1)]).toEqual([0, -0.5, 0, 0.5]);
    const laneM = (RAIL_STROKE_PT + CASING_EXTRA_PT) * bucketMetresPerPoint(3);
    const shared = green.laid.points.slice(-6, -1);
    for (const station of shared) {
      const sides = [distanceToLine(station, green.drawn.coordinates), distanceToLine(station, orange.drawn.coordinates)];
      expect(sides.map((m) => Math.abs(m - laneM / 2) < 0.05 * laneM)).toEqual([true, true]);
    }
    // Opposite sides: the two drawn lines are a whole lane apart, so their casings touch.
    const apart = green.drawn.coordinates.slice(-5, -1).map((p) => distanceToLine(p, orange.drawn.coordinates));
    expect(apart.every((m) => Math.abs(m - laneM) < 0.1 * laneM)).toBe(true);
  });

  it('a line on its own track is drawn on it, at every zoom', () => {
    expect(LAID.map((track) => track.lineId)).toEqual(TEST_TRACKS.map((track) => track.lineId));
    for (const bucket of [0, 1, 2, 3] as const) {
      const drawn = lineSegments(LAID, bucket);
      for (const lineId of ['GREEN', 'ORANGE'] as const) {
        const index = LAID.findIndex((track) => track.lineId === lineId);
        const ownEnd = LAID[index]?.points[0] as LatLon;
        expect([lineId, bucket, distanceToLine(ownEnd, (drawn[index] as LineSegment).coordinates) < 0.01]).toEqual([lineId, bucket, true]);
      }
    }
  });

  it('the downtown loop carries the Inner Loop, Omni and Brickell in three lanes, Omni in the middle', () => {
    expect(lanesOf('MM_INNER').some((lane) => Math.abs(lane) === 1)).toBe(true);
    expect(lanesOf('MM_BRICKELL').some((lane) => Math.abs(lane) === 1)).toBe(true);
    expect(lanesOf('MM_OMNI').every((lane) => Math.abs(lane) <= 0.5)).toBe(true);
  });
});

describe('useLineGeometry (M5.7)', () => {
  it('draws no lines while the schedule DB is still opening', async () => {
    const seen: (readonly LineSegment[] | null)[] = [];
    function LinesProbe() {
      const lines = useLineGeometry(2);
      seen.push(lines);
      expect(seen.length).toBeGreaterThan(0);
      expect(lines === null || Array.isArray(lines)).toBe(true);
      return <Text>{lines === null ? 'no lines' : `${lines.length} lines`}</Text>;
    }
    const tree = await renderPrimitive(<LinesProbe />);
    expect(seen.every((lines) => lines === null)).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain('no lines');
  });
});
