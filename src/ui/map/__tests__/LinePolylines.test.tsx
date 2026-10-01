import type { ReactTestInstance } from 'react-test-renderer';

import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';

import { lineColors } from '../../colors';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { CASING_EXTRA_PT, type LineSegment, layoutTracks, lineSegments, MOVER_STROKE_PT, RAIL_STROKE_PT } from '../lineLayout';
import { DIMMED_ALPHA, LinePolylines } from '../LinePolylines';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, Polyline: 'Polyline' }));

/**
 * M5.7 LinePolylines: react-native-maps' Polyline is a native MapKit overlay, so it is mocked as a
 * host element of that name and the props each one receives are read back. The segments are the
 * network's real tracks at station resolution (test-network.ts), laid out in lanes and offset at the
 * downtown zoom bucket.
 */

const SEGMENTS = lineSegments(layoutTracks(TEST_TRACKS), 2);
const MOVER_DIMMED = lineSegments(layoutTracks(TEST_TRACKS), 2, new Set(['MM_INNER', 'MM_OMNI', 'MM_BRICKELL']));

afterEach(async () => {
  await unmountAll();
});

/** Every Polyline drawn for these segments, in drawing order. */
async function drawn(segments: readonly LineSegment[]): Promise<ReactTestInstance[]> {
  const tree = await renderPrimitive(<LinePolylines segments={segments} scheme="light" />);
  const polylines = tree.root.findAllByType('Polyline' as never);
  expect(polylines.length).toBeGreaterThan(0);
  expect(polylines.every((polyline) => Array.isArray(polyline.props.coordinates))).toBe(true);
  return polylines;
}

/** The casing (wider) and stroke drawn for one segment: the two polylines with its coordinates. */
function pairOf(polylines: readonly ReactTestInstance[], segment: LineSegment): { casing: ReactTestInstance; stroke: ReactTestInstance } {
  const pair = polylines.filter((polyline) => polyline.props.coordinates.length === segment.coordinates.length && polyline.props.coordinates[0] === segment.coordinates[0]);
  expect(pair).toHaveLength(2);
  const [casing, stroke] = [...pair].sort((a, b) => b.props.strokeWidth - a.props.strokeWidth) as [ReactTestInstance, ReactTestInstance];
  expect(casing.props.strokeWidth).toBeGreaterThan(stroke.props.strokeWidth);
  return { casing, stroke };
}

/** The [r, g, b, alpha] of an `rgba(…)` colour. */
function rgba(color: string): number[] {
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  expect(match).not.toBeNull();
  expect(match?.slice(1).every((part) => Number.isFinite(Number(part)))).toBe(true);
  return (match ?? []).slice(1).map(Number);
}

/** The [r, g, b] of a '#RRGGBB' colour. */
function channelsOf(hex: string): number[] {
  expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  expect(channels.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
  return channels;
}

describe('LinePolylines (M5.7)', () => {
  it('draws 2 polylines per segment', async () => {
    expect(SEGMENTS).toHaveLength(TEST_TRACKS.length);
    const polylines = await drawn(SEGMENTS);
    expect(polylines).toHaveLength(2 * SEGMENTS.length);
    for (const segment of SEGMENTS) {
      const { casing, stroke } = pairOf(polylines, segment);
      expect([casing.props.coordinates, stroke.props.coordinates]).toEqual([segment.coordinates, segment.coordinates]);
    }
  });

  it('casing is +3 wider than the stroke: rail 5 pt, Mover 3.5 pt', async () => {
    const polylines = await drawn(SEGMENTS);
    for (const segment of SEGMENTS) {
      const { casing, stroke } = pairOf(polylines, segment);
      const width = segment.lineId === 'GREEN' || segment.lineId === 'ORANGE' ? RAIL_STROKE_PT : MOVER_STROKE_PT;
      expect([stroke.props.strokeWidth, casing.props.strokeWidth]).toEqual([width, width + CASING_EXTRA_PT]);
      const colors = lineColors(segment.lineId, 'light');
      expect([casing.props.strokeColor, stroke.props.strokeColor]).toEqual([colors.casing, colors.stroke]);
    }
  });

  it('dim = 0.3 alpha, in the line’s own colours; lines in focus stay opaque', async () => {
    const polylines = await drawn(MOVER_DIMMED);
    for (const segment of MOVER_DIMMED) {
      const { casing, stroke } = pairOf(polylines, segment);
      const colors = lineColors(segment.lineId, 'light');
      if (segment.dimmed) {
        expect([rgba(casing.props.strokeColor), rgba(stroke.props.strokeColor)]).toEqual([
          [...channelsOf(colors.casing), DIMMED_ALPHA],
          [...channelsOf(colors.stroke), DIMMED_ALPHA],
        ]);
      } else {
        expect([casing.props.strokeColor, stroke.props.strokeColor]).toEqual([colors.casing, colors.stroke]);
      }
    }
    expect(DIMMED_ALPHA).toBe(0.3);
    expect(MOVER_DIMMED.filter((segment) => segment.dimmed)).toHaveLength(6);
  });

  it('every casing is drawn under every stroke of its layer, and dimmed lines under the lines in focus', async () => {
    const polylines = await drawn(MOVER_DIMMED);
    // Drawing order as layer + part: dimmed casings 0, dimmed strokes 1, focused casings 2, focused strokes 3.
    // A casing is wider than any stroke (6.5 / 8 pt against 3.5 / 5 pt).
    const order = polylines.map((p) => (String(p.props.strokeColor).startsWith('rgba') ? 0 : 2) + (p.props.strokeWidth > RAIL_STROKE_PT ? 0 : 1));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
  });
});
