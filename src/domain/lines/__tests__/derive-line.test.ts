import { isOk } from '../../../lib/result';
import { REAL_STOPS } from '../../network/__fixtures__/real-stops';
import { buildStations } from '../../network/stations';
import { REAL_PATTERNS, type RealPattern } from '../__fixtures__/real-patterns';
import { deriveLine, type Derivation, type DeriveError } from '../derive-line';
import { catalogStationKeys, LINE_CATALOG, linesOfRoute, type LineId, type LineVariant } from '../line-catalog';

/** stop_id → station key over the real feed's stops (the same clustering the pipeline runs). */
function realStationOfStop(): ReadonlyMap<string, string> {
  const index = buildStations(REAL_STOPS);
  expect(index.ok).toBe(true);
  if (!isOk(index)) {
    throw new Error(index.error.message);
  }
  expect(index.value.stationOfStop.size).toBe(REAL_STOPS.length);
  return index.value.stationOfStop;
}

const STATION_OF_STOP = realStationOfStop();

function stationsOf(pattern: RealPattern): string[] {
  const keys = pattern.stopIds.map((stopId) => STATION_OF_STOP.get(stopId) ?? `unclustered stop ${stopId}`);
  expect(keys.every((key) => !key.startsWith('unclustered'))).toBe(true);
  expect(keys).toHaveLength(pattern.stopIds.length);
  return keys;
}

function realPattern(shapeId: string, first: string, last: string): RealPattern {
  const found = REAL_PATTERNS.filter((p) => p.shapeId === shapeId && p.stopIds[0] === first && p.stopIds[p.stopIds.length - 1] === last);
  expect(found).toHaveLength(1);
  const [pattern] = found;
  if (pattern === undefined) {
    throw new Error(`no real pattern on shape ${shapeId} ${first}→${last}`);
  }
  expect(pattern.shapeId).toBe(shapeId);
  return pattern;
}

/** How many feed trips run the (single) real pattern on `shapeId`. */
function tripsOn(shapeId: string): number {
  const onShape = REAL_PATTERNS.filter((p) => p.shapeId === shapeId);
  expect(onShape).toHaveLength(1);
  expect(onShape[0]?.trips).toBeGreaterThan(0);
  return onShape[0]?.trips ?? 0;
}

function derived(routeId: string, stations: readonly string[]): Derivation {
  const result = deriveLine(routeId, stations);
  expect(result.ok).toBe(true);
  if (!isOk(result)) {
    throw new Error(`expected a line, got Err: ${result.error.message}`);
  }
  expect(LINE_CATALOG.some((line) => line.id === result.value.line)).toBe(true);
  return result.value;
}

function refused(routeId: string, stations: readonly string[]): DeriveError {
  const result = deriveLine(routeId, stations);
  expect(result.ok).toBe(false);
  if (isOk(result)) {
    throw new Error(`expected Err, got ${result.value.line}`);
  }
  expect(result.error.kind).toBe('derive');
  return result.error;
}

/**
 * The arbiter's ruling of 2026-10-01 (computed from the live county feed, Last-Modified 2026-07-31),
 * row for row: route, shape, stop count, first → last stop_id, expected line and variant. The
 * ruling names a variant for the rail rows only; each Mover leg runs between its line's catalog
 * terminals, which is the definition of `full`.
 */
const RULING: readonly (readonly [string, string, number, string, string, LineId, LineVariant])[] = [
  ['31009', '211260', 22, '9529', '9487', 'GREEN', 'full'],
  ['31009', '211263', 22, '9529', '9487', 'GREEN', 'full'],
  ['31009', '211239', 22, '9486', '9528', 'GREEN', 'full'],
  ['31009', '211246', 22, '9486', '9528', 'GREEN', 'full'],
  ['31009', '211235', 2, '10494', '9500', 'ORANGE', 'airport_shuttle'],
  ['31009', '211250', 2, '9501', '10495', 'ORANGE', 'airport_shuttle'],
  ['31009', '211251', 16, '9529', '10495', 'ORANGE', 'full'],
  ['31009', '211236', 16, '10494', '9528', 'ORANGE', 'full'],
  ['31009', '211270', 8, '9501', '9487', 'GREEN', 'short_turn'],
  ['14457', '123750', 4, '832', '813', 'MM_INNER', 'full'],
  ['14457', '123751', 6, '813', '841', 'MM_INNER', 'full'],
  ['14456', '123746', 13, '801', '813', 'MM_BRICKELL', 'full'],
  ['14456', '123745', 9, '795', '813', 'MM_OMNI', 'full'],
  ['14456', '123747', 12, '813', '831', 'MM_OMNI', 'full'],
  ['14456', '123748', 8, '813', '821', 'MM_BRICKELL', 'full'],
];

