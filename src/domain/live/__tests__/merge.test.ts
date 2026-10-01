import { haversineMeters, type LatLon } from '../../../lib/geo';
import type { Mode } from '../../network/stations';
import type { ScheduledVehicle } from '../../schedule/positions';
import { type MergedVehicle, mergeVehicles, type VehicleMerge } from '../merge';
import type { LiveBatch, LiveLineId, LiveVehicle, ProviderId } from '../types';

/**
 * M4.6: the §4 vehicle-merge rules 1–5 as ONE table (it.each). Each row is a timetable snapshot
 * (ghosts), a live batch, and the merged map it must produce, summarised as
 * `key source matchedBy line` (sorted by key). Distances are built with a north offset and checked
 * with haversine, independently of the merge's own distance code.
 */

const NOW = 1_790_872_200;
const METRES_PER_DEGREE_LAT = (6_371_008.8 * Math.PI) / 180;
const GOVERNMENT_CENTER: LatLon = { latitude: 25.776, longitude: -80.1961 };
const BRICKELL: LatLon = { latitude: 25.7638, longitude: -80.1955 };
const INNER_LOOP: LatLon = { latitude: 25.7739, longitude: -80.1917 };

/** The point `metres` due north of `from`. */
function north(from: LatLon, metres: number): LatLon {
  const point = { latitude: from.latitude + metres / METRES_PER_DEGREE_LAT, longitude: from.longitude };
  expect(haversineMeters(from, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(from.longitude);
  return point;
}

function ghost(block: string, tripId: string, lineId: string, mode: Mode, position: LatLon): ScheduledVehicle {
  const vehicle: ScheduledVehicle = { vehicleKey: `20261001:${block}`, serviceDate: 20261001, state: 'moving', tripIdx: 1, tripId, lineId, mode, directionId: 0, shapeIdx: 0, distM: 0, position };
  expect(vehicle.vehicleKey).toContain(block);
  expect(vehicle.position).toBe(position);
  return vehicle;
}

type TrainSpec = { readonly tripId?: string; readonly lineId?: LiveLineId; readonly mode?: Mode; readonly ageS?: number };

function train(vehicleId: string, position: LatLon, spec: TrainSpec = {}): LiveVehicle {
  const mode = spec.mode ?? 'rail';
  const vehicle: LiveVehicle = {
    vehicleId, label: vehicleId, tripId: spec.tripId ?? null, routeId: mode === 'rail' ? '31009' : '14457', mode,
    lineId: spec.lineId ?? 'GREEN', lineSource: spec.tripId === undefined ? 'position' : 'trip', directionId: 0,
    position, bearing: 90, speedMps: 10, stopId: null, stopStatus: null, timestamp: NOW - (spec.ageS ?? 10),
  };
  expect(vehicle.timestamp).toBeLessThanOrEqual(NOW);
  expect(vehicle.routeId.length).toBeGreaterThan(0);
  return vehicle;
}

const G1 = ghost('B-G1', 'T-G1', 'GREEN', 'rail', GOVERNMENT_CENTER);
const G2 = ghost('B-G2', 'T-G2', 'GREEN', 'rail', north(GOVERNMENT_CENTER, 1_000));
const O1 = ghost('B-O1', 'T-O1', 'ORANGE', 'rail', BRICKELL);
const M1 = ghost('B-M1', 'T-M1', 'MM_INNER', 'mover', INNER_LOOP);

type Row = {
  readonly name: string;
  readonly provider: ProviderId | null;
  readonly ghosts: readonly ScheduledVehicle[];
  readonly trains: readonly LiveVehicle[];
  readonly expected: readonly string[];
  readonly dropped?: VehicleMerge['dropped'];
  readonly positions?: Readonly<Record<string, LatLon>>;
};

const NOTHING_DROPPED = { tooOld: 0, outOfBounds: 0 };
const FAR_NORTH = north(GOVERNMENT_CENTER, 2_000);
const OFF_GC_790 = north(GOVERNMENT_CENTER, 790);

const RULES: readonly Row[] = [
  { name: 'no live feed: the timetable alone, every ghost shown', provider: null, ghosts: [G1, M1], trains: [],
    expected: ['20261001:B-G1 scheduled - GREEN', '20261001:B-M1 scheduled - MM_INNER'] },
  { name: 'rule 1: max age — a vehicle 180 s old is dropped past Swiftly\'s 150 s', provider: 'swiftly', ghosts: [G1], trains: [train('r1', FAR_NORTH, { ageS: 180 })],
    expected: ['20261001:B-G1 scheduled - GREEN'], dropped: { tooOld: 1, outOfBounds: 0 } },
  { name: 'rule 1: max age — the same 180 s old vehicle is kept within Transitland\'s 210 s', provider: 'transitland', ghosts: [G1], trains: [train('r1', FAR_NORTH, { ageS: 180 })],
    expected: ['20261001:B-G1 scheduled - GREEN', 'live:r1 live - GREEN'] },
  { name: 'rule 1: max age — exactly 150 s old is still kept on Swiftly', provider: 'swiftly', ghosts: [], trains: [train('r1', FAR_NORTH, { ageS: 150 })],
    expected: ['live:r1 live - GREEN'] },
  { name: 'rule 1: bounding box — a 0,0 fix is dropped even with a matching trip', provider: 'swiftly', ghosts: [G1], trains: [train('r9', { latitude: 0, longitude: 0 }, { tripId: 'T-G1' })],
    expected: ['20261001:B-G1 scheduled - GREEN'], dropped: { tooOld: 0, outOfBounds: 1 } },
  { name: 'rule 1: bounding box — a fix in Fort Lauderdale (26.12 °N) is dropped', provider: 'swiftly', ghosts: [], trains: [train('r9', { latitude: 26.12, longitude: -80.14 })],
    expected: [], dropped: { tooOld: 0, outOfBounds: 1 } },
  { name: 'rule 2: trip_id match — the live train on T-G1 takes ghost G1 even 2 km away', provider: 'swiftly', ghosts: [G1], trains: [train('r2', FAR_NORTH, { tripId: 'T-G1' })],
    expected: ['20261001:B-G1 live trip GREEN'] },
  { name: 'rule 2: no trip — the same-line ghost 790 m away is matched (within 800 m)', provider: 'swiftly', ghosts: [G1], trains: [train('r3', OFF_GC_790)],
    expected: ['20261001:B-G1 live position GREEN'] },
  { name: 'rule 2: 800 m is the limit — 810 m away stays unmatched', provider: 'swiftly', ghosts: [G1], trains: [train('r3', north(GOVERNMENT_CENTER, 810))],
    expected: ['live:r3 live - GREEN'] },
  { name: 'rule 2: same line only — an ORANGE train 100 m from a GREEN ghost does not take it', provider: 'swiftly', ghosts: [G1], trains: [train('r4', north(GOVERNMENT_CENTER, 100), { lineId: 'ORANGE' })],
    expected: ['live:r4 live - ORANGE'] },
  { name: 'rule 2: greedy closest pair first — 50 m beats 400 m, so both trains find a ghost within 800 m', provider: 'swiftly', ghosts: [G2, G1],
    trains: [train('r5', north(GOVERNMENT_CENTER, 600)), train('r6', north(GOVERNMENT_CENTER, 1_050))],
    expected: ['20261001:B-G1 live position GREEN', '20261001:B-G2 live position GREEN'] },
  { name: 'rule 2: a trunk train (RAIL_TRUNK, line unknown) may take a ghost of either rail line', provider: 'swiftly', ghosts: [O1], trains: [train('r7', north(BRICKELL, 200), { lineId: 'RAIL_TRUNK' })],
    expected: ['20261001:B-O1 live position RAIL_TRUNK'] },
  { name: 'rule 3: live position wins — the matched train is drawn at its fix, not the timetable\'s', provider: 'swiftly', ghosts: [G1], trains: [train('r3', OFF_GC_790)],
    expected: ['20261001:B-G1 live position GREEN'], positions: { '20261001:B-G1': OFF_GC_790 } },
  { name: 'rule 4: an unmatched live vehicle is still shown — a Mover with no ghost', provider: 'swiftly', ghosts: [G1], trains: [train('m1', INNER_LOOP, { mode: 'mover', lineId: 'MM_INNER' })],
    expected: ['20261001:B-G1 scheduled - GREEN', 'live:m1 live - MM_INNER'], positions: { 'live:m1': INNER_LOOP } },
  { name: 'rule 5: a fresh rail feed hides the unmatched rail ghosts and keeps the Mover ghosts', provider: 'swiftly', ghosts: [G1, O1, M1], trains: [train('r2', GOVERNMENT_CENTER, { tripId: 'T-G1' })],
    expected: ['20261001:B-G1 live trip GREEN', '20261001:B-M1 scheduled - MM_INNER'] },
  { name: 'rule 5: a stale feed keeps the ghosts — rail 100 s old on Swiftly (fresh ≤ 75 s)', provider: 'swiftly', ghosts: [G1, O1], trains: [train('r2', GOVERNMENT_CENTER, { tripId: 'T-G1', ageS: 100 })],
    expected: ['20261001:B-G1 live trip GREEN', '20261001:B-O1 scheduled - ORANGE'] },
  { name: 'rule 5: Transitland is fresh up to 150 s — rail 100 s old hides the ghosts', provider: 'transitland', ghosts: [G1, O1], trains: [train('r2', GOVERNMENT_CENTER, { tripId: 'T-G1', ageS: 100 })],
    expected: ['20261001:B-G1 live trip GREEN'] },
];

function summary(vehicle: MergedVehicle): string {
  const text = `${vehicle.key} ${vehicle.source} ${vehicle.matchedBy ?? '-'} ${vehicle.lineId}`;
  expect(vehicle.source === 'live').toBe(vehicle.live !== null);
  expect(vehicle.matchedBy === null || vehicle.scheduled !== null).toBe(true);
  return text;
}

function batch(provider: ProviderId, trains: readonly LiveVehicle[]): LiveBatch<LiveVehicle> {
  const made: LiveBatch<LiveVehicle> = { provider, items: trains, feedTimestamp: NOW, fetchedAt: NOW, bytes: 1_000, dropped: {} };
  expect(made.items).toBe(trains);
  expect(made.provider).toBe(provider);
  return made;
}

describe('vehicle merge (M4.6): the §4 merge rules as one table', () => {
  it.each(RULES)('$name', ({ provider, ghosts, trains, expected, dropped, positions }) => {
    const merged = mergeVehicles(ghosts, provider === null ? null : batch(provider, trains), NOW);
    expect(merged.vehicles.map(summary)).toEqual(expected);
    expect(merged.dropped).toEqual(dropped ?? NOTHING_DROPPED);
    for (const [key, position] of Object.entries(positions ?? {})) {
      expect(merged.vehicles.find((v) => v.key === key)?.position).toEqual(position);
    }
  });
});

describe('vehicle merge (M4.6): bookkeeping', () => {
  it('reports the fresh modes and how many ghosts it hid; a matched vehicle keeps its age and both sources', () => {
    const merged = mergeVehicles([G1, O1, M1], batch('swiftly', [train('r2', OFF_GC_790, { tripId: 'T-G1', ageS: 20 })]), NOW);
    expect(merged.freshModes).toEqual(['rail']);
    expect(merged.hiddenGhosts).toBe(1);
    expect(merged.vehicles[0]).toMatchObject({ key: '20261001:B-G1', ageS: 20, tripId: 'T-G1', scheduled: G1, bearing: 90 });
  });
});
