import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import { pointAlongShape, type ScheduledTrip, type ShapePath } from '@/domain/schedule/positions';
import { haversineMeters, type LatLon } from '@/lib/geo';

import { type FrameTimetable, framesAt, NO_SHOWN, planFrames, projectionUntilS, SAMPLE_S, type ShownTracks } from '../vehicleFrames';
import { liveBatch, trackShapeOf, trackTrip, WED } from './map-fixtures';

/**
 * mfix3 §1–§2, the live map's motion between polls, run through the frames module the map runs
 * (planFrames once per sample, framesAt every tick — replanned every SAMPLE_S as useVehicleFrames does).
 *
 * The Mover cases use the REAL no-dwell trip 4829149 (MM_BRICKELL, block 1403218) from
 * assets/db/schedule.db — its public-schedule stop rows copied below (arr = dep, stops 60 s apart) —
 * laid on a synthetic straight track due east along 25.77° N, so a distance along the track is the
 * distance from the track's start.
 */

/** Trip 4829149's stops: seconds after its 19:30:00 start (arr = dep), and metres along its shape (pattern_stop.dist_m). */
const TRIP_4829149: readonly (readonly [number, number])[] = [
  [0, 48.181205543487],
  [60, 498.902292408959],
  [120, 874.59425050885],
  [180, 1200.32123366933],
  [240, 1453.87696298286],
  [300, 1666.82755260937],
  [360, 1868.14774775229],
  [420, 2407.02164618668],
  [480, 2914.13438208818],
  [540, 3120.84840142186],
  [600, 3465.90174820808],
  [660, 3792.59299836264],
  [720, 4181.12467191658],
];
const TRIP_START_S = 70_200;
const MOVER_SHAPE: ShapePath = trackShapeOf(Array.from({ length: 12 }, (_, i) => ({ latitude: 25.77, longitude: -80.21 + i * 0.004 })));
const MOVER_KEY = `${WED.date}:1403218`;

function moverTrip(): ScheduledTrip {
  const trip: ScheduledTrip = {
    tripIdx: 672,
    tripId: '4829149',
    blockId: '1403218',
    lineId: 'MM_BRICKELL',
    mode: 'mover',
    directionId: 0,
    shapeIdx: 1,
    stops: TRIP_4829149.map(([afterS, distM]) => ({ arrS: TRIP_START_S + afterS, depS: TRIP_START_S + afterS, distM })),
  };
  expect(trip.stops.every((stop) => stop.arrS === stop.depS)).toBe(true);
  expect(MOVER_SHAPE.distM.at(-1) ?? 0).toBeGreaterThan(4_181);
  return trip;
}

const MOVER: FrameTimetable = { days: [{ day: WED, trips: [moverTrip()] }], shapes: new Map([[1, MOVER_SHAPE]]) };

/** The epoch second `afterS` seconds into trip 4829149 (on time). */
function tripTime(afterS: number): number {
  const epoch = WED.baseEpoch + TRIP_START_S + afterS;
  expect(Number.isFinite(epoch)).toBe(true);
  expect(epoch).toBeGreaterThan(WED.baseEpoch);
  return epoch;
}

/** A live Mover car `distM` metres along the track, measured at `timestamp`, running `tripId`. */
function moverFix(distM: number, timestamp: number, shape: ShapePath = MOVER_SHAPE, tripId = '4829149'): LiveVehicle {
  const vehicle: LiveVehicle = {
    vehicleId: 'mover-51',
    label: '51',
    tripId,
    routeId: '14456',
    mode: 'mover',
    lineId: 'MM_BRICKELL',
    lineSource: 'trip',
    directionId: 0,
    position: pointAlongShape(shape, distM),
    bearing: 90,
    speedMps: null,
    stopId: null,
    stopStatus: null,
    timestamp,
  };
  expect(Number.isSafeInteger(timestamp)).toBe(true);
  expect(vehicle.position.latitude).toBeCloseTo(25.77, 6);
  return vehicle;
}

/** Metres along the straight track from its start to a drawn point. */
function along(point: LatLon): number {
  const metres = haversineMeters(MOVER_SHAPE.points[0] as LatLon, point);
  expect(Number.isFinite(metres)).toBe(true);
  expect(point.latitude).toBeCloseTo(25.77, 6);
  return metres;
}