describe('deriveLine on the live feed patterns (arbiter ruling 2026-10-01)', () => {
  it.each(RULING)('real-pattern route %s shape %s (%i stops, %s → %s) derives %s / %s', (routeId, shapeId, stops, first, last, line, variant) => {
    const pattern = realPattern(shapeId, first, last);
    expect([pattern.routeId, pattern.stopIds.length]).toEqual([routeId, stops]);
    expect(derived(routeId, stationsOf(pattern))).toEqual({ line, variant });
  });

  it('the fixture holds exactly the ruling: 15 patterns (9 rail + 6 Mover) with its trip counts', () => {
    expect(REAL_PATTERNS).toHaveLength(15);
    expect(RULING.map(([routeId, shapeId]) => `${routeId}/${shapeId}`).sort()).toEqual(REAL_PATTERNS.map((p) => `${p.routeId}/${p.shapeId}`).sort());
    // The two full-Green directions each run on two shapes: 193 = 75 + 118 and 191 = 73 + 118.
    expect([tripsOn('211260') + tripsOn('211263'), tripsOn('211239') + tripsOn('211246')]).toEqual([193, 191]);
    expect(['211235', '211250', '211251', '211236', '211270'].map(tripsOn)).toEqual([171, 168, 75, 71, 7]);
    expect(['123750', '123751', '123746', '123745', '123747', '123748'].map(tripsOn)).toEqual([940, 937, 597, 596, 596, 595]);
  });
});

describe('headsigns cannot decide the line; the stop pattern does', () => {
  it('DOWNTOWN shape 123745 derives MM_OMNI by stop pattern', () => {
    const pattern = realPattern('123745', '795', '813');
    expect(pattern.headsigns).toEqual(['DOWNTOWN']);
    expect(derived('14456', stationsOf(pattern)).line).toBe('MM_OMNI');
  });

  it('DOWNTOWN shape 123746 derives MM_BRICKELL by stop pattern (the same headsign as the Omni leg)', () => {
    const pattern = realPattern('123746', '801', '813');
    expect(pattern.headsigns).toEqual(['DOWNTOWN']);
    expect(derived('14456', stationsOf(pattern)).line).toBe('MM_BRICKELL');
  });

  it('FINANCIAL DISTRICT shape 123748 derives MM_BRICKELL by stop pattern', () => {
    const pattern = realPattern('123748', '813', '821');
    expect(pattern.headsigns).toEqual(['FINANCIAL DISTRICT']);
    expect(derived('14456', stationsOf(pattern)).line).toBe('MM_BRICKELL');
  });

  it('headsign "EHT - CUL SINGLE TRACK AFTER 8PM" derives GREEN by stop pattern', () => {
    const pattern = realPattern('211246', '9486', '9528');
    expect(pattern.headsigns).toEqual(['EHT - CUL SINGLE TRACK AFTER 8PM']);
    expect(derived('31009', stationsOf(pattern))).toEqual({ line: 'GREEN', variant: 'full' });
  });

  it('headsign "EHT - CUL SINGLE TRACK AFTER 8 PM" derives GREEN by stop pattern', () => {
    const pattern = realPattern('211263', '9529', '9487');
    expect(pattern.headsigns).toEqual(['EHT - CUL SINGLE TRACK AFTER 8 PM']);
    expect(derived('31009', stationsOf(pattern))).toEqual({ line: 'GREEN', variant: 'full' });
  });
});

describe('sentinel rules', () => {
  it('a pattern touching both branches -> Err (Green and Orange sentinels on one rail pattern)', () => {
    const error = refused('31009', ['rail:palmetto', 'rail:brownsville', 'rail:earlington-hts', 'rail:miami-international-airport']);
    expect(error.reason).toBe('both-branches');
    expect(error.message).toMatch(/GREEN \(rail:palmetto, rail:brownsville\) and ORANGE \(rail:miami-international-airport\)/);
  });

  it('a Mover pattern touching both branches -> Err (Omni and Brickell sentinels)', () => {
    const error = refused('14456', ['mover:school-board', 'mover:government-center', 'mover:financial-district']);
    expect(error.reason).toBe('both-branches');
    expect(error.message).toContain('MM_OMNI (mover:school-board) and MM_BRICKELL (mover:financial-district)');
  });

  it('a pattern through School Board -> MM_OMNI', () => {
    expect(derived('14456', ['mover:third-street', 'mover:freedom-tower', 'mover:school-board'])).toEqual({ line: 'MM_OMNI', variant: 'short_turn' });
    expect(derived('14456', ['mover:school-board', 'mover:government-center'])).toEqual({ line: 'MM_OMNI', variant: 'full' });
  });

  it('a shared-route pattern touching no sentinel -> Err (trunk-only rail, downtown-only Mover)', () => {
    expect(refused('31009', ['rail:earlington-hts', 'rail:dadeland-south']).reason).toBe('no-sentinel');
    expect(refused('14456', ['mover:government-center', 'mover:third-street', 'mover:knight-center']).reason).toBe('no-sentinel');
  });

  it('a single-line route needs no sentinel; an unknown route -> Err', () => {
    expect(derived('14457', ['mover:government-center', 'mover:bayfront-park']).line).toBe('MM_INNER');
    expect(refused('31161', ['rail:palmetto', 'rail:hialeah']).reason).toBe('unknown-route');
  });

  it('the catalog names only stations the live feed has, and each shared route splits by sentinels', () => {
    const known = new Set(STATION_OF_STOP.values());
    expect(catalogStationKeys().filter((key) => !known.has(key))).toEqual([]);
    expect(linesOfRoute('31009').map((line) => line.id)).toEqual(['GREEN', 'ORANGE']);
    expect(linesOfRoute('14456').map((line) => line.id)).toEqual(['MM_OMNI', 'MM_BRICKELL']);
  });
});
