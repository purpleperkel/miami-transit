import { haversineMeters } from '../../../lib/geo';
import { isOk } from '../../../lib/result';
import { REAL_STOPS } from '../__fixtures__/real-stops';
import {
  buildStations,
  cleanStopName,
  CLUSTER_RADIUS_M,
  displayName,
  MAX_NAME_LENGTH,
  stationKey,
  type Mode,
  type Station,
  type StationIndex,
  type StopInput,
} from '../stations';

/** Metres of latitude per degree on the IUGG sphere geo.ts uses. */
const METRES_PER_DEGREE = 111_195.08;

function indexOf(stops: readonly StopInput[]): StationIndex {
  const result = buildStations(stops);
  expect(result.ok).toBe(true);
  if (!isOk(result)) {
    throw new Error(`expected stations, got Err: ${result.error.message}`);
  }
  expect(result.value.stationOfStop.size).toBe(stops.length);
  return result.value;
}

function stationNamed(index: StationIndex, key: string): Station {
  const station = index.stations.find((candidate) => candidate.key === key);
  expect(station).toBeDefined();
  if (station === undefined) {
    throw new Error(`no station ${key}`);
  }
  expect(station.key).toBe(key);
  return station;
}

/** A synthetic stop `north` metres north of a fixed downtown point. */
function stopAt(stopId: string, north: number, mode: Mode = 'mover', name = 'TEST METROMOVER STATION'): StopInput {
  expect(Number.isFinite(north)).toBe(true);
  expect(stopId.length).toBeGreaterThan(0);
  return { stopId, name, latitude: 25.77 + north / METRES_PER_DEGREE, longitude: -80.19, mode };
}

/** A display name fit for the UI: Title Case, no station/direction words, single-spaced, ≤ 28 characters. */
function expectPresentableName({ key, name }: Station): void {
  const problems = [
    name !== name.trim() || name.includes('  ') ? 'stray spaces' : '',
    /[a-z]/.test(name) && name.split(/[\s/-]+/).every((word) => /^[A-Z0-9]/.test(word)) ? '' : 'not Title Case',
    /\b(STATION|STAT|METRORAIL|METROMOVER)\b|BOUND\b/i.test(name) ? 'station or direction word' : '',
  ].filter((problem) => problem !== '');
  expect({ key, name, problems }).toEqual({ key, name, problems: [] });
  expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
}

describe('station clustering on the real feed (89 in-scope stops, 2026-07-31)', () => {
  it('Government Center N+S cluster to rail:government-ctr', () => {
    const index = indexOf(REAL_STOPS);
    expect([index.stationOfStop.get('9512'), index.stationOfStop.get('9513')]).toEqual(['rail:government-ctr', 'rail:government-ctr']);
    const station = stationNamed(index, 'rail:government-ctr');
    expect(station.stopIds).toEqual(['9512', '9513']);
    expect(station.name).toBe('Government Center');
    // The Mover platform is ~20 m away but a different mode: its own station, joined by a transfer.
    expect(index.stationOfStop.get('813')).toBe('mover:government-center');
  });

  it('stops 808/832/841 cluster to mover:bayfront-park', () => {
    const index = indexOf(REAL_STOPS);
    expect(['808', '832', '841'].map((stopId) => index.stationOfStop.get(stopId))).toEqual([
      'mover:bayfront-park',
      'mover:bayfront-park',
      'mover:bayfront-park',
    ]);
    const station = stationNamed(index, 'mover:bayfront-park');
    expect(station.stopIds).toEqual(['808', '823', '832', '841']);
    // 832 is published as "BISCAYNE BD@E FLAGLER ST"; its platform-mates' station name wins.
    expect(REAL_STOPS.find((stop) => stop.stopId === '832')?.name).toBe('BISCAYNE BD@E FLAGLER ST');
    expect(station.name).toBe('Bayfront Park');
  });

  it('every name is Title Case, has no STATION/METRORAIL, <= 28 chars', () => {
    const { stations } = indexOf(REAL_STOPS);
    expect(stations).toHaveLength(44);
    stations.forEach(expectPresentableName);
    expect(Math.max(...stations.map((station) => station.name.length))).toBeLessThanOrEqual(28);
  });

  it('the real feed has 23 rail and 21 Mover stations', () => {
    const { stations } = indexOf(REAL_STOPS);
    expect(stations.filter((station) => station.mode === 'rail')).toHaveLength(23);
    expect(stations.filter((station) => station.mode === 'mover')).toHaveLength(21);
    expect(stations.map((station) => station.key)).toEqual([...stations.map((station) => station.key)].sort());
  });

  it('names expand the feed abbreviations and keep their keys: EARLINGTON HTS → Earlington Heights', () => {
    const index = indexOf(REAL_STOPS);
    expect(stationNamed(index, 'rail:earlington-hts').name).toBe('Earlington Heights');
    expect(stationNamed(index, 'rail:historic-overtown-lyric-theatre').name).toBe('Overtown/Lyric Theatre');
    expect(stationNamed(index, 'rail:m-l-king').name).toBe('M.L. King');
    expect(stationNamed(index, 'mover:tenth-street-promanade').name).toBe('Tenth Street Promenade');
  });
});