type Sample = { readonly atS: number; readonly point: LatLon };
type Run = { readonly fromS: number; readonly toS: number; readonly stepS: number };

/** The live vehicle's drawn point at every step of `run`, with no new poll; replanned every SAMPLE_S as the map does. */
function drive(timetable: FrameTimetable, batch: LiveBatch<LiveVehicle>, run: Run, start: ShownTracks = NO_SHOWN): { samples: Sample[]; shown: ShownTracks } {
  let plan = planFrames(timetable, batch, Math.floor(run.fromS));
  let shown = start;
  const samples: Sample[] = [];
  for (let i = 0; run.fromS + i * run.stepS <= run.toS + 1e-9; i += 1) {
    const atS = run.fromS + i * run.stepS;
    if (atS > plan.toS) {
      plan = planFrames(timetable, batch, Math.floor(atS));
    }
    const drawn = framesAt(plan, atS, shown);
    shown = drawn.shown;
    const live = drawn.frames.filter((frame) => frame.source === 'live');
    expect(live).toHaveLength(1);
    samples.push({ atS, point: (live[0] as (typeof live)[number]).coordinate });
  }
  expect(samples.length).toBeGreaterThan(0);
  return { samples, shown };
}

/** Where a fresh placement of the batch's vehicle lands at `atS`: the projection itself, nothing carried. */
function projectionAt(timetable: FrameTimetable, batch: LiveBatch<LiveVehicle>, atS: number): LatLon {
  const live = framesAt(planFrames(timetable, batch, Math.floor(atS)), atS, NO_SHOWN).frames.filter((frame) => frame.source === 'live');
  expect(live).toHaveLength(1);
  expect(SAMPLE_S).toBe(15);
  return (live[0] as (typeof live)[number]).coordinate;
}

describe('mover motion between polls (mfix3 §1)', () => {
  it('a mover keeps moving every second for 60 s between polls', () => {
    // On time half-way 499 → 875 m (90 s into the trip), the fix 10 s old when Transitland's batch arrives.
    const fetchedAt = tripTime(100);
    const batch = liveBatch('transitland', [moverFix((498.902292408959 + 874.59425050885) / 2, tripTime(90))], fetchedAt);
    expect(projectionUntilS(batch)).toBe(fetchedAt + 90);
    const { samples } = drive(MOVER, batch, { fromS: fetchedAt, toS: fetchedAt + 80, stepS: 1 });
    const metres = samples.map((sample) => along(sample.point));
    expect(metres.slice(0, 61).every((m, i) => i === 0 || m > (metres[i - 1] as number))).toBe(true);
    // The clamp (fetch + 90 s) lets it reach the 1200 m station at fetch + 80 s.
    expect(Math.abs((metres[80] as number) - 1200.32123366933)).toBeLessThan(1);
  });

  it('a projection that runs out holds at a station', () => {
    // On time AT the 499 m stop (60 s in), 10 s old: the timetable reaches 875 m at fetch + 50 s and 1200 m
    // only at fetch + 110 s, after the clamp (fetch + 90 s) — so the marker waits at 875 m.
    const fetchedAt = tripTime(70);
    const batch = liveBatch('transitland', [moverFix(498.902292408959, tripTime(60))], fetchedAt);
    const { samples } = drive(MOVER, batch, { fromS: fetchedAt, toS: fetchedAt + 120, stepS: 1 });
    const held = samples.filter((sample) => sample.atS >= fetchedAt + 50).map((sample) => along(sample.point));
    expect(held).toHaveLength(71);
    expect(held.every((m) => Math.abs(m - 874.59425050885) < 1)).toBe(true);
    expect(along((samples[25] as Sample).point)).toBeLessThan(874.59425050885);
  });
});

