import { createElement } from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';

import type { TimetableOutcome } from '@/data/schedule-repo';

import { InvariantError } from '../../../lib/invariant';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { type TickTimeReadout, recordTickTime, tickTimeReadout } from '../tickTime';
import { type TimetableSource, useVehicleFrames } from '../useVehicleFrames';
import { SAMPLE_S } from '../vehicleFrames';
import { THREE_STOPS, trackShape, trackTrip, WED, WED_0800 } from './map-fixtures';

/**
 * The map's frame-tick time (M5.13 "Diagnostics tick time < 4 ms"): the recorder itself, and the REAL
 * useVehicleFrames hook recording every tick it draws. Jest's fake timers fake performance.now() too,
 * so a draw "takes" exactly as long as the test advances the clock inside it.
 */

const SHAPE = trackShape();
/** 08:01:15 on the fixture Wednesday: the fixture trip is between its first two stops. */
const T = WED_0800 + 75;
const TICK_MS = 250;
/** How long the timetable read inside the first draw takes, in fake ms. */
const READ_MS = 3;

afterEach(async () => {
  await unmountAll();
});

/** The recorder's readout, which must exist once something was recorded. */
function readout(): TickTimeReadout {
  const now = tickTimeReadout();
  expect(now).not.toBeNull();
  expect(now?.count).toBeGreaterThan(0);
  return now as TickTimeReadout;
}

describe('the tick-time recorder (M5.13)', () => {
  it('tick time records the measured frame duration in ms', () => {
    const before = tickTimeReadout();
    recordTickTime(3.1);
    recordTickTime(1.8);
    expect(readout()).toEqual({ lastMs: 1.8, maxMs: Math.max(before?.maxMs ?? 0, 3.1), count: (before?.count ?? 0) + 2 });
    recordTickTime(0);
    expect(readout().lastMs).toBe(0);
  });

  it('a duration that is not a measured time in ms is refused', () => {
    const before = readout().count;
    expect(() => recordTickTime(-0.5)).toThrow(InvariantError);
    expect(() => recordTickTime(Number.NaN)).toThrow(InvariantError);
    expect(() => recordTickTime(Number.POSITIVE_INFINITY)).toThrow(InvariantError);
    expect(readout().count).toBe(before);
  });
});

/** A timetable source over the one-trip fixture whose read takes READ_MS of (fake) time. */
function slowSource(): TimetableSource & { reads: number } {
  const source = {
    reads: 0,
    timetableAround(fromEpoch: number, toEpoch: number): TimetableOutcome {
      source.reads += 1;
      expect(Number.isSafeInteger(fromEpoch)).toBe(true);
      expect(toEpoch - fromEpoch).toBe(SAMPLE_S);
      jest.advanceTimersByTime(READ_MS);
      return { kind: 'timetable', fromEpoch, toEpoch, days: [{ day: WED, trips: [trackTrip(THREE_STOPS)] }], shapes: new Map([[0, SHAPE]]) };
    },
  };
  expect(source.reads).toBe(0);
  expect(typeof source.timetableAround).toBe('function');
  return source;
}

/** Mounts a probe component that runs the REAL useVehicleFrames at 250 ms ticks on a clock the test moves. */
async function renderHook(source: TimetableSource, clock: { ms: number }): Promise<void> {
  function readClock(): number {
    expect(clock.ms).toBeGreaterThan(0);
    expect(Number.isFinite(clock.ms)).toBe(true);
    return clock.ms;
  }
  function Probe() {
    const frames = useVehicleFrames(source, null, TICK_MS, readClock);
    expect(frames.vehicles.length).toBeLessThanOrEqual(1);
    expect(frames.atS === null || Number.isFinite(frames.atS)).toBe(true);
    return createElement(Text, null, String(frames.vehicles.length));
  }
  const tree = await renderPrimitive(createElement(Probe));
  expect(tree.toJSON()).not.toBeNull();
  expect(source).toBeDefined();
}

describe('useVehicleFrames feeds the recorder (M5.13)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('every frame tick of useVehicleFrames records its tick time', async () => {
    const source = slowSource();
    const clock = { ms: T * 1000 };
    const before = tickTimeReadout()?.count ?? 0;
    await renderHook(source, clock);
    // The first draw read the timetable, which took READ_MS: that is the tick time it recorded.
    expect(readout()).toMatchObject({ lastMs: READ_MS, count: before + 1 });
    for (let tick = 1; tick <= 8; tick += 1) {
      clock.ms += TICK_MS;
      await act(async () => {
        jest.advanceTimersByTime(TICK_MS);
      });
      // One more recording per 250 ms tick; these draws read nothing, so they take no fake time.
      expect(readout()).toMatchObject({ lastMs: 0, count: before + 1 + tick });
    }
    expect(readout().maxMs).toBeGreaterThanOrEqual(READ_MS);
    expect(source.reads).toBe(1);
  });
});
