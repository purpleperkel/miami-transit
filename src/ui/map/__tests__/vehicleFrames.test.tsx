import { Text } from 'react-native';
import { act } from 'react-test-renderer';

import type { TimetableOutcome } from '@/data/schedule-repo';
import { pointAlongShape } from '@/domain/schedule/positions';

import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { type FrameTimetable, framesAt, NO_SHOWN, planFrames, SAMPLE_S, type VehicleFrame } from '../vehicleFrames';
import { type TimetableSource, useVehicleFrames } from '../useVehicleFrames';
import { liveBatch, liveVehicle, THREE_STOPS, trackShape, trackTrip, WED, WED_0800 } from './map-fixtures';

/**
 * M5.10 vehicle frames over a synthetic timetable: one Orange trip on a straight 2 km track due
 * east (stops at 0, 1000, 2000 m). Scheduled vehicles are placed by the timetable at every tick; a
 * live vehicle matched to the trip is reconciled along the same track.
 */

const SHAPE = trackShape();
const TIMETABLE: FrameTimetable = { days: [{ day: WED, trips: [trackTrip(THREE_STOPS)] }], shapes: new Map([[0, SHAPE]]) };
/** 08:01:15: the timetable has the train halfway to the second stop (500 m). */
const T = WED_0800 + 75;

afterEach(async () => {
  await unmountAll();
});

/** The single vehicle of a frame. */
function only(frames: readonly VehicleFrame[]): VehicleFrame {
  expect(frames).toHaveLength(1);
  const [vehicle] = frames;
  expect(vehicle).toBeDefined();
  return vehicle as VehicleFrame;
}

describe('vehicle frames (M5.10)', () => {
  it('a scheduled vehicle moves along its track at every tick, never backward', () => {
    const plan = planFrames(TIMETABLE, null, T);
    const longitudes = [0, 0.25, 0.5, 0.75, 1, 5, 10].map((dt) => only(framesAt(plan, T + dt, NO_SHOWN).frames).coordinate);
    expect(longitudes.every((point) => Math.abs(point.latitude - 25.77) < 1e-9)).toBe(true);
    expect(longitudes.every((point, i) => i === 0 || point.longitude > (longitudes[i - 1]?.longitude ?? Infinity))).toBe(true);
    expect(only(framesAt(plan, T, NO_SHOWN).frames)).toMatchObject({ source: 'scheduled', key: '20260930:block-1', live: null, bearing: expect.closeTo(90, 0) });
  });

  it('a fresh live vehicle replaces its ghost and glides on along the track', () => {
    const fix = pointAlongShape(SHAPE, 400);
    const plan = planFrames(TIMETABLE, liveBatch('transitland', [liveVehicle(fix, T)], T), T);
    const first = framesAt(plan, T, NO_SHOWN);
    const vehicle = only(first.frames);
    expect(vehicle).toMatchObject({ key: '20260930:block-1', source: 'live', live: { provider: 'transitland', ageS: 0 } });
    expect(vehicle.coordinate.longitude).toBeCloseTo(fix.longitude, 9);
    const later = only(framesAt(plan, T + 9, first.shown).frames);
    expect(later.coordinate.longitude).toBeGreaterThan(fix.longitude);
    expect(later.live?.ageS).toBe(9);
  });

  it('a new fix 30 m behind holds the marker; 60 m behind snaps it back', () => {
    const plan = planFrames(TIMETABLE, liveBatch('swiftly', [liveVehicle(pointAlongShape(SHAPE, 500), T)], T), T);
    const shown = framesAt(plan, T, NO_SHOWN).shown;
    const drawnAt = only(framesAt(plan, T, NO_SHOWN).frames).coordinate;
    const behind = planFrames(TIMETABLE, liveBatch('swiftly', [liveVehicle(pointAlongShape(SHAPE, 470), T)], T), T);
    expect(only(framesAt(behind, T, shown).frames).coordinate.longitude).toBeCloseTo(drawnAt.longitude, 9);
    const farBehind = planFrames(TIMETABLE, liveBatch('swiftly', [liveVehicle(pointAlongShape(SHAPE, 440), T)], T), T);
    expect(only(framesAt(farBehind, T, shown).frames).coordinate.longitude).toBeCloseTo(pointAlongShape(SHAPE, 440).longitude, 9);
  });

  it('a live vehicle with no trip to follow is drawn at its fix', () => {
    const fix = { latitude: 25.78, longitude: -80.19 };
    const plan = planFrames(TIMETABLE, liveBatch('transitland', [liveVehicle(fix, T - 20, null)], T), T);
    const frames = framesAt(plan, T + 5, NO_SHOWN).frames;
    const live = frames.find((vehicle) => vehicle.source === 'live');
    expect(live).toMatchObject({ key: 'live:syn-vehicle-1', coordinate: fix, bearing: 90, live: { ageS: 25 } });
    // The rail feed is fresh, so the unmatched rail ghost is hidden (§4 merge rule 5).
    expect(frames.filter((vehicle) => vehicle.source === 'scheduled')).toHaveLength(0);
  });
});