describe('rail motion between polls (mfix3 §1)', () => {
  it('the projection runs until 30 s after the next poll was due', () => {
    // A rail leg: stops at 0 m (08:00:00), 1000 m (08:01:40) and 2000 m (08:02:40.5), no dwell. The fix is on
    // time 5 m out (08:00:00.5), 10 s old at the fetch: the timetable reaches 1000 m at fetch + 89.5 s and
    // 2000 m at fetch + 150 s. Transitland's clamp is fetch + 60 + 30 = 90 s.
    const shape = trackShapeOf(Array.from({ length: 6 }, (_, i) => ({ latitude: 25.77, longitude: -80.21 + i * 0.004 })));
    const timetable: FrameTimetable = { days: [{ day: WED, trips: [trackTrip([[28_800, 28_800, 0], [28_900, 28_900, 1000], [28_960.5, 28_960.5, 2000]])] }], shapes: new Map([[0, shape]]) };
    const fixAt = WED.baseEpoch + 28_800;
    const fix = { ...moverFix(0, fixAt, shape, 'syn-trip-1'), position: pointAlongShape(shape, 5), routeId: '31009', mode: 'rail' as const, lineId: 'ORANGE' as const };
    const batch = liveBatch('transitland', [fix], fixAt + 10);
    expect(projectionUntilS(batch)).toBe(fixAt + 100);
    const { samples } = drive(timetable, batch, { fromS: fixAt + 10, toS: fixAt + 130, stepS: 1 });
    const metres = samples.map((sample) => haversineMeters(shape.points[0] as LatLon, sample.point));
    // Still advancing at fetch + 89 s; within 1 m of the 1000 m stop from fetch + 90 s on; not past it at fetch + 120 s.
    expect((metres[89] as number) > (metres[88] as number) && (metres[89] as number) < 1000 - 1).toBe(true);
    expect(metres.slice(90).every((m) => Math.abs(m - 1000) < 1)).toBe(true);
    expect(metres[120] as number).toBeLessThan(1000 + 1);
  });
});

/** The Mover marker after running on batch 1 (on time, 90 s in) to `t0` = 95 s in: where it is drawn, and the carried tracks. */
function markerAtT0(): { readonly t0: number; readonly x: number; readonly shown: ShownTracks } {
  const first = liveBatch('transitland', [moverFix(686.748271458904, tripTime(90))], tripTime(90));
  const t0 = tripTime(95);
  const { shown } = drive(MOVER, first, { fromS: tripTime(90), toS: t0, stepS: 0.25 });
  const x = shown.get(MOVER_KEY)?.distM ?? NaN;
  expect(x).toBeGreaterThan(686);
  expect(x).toBeLessThan(760);
  return { t0, x, shown };
}

describe('corrections on a new poll (mfix3 §2)', () => {
  it('a 150 m correction eases in under 1.25 s', () => {
    const { t0, x, shown } = markerAtT0();
    const second = liveBatch('transitland', [moverFix(x + 150, t0)], t0);
    const { samples } = drive(MOVER, second, { fromS: t0 + 0.25, toS: t0 + 1.25, stepS: 0.25 }, shown);
    // The first 250 ms tick moves it less than 150 m — and forward.
    const firstStep = along((samples[0] as Sample).point) - x;
    expect(firstStep > 0 && firstStep < 150).toBe(true);
    const last = samples.at(-1) as Sample;
    expect(Math.abs(along(last.point) - along(projectionAt(MOVER, second, last.atS)))).toBeLessThan(1);
  });

  it('a correction of 500 m or more snaps', () => {
    const { t0, x, shown } = markerAtT0();
    // 500 m and 900 m ahead, and 520 m behind: each one jumps the marker onto the projection at the first tick.
    for (const correctionM of [500, 900, -520]) {
      const second = liveBatch('transitland', [moverFix(x + correctionM, t0)], t0);
      const { samples } = drive(MOVER, second, { fromS: t0 + 0.25, toS: t0 + 0.25, stepS: 0.25 }, shown);
      const drawn = along((samples[0] as Sample).point);
      expect([correctionM, Math.abs(drawn - along(projectionAt(MOVER, second, t0 + 0.25))) < 1e-6]).toEqual([correctionM, true]);
      expect([correctionM, Math.abs(drawn - x) >= 500]).toEqual([correctionM, true]);
    }
  });
});

