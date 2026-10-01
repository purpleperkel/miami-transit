import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { placeVehicle, scheduledVehicles, vehicleBlocks } from '../../../src/domain/schedule/positions';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M5.10 on the REAL committed schedule DB: the map reads the timetable ONCE per 15 s sample
 * (ScheduleRepo.timetableAround) and places the vehicles at every frame from it. That is only right if
 * the span's timetable places them exactly as vehiclesAt does at every second of the span, and moves
 * them smoothly between seconds — checked here at Wed 2026-09-30 08:00 New York and across midnight.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const SAMPLE_S = 15;

/** The span's timetable, which must be a real one. */
function timetableFrom(fromEpoch: number) {
  const outcome = repo.timetableAround(fromEpoch, fromEpoch + SAMPLE_S);
  assert.equal(outcome.kind, 'timetable', `the calendar runs at ${fromEpoch}`);
  assert.ok(outcome.kind === 'timetable' && outcome.days.length > 0, 'at least one service day runs');
  return outcome;
}

describe('the timetable behind the map\'s frames (M5.10, real DB)', () => {
  for (const [label, iso, serviceDays] of [
    ['Wed 08:00', '2026-09-30T08:00-04:00', 1],
    ['Thu 00:30, two service days', '2026-10-01T00:30-04:00', 2],
  ] as const) {
    test(`${label}: every second of the span places the vehicles exactly as vehiclesAt does`, () => {
      const from = nyEpoch(iso);
      const timetable = timetableFrom(from);
      assert.equal(timetable.days.length, serviceDays, `${label} reads ${serviceDays} service day(s)`);
      let vehicles = 0;
      for (let epoch = from; epoch <= from + SAMPLE_S; epoch += 1) {
        const direct = repo.vehiclesAt(epoch);
        assert.ok(direct.kind === 'vehicles', `vehicles run at ${epoch}`);
        assert.deepEqual(scheduledVehicles(epoch, timetable.days, timetable.shapes), direct.vehicles);
        vehicles += direct.vehicles.length;
      }
      assert.ok(vehicles > 0, 'the span has vehicles to compare');
    });
  }

  test('between whole seconds a vehicle sits between its two whole-second places, never behind', () => {
    const from = nyEpoch('2026-09-30T08:00-04:00');
    const timetable = timetableFrom(from);
    let moving = 0;
    for (const block of vehicleBlocks(timetable.days)) {
      const [a, half, b] = [0, 0.5, 1].map((dt) => placeVehicle(block, from + 7 + dt, timetable.shapes));
      if (a && half && b && a.tripIdx === b.tripIdx && b.distM > a.distM) {
        assert.ok(half.distM >= a.distM && half.distM <= b.distM, `${block.vehicleKey} moves forward through the half second`);
        moving += 1;
      }
    }
    assert.ok(moving >= 10, `${moving} vehicles were moving at 08:00:07`);
  });
});