/** Renders the hook against a counting timetable source and a clock the test moves. */
async function renderFrames(source: TimetableSource, clock: { ms: number }, tickMs: number) {
  const seen: VehicleFrame[][] = [];
  // One clock identity for every render, as the hook requires.
  function readClock(): number {
    expect(Number.isFinite(clock.ms)).toBe(true);
    expect(clock.ms).toBeGreaterThan(0);
    return clock.ms;
  }
  function Probe() {
    const frames = useVehicleFrames(source, null, tickMs, readClock);
    expect(frames.vehicles.length).toBeLessThanOrEqual(1);
    expect(frames.atS === null || frames.atS * 1000 <= clock.ms).toBe(true);
    seen.push([...frames.vehicles]);
    return <Text>{frames.vehicles.length}</Text>;
  }
  const tree = await renderPrimitive(<Probe />);
  expect(seen.length).toBeGreaterThan(0);
  expect(tree.toJSON()).not.toBeNull();
  return { tree, seen };
}

/** A source over TIMETABLE that counts its reads. */
function countingSource(): TimetableSource & { calls: number } {
  const source = {
    calls: 0,
    timetableAround(fromEpoch: number, toEpoch: number): TimetableOutcome {
      source.calls += 1;
      expect(Number.isSafeInteger(fromEpoch)).toBe(true);
      expect(toEpoch - fromEpoch).toBe(SAMPLE_S);
      return { kind: 'timetable', fromEpoch, toEpoch, days: TIMETABLE.days, shapes: TIMETABLE.shapes };
    },
  };
  expect(source.calls).toBe(0);
  expect(typeof source.timetableAround).toBe('function');
  return source;
}

describe('useVehicleFrames (M5.10)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reads the timetable once per sample, not per frame', async () => {
    const source = countingSource();
    const clock = { ms: T * 1000 };
    const { seen } = await renderFrames(source, clock, 250);
    for (let tick = 0; tick < 40; tick += 1) {
      clock.ms += 250;
      await act(async () => {
        jest.advanceTimersByTime(250);
      });
    }
    // 41 frames over 10 s, one timetable read; the train moved east every frame.
    expect(source.calls).toBe(1);
    const longitudes = seen.filter((frames) => frames.length === 1).map((frames) => frames[0]?.coordinate.longitude ?? NaN);
    expect(longitudes.length).toBeGreaterThanOrEqual(40);
    expect(longitudes.every((longitude, i) => i === 0 || longitude >= (longitudes[i - 1] ?? Infinity))).toBe(true);
    clock.ms += SAMPLE_S * 1000;
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(source.calls).toBe(2);
  });

  it('draws one frame and starts no timer when the map is out of sight (tick 0)', async () => {
    const source = countingSource();
    const clock = { ms: T * 1000 };
    const { seen } = await renderFrames(source, clock, 0);
    const before = seen.length;
    clock.ms += 5000;
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(seen.length).toBe(before);
    expect(source.calls).toBe(1);
  });
});