describe('corrections that would go backward (mfix3 §2)', () => {
  it('a 200 m backward correction holds the marker', () => {
    const { t0, x, shown } = markerAtT0();
    const second = liveBatch('transitland', [moverFix(x - 200, t0)], t0);
    const { samples } = drive(MOVER, second, { fromS: t0 + 1, toS: t0 + 60, stepS: 1 }, shown);
    const drawn = samples.map((sample) => along(sample.point));
    const projected = samples.map((sample) => along(projectionAt(MOVER, second, sample.atS)));
    // No tick moves it backward: it holds at x until the new projection passes x, then moves on with it.
    expect(drawn.every((m, i) => m >= (i === 0 ? x : (drawn[i - 1] as number)) - 1e-6)).toBe(true);
    const passed = projected.findIndex((m) => m > x);
    expect(passed).toBeGreaterThan(5);
    expect(drawn.slice(0, passed).every((m) => Math.abs(m - x) < 1e-6)).toBe(true);
    expect(drawn.slice(passed).every((m, i) => Math.abs(m - (projected[passed + i] as number)) < 1)).toBe(true);
  });
});

/** Six points due east along 25.77° N from `fromLon`, 0.004° (about 400 m) apart. */
function eastFrom(fromLon: number): LatLon[] {
  const points = Array.from({ length: 6 }, (_, i) => ({ latitude: 25.77, longitude: fromLon + i * 0.004 }));
  expect(points).toHaveLength(6);
  expect(points.every((p, i) => i === 0 || p.longitude > (points[i - 1] as LatLon).longitude)).toBe(true);
  return points;
}

/**
 * A block of two Inner Loop half-trips on one straight synthetic track: trip A runs 0 → 2000 m of its
 * shape (08:00:00 → 08:03:20, no dwell); trip B's shape starts 200 m before the join (shapes are extended
 * past their terminals in schedule.db) and runs on from the join at 08:03:20.
 */
function twoTrips(): { readonly timetable: FrameTimetable; readonly shapeB: ShapePath; readonly key: string } {
  const shapeA = trackShapeOf(eastFrom(-80.21));
  const shapeB = trackShapeOf(eastFrom(-80.21 + 0.004 * 4.5));
  const joinB = haversineMeters(shapeB.points[0] as LatLon, pointAlongShape(shapeA, 2000));
  const tripA = { ...trackTrip([[28_800, 28_800, 0], [29_000, 29_000, 2000]], 'loop-a', 'loop-1'), lineId: 'MM_INNER', mode: 'mover' as const };
  const tripB = { ...trackTrip([[29_000, 29_000, joinB], [29_100, 29_100, joinB + 1000]], 'loop-b', 'loop-1'), tripIdx: 2, shapeIdx: 1, lineId: 'MM_INNER', mode: 'mover' as const };
  expect(joinB).toBeGreaterThan(150);
  expect(joinB).toBeLessThan(250);
  return { timetable: { days: [{ day: WED, trips: [tripA, tripB] }], shapes: new Map([[0, shapeA], [1, shapeB]]) }, shapeB, key: `${WED.date}:loop-1` };
}

describe('a vehicle re-matched to its next trip (mfix3 §2)', () => {
  it('a trip change carries the marker without a jump', () => {
    const { timetable, shapeB } = twoTrips();
    const [shapeA] = [timetable.shapes.get(0) as ShapePath];
    // Trip A, on time 1500 m out; the marker runs on to 1990 m by 08:03:19.
    const onA = { ...moverFix(1500, WED.baseEpoch + 28_950, shapeA, 'loop-a'), routeId: '14457', lineId: 'MM_INNER' as const };
    const { samples: before, shown } = drive(timetable, liveBatch('transitland', [onA], WED.baseEpoch + 28_950), { fromS: WED.baseEpoch + 28_950, toS: WED.baseEpoch + 28_999, stepS: 1 });
    const lastOnA = (before.at(-1) as Sample).point;
    // The next poll matches the car to trip B, its fix 150 m behind where the marker is drawn.
    const markerOnB = haversineMeters(shapeB.points[0] as LatLon, lastOnA);
    const onB = { ...moverFix(markerOnB - 150, WED.baseEpoch + 29_005, shapeB, 'loop-b'), routeId: '14457', lineId: 'MM_INNER' as const };
    const { samples: after } = drive(timetable, liveBatch('transitland', [onB], WED.baseEpoch + 29_005), { fromS: WED.baseEpoch + 29_005, toS: WED.baseEpoch + 29_005, stepS: 1 }, shown);
    expect(haversineMeters(lastOnA, (after[0] as Sample).point)).toBeLessThan(10);
    expect(haversineMeters(lastOnA, onB.position)).toBeGreaterThan(140);
  });
});
