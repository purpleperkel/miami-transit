import type { LatLon } from '../../../lib/geo';
import { REAL_PATTERNS } from '../../lines/__fixtures__/real-patterns';
import type { LineId } from '../../lines/line-catalog';
import { REAL_STOPS } from '../../network/__fixtures__/real-stops';
import type { LineTrack, LiveNetwork } from '../types';

/**
 * A LiveNetwork for the live-domain tests, standing in for the schedule.db lookups the runtime
 * injects (M4.9). Tracks follow schedule.db's line_shape (2026-10-01: Green = shape 211239, Orange =
 * 211236, each Mover line its two shapes), drawn station to station through the REAL stop
 * coordinates of those patterns — the real network's geometry at station resolution.
 */

const LINE_SHAPES: readonly (readonly [LineId, string])[] = [
  ['GREEN', '211239'],
  ['ORANGE', '211236'],
  ['MM_OMNI', '123745'],
  ['MM_OMNI', '123747'],
  ['MM_BRICKELL', '123746'],
  ['MM_BRICKELL', '123748'],
  ['MM_INNER', '123750'],
  ['MM_INNER', '123751'],
];

/** The fixture trips the schedule knows (live-feeds.fixture.ts and the departures fixture). */
export const TRIP_LINES: ReadonlyMap<string, LineId> = new Map([
  ['fixture-rail-0815', 'GREEN'],
  ['fixture-rail-0822', 'ORANGE'],
  ['fixture-rail-0828', 'ORANGE'],
  ['fixture-rail-0830', 'GREEN'],
  ['fixture-rail-0834', 'GREEN'],
  ['fixture-rail-0840', 'GREEN'],
  ['fixture-rail-0845', 'ORANGE'],
  ['fixture-rail-0846', 'ORANGE'],
  ['fixture-rail-0858', 'GREEN'],
  ['fixture-rail-0920', 'ORANGE'],
  ['fixture-omni-1630', 'MM_OMNI'],
  ['fixture-omni-0831', 'MM_OMNI'],
  ['fixture-inner-1631', 'MM_INNER'],
  ['fixture-inner-0833', 'MM_INNER'],
]);

/** Stop → station keys as M2.9 builds them (Government Center N+S → rail:government-ctr). */
export const STOP_STATIONS: ReadonlyMap<string, string> = new Map([
  ['9512', 'rail:government-ctr'],
  ['9513', 'rail:government-ctr'],
  ['9514', 'rail:brickell'],
  ['9515', 'rail:brickell'],
  ['813', 'mover:government-center'],
  ['815', 'mover:third-street'],
]);

function stopCoordinate(stopId: string): LatLon {
  const stop = REAL_STOPS.find((candidate) => candidate.stopId === stopId);
  expect(stop).toBeDefined();
  const point = { latitude: stop?.latitude ?? Number.NaN, longitude: stop?.longitude ?? Number.NaN };
  expect(Number.isFinite(point.latitude) && Number.isFinite(point.longitude)).toBe(true);
  return point;
}

function patternTrack(lineId: LineId, shapeId: string): LineTrack {
  const pattern = REAL_PATTERNS.find((candidate) => candidate.shapeId === shapeId);
  expect(pattern).toBeDefined();
  const points = (pattern?.stopIds ?? []).map((stopId) => stopCoordinate(stopId));
  expect(points.length).toBeGreaterThanOrEqual(2);
  return { lineId, points };
}

export const TEST_TRACKS: readonly LineTrack[] = LINE_SHAPES.map(([lineId, shapeId]) => patternTrack(lineId, shapeId));

/** The test network; `trips` replaces the trip → line table (e.g. an empty map: the schedule knows no trip). */
export function testNetwork(trips: ReadonlyMap<string, LineId> = TRIP_LINES): LiveNetwork {
  const network: LiveNetwork = {
    lineOfTrip: (tripId) => trips.get(tripId) ?? null,
    stationOfStop: (stopId) => STOP_STATIONS.get(stopId) ?? null,
    tracks: TEST_TRACKS,
  };
  expect(network.tracks).toHaveLength(LINE_SHAPES.length);
  expect(network.stationOfStop('9513')).toBe('rail:government-ctr');
  return network;
}
