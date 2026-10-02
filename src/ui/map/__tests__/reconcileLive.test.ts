import { tripProgressAt } from '@/domain/schedule/positions';

import {
  JUMP_DISTANCE_M,
  placeOnShape,
  PROJECTION_MARGIN_S,
  projectFix,
  reconcileLive,
  scheduleSecondAt,
  SNAP_DISTANCE_M,
  type TripTimetable,
} from '../reconcileLive';
import { THREE_STOPS, TRACK_POINTS, trackShape, trackShapeOf, trackTrip, WED } from './map-fixtures';

/**
 * M5.10 live reconciliation, in metres along a synthetic trip: stops at 0, 1000 and 2000 m, leaving
 * the first at 08:00:30, 90 s to each next stop, 30 s dwells. A fix is measured at `atS`; the marker
 * is drawn at `shownM` until the rule moves it.
 */

const TIMETABLE: TripTimetable = { trip: trackTrip(THREE_STOPS), baseEpoch: WED.baseEpoch };
/** 08:01:15 — on time, the trip is halfway between the first two stops (500 m). */
const AT_500 = WED.baseEpoch + 28_875;

describe('reconcileLive (M5.10)', () => {
  it('never moves back under 50 m', () => {
    expect(SNAP_DISTANCE_M).toBe(50);
    const fix = { distM: 500, atS: AT_500 };
    for (const behindM of [1, 10, 30, 49, 49.99]) {
      const reconciled = reconcileLive(500 + behindM, fix, TIMETABLE, AT_500);
      expect([reconciled.move, reconciled.distM]).toEqual(['hold', 500 + behindM]);
    }
    // The held marker moves on once the projection passes it (90 s per 1000 m: 1 s ≈ 11 m).
    expect(reconcileLive(530, fix, TIMETABLE, AT_500 + 4)).toMatchObject({ move: 'glide' });
  });

  it('a correction from 50 m eases in and from 500 m jumps', () => {
    expect([SNAP_DISTANCE_M, JUMP_DISTANCE_M]).toEqual([50, 500]);
    const fix = { distM: 500, atS: AT_500 };
    // Under 50 m the marker simply follows the projection; from 50 m forward it eases in (mfix3 §2).
    expect(reconcileLive(460, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'glide' });
    expect(reconcileLive(450, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'ease' });
    expect(reconcileLive(100.01, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'ease' });
    // Backward under 500 m it holds; 500 m or more either way, it jumps at once.
    expect(reconcileLive(800, fix, TIMETABLE, AT_500)).toEqual({ distM: 800, move: 'hold' });
    expect(reconcileLive(0, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'snap' });
    expect(reconcileLive(1000, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'snap' });
  });

  it('projection clamped to the last stop reached by fetch + cadence + 30 s', () => {
    expect(PROJECTION_MARGIN_S).toBe(30);
    const fix = { distM: 500, atS: AT_500 };
    // On time at 500 m at 08:01:15; the 1000 m stop is reached 45 s on (08:02:00), left at 08:02:30, 2000 m reached 165 s on.
    // A clamp 60 s on reaches the 1000 m stop: ten minutes later the train still waits there, never mid-track.
    expect(projectFix({ ...fix, untilS: AT_500 + 60 }, TIMETABLE, AT_500 + 600)).toBe(1000);
    // A clamp 30 s on reaches no stop: the projection holds at the fix itself.
    expect(projectFix({ ...fix, untilS: AT_500 + 30 }, TIMETABLE, AT_500 + 20)).toBe(500);
    // A clamp 170 s on reaches the 2000 m stop, so the train runs on past the 1000 m stop's departure;
    // 140 s on it does not, and the train waits at 1000 m.
    expect(projectFix({ ...fix, untilS: AT_500 + 170 }, TIMETABLE, AT_500 + 100)).toBeCloseTo(1000 + (25 / 90) * 1000, 6);
    expect(projectFix({ ...fix, untilS: AT_500 + 140 }, TIMETABLE, AT_500 + 100)).toBe(1000);
    expect(tripProgressAt(TIMETABLE.trip, 28_875 + 100)?.state).toBe('moving');
  });
});

describe('reconcileLive projection (M5.10)', () => {
  it('a fix runs on at the timetable pace, keeping its delay', () => {
    // On time at 500 m: 30 s later the timetable has it 1/3 of a leg further.
    expect(projectFix({ distM: 500, atS: AT_500 }, TIMETABLE, AT_500 + 30)).toBeCloseTo(500 + 1000 / 3, 6);
    // Two minutes late at 500 m: the same 30 s carry it the same distance — the delay is kept, not caught up.
    expect(projectFix({ distM: 500, atS: AT_500 + 120 }, TIMETABLE, AT_500 + 150)).toBeCloseTo(500 + 1000 / 3, 6);
    expect(scheduleSecondAt(TIMETABLE.trip, 1000)).toBe(28_920);
  });

  it('places a fix on the track and says how far off it lies', () => {
    const shape = trackShape();
    const second = TRACK_POINTS[1] as (typeof TRACK_POINTS)[number];
    const placed = placeOnShape(shape, { latitude: second.latitude + 0.0002, longitude: second.longitude }, 0);
    expect(placed.distM).toBeCloseTo(shape.distM[1] ?? NaN, 0);
    expect(placed.offsetM).toBeGreaterThan(20);
    expect(placed.offsetM).toBeLessThan(25);
  });

  it('on a loop passing the same place twice, the timetable\'s own place decides', () => {
    // Out along the track and back on itself: every point is passed twice, 2 km apart along the shape.
    const there = [...TRACK_POINTS];
    const loop = trackShapeOf([...there, ...there.slice(0, -1).reverse()]);
    const lengthM = loop.distM[loop.distM.length - 1] ?? NaN;
    const point = TRACK_POINTS[2] as (typeof TRACK_POINTS)[number];
    const outbound = placeOnShape(loop, point, 0);
    const inbound = placeOnShape(loop, point, lengthM);
    expect(outbound.distM).toBeLessThan(lengthM / 2);
    expect(inbound.distM).toBeGreaterThan(lengthM / 2);
    expect(outbound.distM + inbound.distM).toBeCloseTo(lengthM, 3);
  });
});

