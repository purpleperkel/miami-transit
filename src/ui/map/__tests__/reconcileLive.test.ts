import { tripProgressAt } from '@/domain/schedule/positions';

import { PROJECTION_GRACE_S, placeOnShape, projectFix, reconcileLive, scheduleSecondAt, SNAP_DISTANCE_M, type TripTimetable } from '../reconcileLive';
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

  it('snaps at 50 m', () => {
    const fix = { distM: 500, atS: AT_500 };
    expect(reconcileLive(550, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'snap' });
    expect(reconcileLive(450, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'snap' });
    expect(reconcileLive(800, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'snap' });
    expect(reconcileLive(460, fix, TIMETABLE, AT_500)).toEqual({ distM: 500, move: 'glide' });
  });

  it('projection clamped to next stop + 20 s', () => {
    expect(PROJECTION_GRACE_S).toBe(20);
    const fix = { distM: 500, atS: AT_500 };
    // Ten minutes without a new fix: the projection stops 20 s after the next stop's arrival (08:02:00),
    // which is inside that stop's 30 s dwell — the train waits at the 1000 m stop.
    expect(projectFix(fix, TIMETABLE, AT_500 + 600)).toBe(1000);
    // With a 10 s dwell the clamp (08:02:20) lands 10 s out of the station, and no further.
    const shortDwell = { ...TIMETABLE, trip: trackTrip([[28_800, 28_830, 0], [28_920, 28_930, 1000], [29_020, 29_050, 2000]]) };
    const clamped = tripProgressAt(shortDwell.trip, 28_920 + PROJECTION_GRACE_S)?.distM ?? NaN;
    expect(projectFix(fix, shortDwell, AT_500 + 600)).toBeCloseTo(clamped, 9);
    expect(clamped).toBeGreaterThan(1000);
    // Unclamped, ten minutes would carry it past every stop to the trip's end at 2000 m.
    expect(clamped).toBeLessThan(2000);
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

