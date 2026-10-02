import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { NextStopsOutcome } from '../../../src/data/schedule-repo';
import { MAX_NEXT_STOPS, type NextStop } from '../../../src/domain/schedule/next-stops';
import type { ScheduledVehicle } from '../../../src/domain/schedule/positions';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M6.6: ScheduleRepo.nextStops — the vehicle sheet's next stops (src/domain/schedule/next-stops.ts,
 * which the vehicle route runs) — on the REAL committed schedule DB, in place, for every scheduled
 * vehicle out on Wednesday 2026-09-30 at 08:00 New York time.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const WED_0800 = nyEpoch('2026-09-30T08:00-04:00');

/** Every scheduled vehicle out at `epoch`. */
function vehiclesAt(epoch: number): readonly ScheduledVehicle[] {
  const outcome = repo.vehiclesAt(epoch);
  assert.equal(outcome.kind, 'vehicles');
  assert.ok(outcome.kind === 'vehicles' && outcome.vehicles.length > 0);
  return outcome.kind === 'vehicles' ? outcome.vehicles : [];
}

/** The vehicle's next stops at `epoch`, which the timetable must place. */
function stopsOf(vehicle: ScheduledVehicle, epoch: number): readonly NextStop[] {
  const outcome: NextStopsOutcome = repo.nextStops(vehicle.vehicleKey, epoch);
  assert.equal(outcome.kind, 'next-stops', `${vehicle.vehicleKey} is out at ${epoch}`);
  assert.ok(outcome.kind === 'next-stops' && outcome.lineId === vehicle.lineId);
  return outcome.kind === 'next-stops' ? outcome.stops : [];
}

/** The trip the schedule says the car of `tripIdx` runs next. */
function nextTripOf(tripIdx: number): number | null {
  const row = db.get<{ next_trip_idx: number | null }>('SELECT next_trip_idx FROM trip WHERE trip_idx = :trip_idx', { trip_idx: tripIdx });
  assert.ok(row !== null, `trip ${tripIdx} exists`);
  assert.ok(row.next_trip_idx === null || Number.isSafeInteger(row.next_trip_idx), 'next_trip_idx is a trip index or null');
  return row.next_trip_idx;
}

describe('ScheduleRepo.nextStops on the real schedule DB (M6.6)', () => {
  test('next stops for every vehicle at Wed 08:00 are at most 3 in ascending order', () => {
    const vehicles = vehiclesAt(WED_0800);
    let full = 0;
    for (const vehicle of vehicles) {
      const stops = stopsOf(vehicle, WED_0800);
      assert.ok(stops.length <= MAX_NEXT_STOPS && MAX_NEXT_STOPS === 3, `${vehicle.vehicleKey}: at most 3`);
      assert.ok(stops.every((stop, i) => stop.epoch >= WED_0800 && (i === 0 || stop.epoch > (stops[i - 1] as NextStop).epoch)), `${vehicle.vehicleKey}: ahead, in time order`);
      assert.ok(stops.every((stop, i) => i === 0 || stop.stationKey !== stops[i - 1]?.stationKey), `${vehicle.vehicleKey}: no station twice in a row`);
      full += stops.length === MAX_NEXT_STOPS ? 1 : 0;
    }
    assert.ok(vehicles.length >= 25, `rail and Mover are both out at 08:00 (${vehicles.length} vehicles)`);
    assert.ok(full >= vehicles.length - 5, 'only vehicles nearing a terminal list fewer than 3');
  });

  test('next stops of an Inner Loop car continue onto next_trip_idx', () => {
    const inner = vehiclesAt(WED_0800).filter((vehicle) => vehicle.lineId === 'MM_INNER');
    const crossing = inner.map((vehicle) => ({ vehicle, stops: stopsOf(vehicle, WED_0800) })).find(({ stops }) => stops.some((stop) => stop.tripIdx !== stops[0]?.tripIdx));
    assert.ok(crossing !== undefined, `an Inner Loop car (of ${inner.length}) is near the end of its half-trip at 08:00`);
    const { vehicle, stops } = crossing;
    const onward = stops.filter((stop) => stop.tripIdx !== vehicle.tripIdx);
    assert.ok(onward.length > 0 && onward.every((stop) => stop.tripIdx === nextTripOf(vehicle.tripIdx)), 'the list continues onto the trip next_trip_idx names');
    const junction = db.get<{ station_key: string }>(
      `SELECT x.station_key FROM stop_time AS st JOIN stop AS s ON s.stop_idx = st.stop_idx JOIN station AS x ON x.station_idx = s.station_idx
       WHERE st.trip_idx = :trip_idx ORDER BY st.seq DESC LIMIT 1`,
      { trip_idx: vehicle.tripIdx },
    );
    assert.ok(junction !== null);
    assert.ok(stops.filter((stop) => stop.stationKey === junction.station_key).length <= 1, `the junction ${junction.station_key} is listed once, never twice`);
    assert.ok(stops.every((stop, i) => i === 0 || stop.epoch > (stops[i - 1] as NextStop).epoch));
  });

  test('a train ends its list at its terminal: rail trips are not block-linked', () => {
    for (const vehicle of vehiclesAt(WED_0800).filter((v) => v.mode === 'rail')) {
      assert.equal(nextTripOf(vehicle.tripIdx), null, `${vehicle.vehicleKey} runs an unlinked trip`);
      assert.ok(stopsOf(vehicle, WED_0800).every((stop) => stop.tripIdx === vehicle.tripIdx));
    }
  });

  test('a key the timetable does not run at that instant is not-running', () => {
    assert.deepEqual(repo.nextStops('20260930:no-such-block', WED_0800), { kind: 'not-running', vehicleKey: '20260930:no-such-block' });
    assert.equal(repo.nextStops('20260930:no-such-block', nyEpoch('2027-06-01T08:00-04:00')).kind, 'expired');
  });
});
