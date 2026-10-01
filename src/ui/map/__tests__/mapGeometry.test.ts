import { REAL_PATTERNS } from '@/domain/lines/__fixtures__/real-patterns';
import { REAL_STOPS } from '@/domain/network/__fixtures__/real-stops';
import type { LatLon } from '@/lib/geo';

import { MIN_REGION_DELTA, offsetPolyline, regionContains, regionForPoints, zoomBucket } from '../mapGeometry';
import { distanceToLine, METRES_PER_DEGREE } from './geo-measure';

/**
 * M5.6 mapGeometry. Distances to a line are measured here on a plane centred at the measured point
 * itself (not mapGeometry's plane), and the lines are the network's REAL patterns drawn through their
 * real stop coordinates, plus a synthetic line with every kind of corner.
 */

/** Every vertex of the line and nine evenly spaced points inside each of its segments. */
function samplesAlong(line: readonly LatLon[]): LatLon[] {
  const samples: LatLon[] = [];
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1] as LatLon;
    const b = line[i] as LatLon;
    for (let k = 0; k < 10; k += 1) {
      samples.push({ latitude: a.latitude + ((b.latitude - a.latitude) * k) / 10, longitude: a.longitude + ((b.longitude - a.longitude) * k) / 10 });
    }
  }
  samples.push(line[line.length - 1] as LatLon);
  expect(samples.length).toBe((line.length - 1) * 10 + 1);
  expect(samples[0]).toEqual(line[0]);
  return samples;
}

/** Each real pattern as the polyline through its stops' coordinates. */
function realPatternLines(): LatLon[][] {
  const byId = new Map(REAL_STOPS.map((stop) => [stop.stopId, { latitude: stop.latitude, longitude: stop.longitude }]));
  const lines = REAL_PATTERNS.map((pattern) => pattern.stopIds.map((id) => byId.get(id) as LatLon));
  expect(lines).toHaveLength(15);
  expect(lines.every((line) => line.length >= 2 && line.every((p) => p !== undefined))).toBe(true);
  return lines;
}

/** 200 m legs from Government Center turning 30°, 60°, 90° and 135° both ways: mitres, rounds and inner corners. */
function cornersLine(): LatLon[] {
  const turns = [30, -60, 90, -135, 135, -90, 60, -30];
  const kx = METRES_PER_DEGREE * Math.cos((25.7743 * Math.PI) / 180);
  const line: LatLon[] = [{ latitude: 25.7743, longitude: -80.1937 }];
  let bearing = 0;
  for (const turn of [0, ...turns]) {
    bearing += turn;
    const last = line[line.length - 1] as LatLon;
    const rad = (bearing * Math.PI) / 180;
    line.push({ latitude: last.latitude + (200 * Math.cos(rad)) / METRES_PER_DEGREE, longitude: last.longitude + (200 * Math.sin(rad)) / kx });
  }
  expect(line).toHaveLength(turns.length + 2);
  expect(new Set(line.map((p) => `${p.latitude},${p.longitude}`)).size).toBe(line.length);
  return line;
}

/** The real stops of one mode, as coordinates. */
function stopsOf(mode: 'rail' | 'mover'): LatLon[] {
  const stops = REAL_STOPS.filter((stop) => stop.mode === mode).map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude }));
  expect(stops.length).toBeGreaterThan(20);
  expect(stops.every((stop) => Number.isFinite(stop.latitude))).toBe(true);
  return stops;
}

describe('zoom buckets (M5.6)', () => {
  it('zoomBucket(0.3) = 0', () => {
    expect(zoomBucket(0.3)).toBe(0);
  });

  it('zoomBucket(0.01) = 3', () => {
    expect(zoomBucket(0.01)).toBe(3);
  });

  it('each threshold opens its bucket: 0.15 / 0.06 / 0.02', () => {
    expect([0.15, 0.1499, 0.06, 0.0599, 0.02, 0.0199].map(zoomBucket)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(() => zoomBucket(0)).toThrow();
  });
});

describe('offset polylines (M5.6)', () => {
  it('offsetPolyline stays 5 ± 0.5 m from the input line', () => {
    const lines = [...realPatternLines(), cornersLine()];
    expect(lines).toHaveLength(16);
    for (const line of lines) {
      for (const offset of [5, -5]) {
        const distances = samplesAlong(offsetPolyline(line, offset)).map((x) => distanceToLine(x, line));
        expect([Math.min(...distances) >= 4.5, Math.max(...distances) <= 5.5]).toEqual([true, true]);
      }
    }
  });

  it('a positive offset lies right of travel, a negative one left', () => {
    const northbound = [
      { latitude: 25.77, longitude: -80.19 },
      { latitude: 25.78, longitude: -80.19 },
    ];
    const right = offsetPolyline(northbound, 5);
    const left = offsetPolyline(northbound, -5);
    expect(right.every((p) => p.longitude > -80.19)).toBe(true);
    expect(left.every((p) => p.longitude < -80.19)).toBe(true);
  });
});

describe('regions (M5.6)', () => {
  it('regionForPoints contains every input point', () => {
    const all = [...stopsOf('rail'), ...stopsOf('mover')];
    expect(all).toHaveLength(REAL_STOPS.length);
    for (const points of [all, stopsOf('mover'), all.slice(0, 1)]) {
      const region = regionForPoints(points);
      expect(points.filter((p) => !regionContains(region, p))).toEqual([]);
      expect(Math.min(region.latitudeDelta, region.longitudeDelta)).toBeGreaterThanOrEqual(MIN_REGION_DELTA);
    }
  });

  it('the whole network frames at system zoom, the Mover at downtown zoom', () => {
    expect(zoomBucket(regionForPoints(stopsOf('rail')).latitudeDelta)).toBe(0);
    expect(zoomBucket(regionForPoints(stopsOf('mover')).latitudeDelta)).toBe(2);
  });
});