describe('station clustering rules', () => {
  it(`stops of one mode within ${CLUSTER_RADIUS_M} m join; ${CLUSTER_RADIUS_M + 1} m apart they stay separate`, () => {
    const [a, near, far] = [stopAt('A', 0), stopAt('B', 59.5), stopAt('C', 59.5 + 61)];
    expect(haversineMeters(a, near)).toBeLessThan(CLUSTER_RADIUS_M);
    expect(haversineMeters(near, far)).toBeGreaterThan(CLUSTER_RADIUS_M);
    const index = buildStations([a, near, { ...far, name: 'OTHER METROMOVER STATION' }]);
    expect(isOk(index) && index.value.stations.map((s) => s.stopIds)).toEqual([['C'], ['A', 'B']]);
  });

  it('clusters chain (single linkage): 50 m + 50 m apart make one station', () => {
    const index = indexOf([stopAt('A', 0), stopAt('B', 50), stopAt('C', 100)]);
    expect(index.stations).toHaveLength(1);
    expect(index.stations[0]?.stopIds).toEqual(['A', 'B', 'C']);
  });

  it('rail and Mover never share a station, even at the same point', () => {
    const index = indexOf([stopAt('R', 0, 'rail', 'TEST STATION RAIL NORTHBOUND'), stopAt('M', 0, 'mover')]);
    expect(index.stations.map((station) => station.key)).toEqual(['mover:test', 'rail:test']);
    expect(index.stations.map((station) => station.name)).toEqual(['Test', 'Test']);
  });

  it('a name over 28 characters with no override → Err naming the key', () => {
    const result = buildStations([stopAt('X', 0, 'mover', 'AN EXCEEDINGLY LONG DOWNTOWN PLAZA METROMOVER STATION')]);
    expect(result.ok).toBe(false);
    expect(!isOk(result) && result.error.message).toMatch(/mover:an-exceedingly-long-downtown-plaza: "An Exceedingly Long Downtown Plaza" is 34 characters \(max 28\)/);
  });

  it('a stop named only with station words → Err, not a nameless station', () => {
    const result = buildStations([stopAt('S', 0, 'rail', 'STATION RAIL NORTHBOUND')]);
    expect(result.ok).toBe(false);
    expect(!isOk(result) && result.error.message).toBe('stops S have no name left once station words are removed');
  });

  it('two clusters that would share a key → Err', () => {
    const result = buildStations([stopAt('A', 0), stopAt('B', 500)]);
    expect(result.ok).toBe(false);
    expect(!isOk(result) && result.error.key).toBe('mover:test');
  });
});

describe('name cleaning', () => {
  it.each([
    ['PALMETTO STATION RAIL SOUTHBOUND', 'PALMETTO'],
    ['GOVERNMENT CTR.STAT.RAIL NORTHBOUND', 'GOVERNMENT CTR'],
    ['EARLINGTON HTS.STAT.RAIL SOUTHBOUND', 'EARLINGTON HTS'],
    ['COCONUT GROVE STAT. RAIL SOUTHBOUND', 'COCONUT GROVE'],
    ['SCHOOL BOARD METROMOVER STATION', 'SCHOOL BOARD'],
    ['MIAMI WORLDCENTER STATION', 'MIAMI WORLDCENTER'],
    ['MIAMI INTERNATIONAL AIRPORT STATION NORTHBOUND', 'MIAMI INTERNATIONAL AIRPORT'],
  ])('cleanStopName(%p) → %p, marked', (raw, cleaned) => {
    expect(cleanStopName(raw)).toEqual({ text: cleaned, marked: true });
    expect(cleanStopName(raw).text).not.toMatch(/STATION|METRORAIL|BOUND/);
  });

  it('a bare street name is unmarked and kept as published', () => {
    expect(cleanStopName('BISCAYNE BD@E FLAGLER ST')).toEqual({ text: 'BISCAYNE BD@E FLAGLER ST', marked: false });
    expect(cleanStopName('  palmetto   station rail ').text).toBe('PALMETTO');
  });

  it('keys mirror the feed; display names are for people', () => {
    expect(stationKey('rail', 'GOVERNMENT CTR')).toBe('rail:government-ctr');
    expect(displayName('GOVERNMENT CTR')).toBe('Government Center');
    expect(stationKey('rail', 'M.L. KING')).toBe('rail:m-l-king');
    expect(displayName('TRI-RAIL')).toBe('Tri-Rail');
    expect(displayName('UHEALTH JACKSON')).toBe('UHealth Jackson');
  });
});
