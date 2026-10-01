import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { type TimeWindow, windowFrom } from '../../../src/domain/gtfs/service-day';
import type { Ride } from '../../../src/domain/schedule/rides';
import { expectOk } from './expect-result';
import { nyEpoch, openRealRepo, openRealScheduleDb, stationKeyNamed } from './real-schedule';

/**
 * M3.4: rides between stations through ScheduleRepo, on the REAL committed schedule DB. Station
 * keys are looked up by name in the DB's station table, never guessed.
 * 2026-09-30 is a Wednesday; 2026-10-03 is a Saturday.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

const RAIL = 0;
const MOVER = 1;
const MINUTES = 60;
const WED_0800 = windowFrom(nyEpoch('2026-09-30T08:00-04:00'), 30 * MINUTES);

function ridesBetween(fromKey: string, toKey: string, window: TimeWindow): readonly Ride[] {
  const outcome = expectOk(repo.rides(fromKey, toKey, window));
  assert.equal(outcome.kind, 'rides', `expected rides ${fromKey} -> ${toKey}, got ${JSON.stringify(outcome)}`);
  const rides = outcome.kind === 'rides' ? outcome.rides : [];
  assert.ok(rides.every((r) => r.depEpoch >= window.fromEpoch && r.depEpoch <= window.toEpoch && r.arrEpoch >= r.depEpoch));
  return rides;
}

/** Raw DB truth about one stop of a trip: its station key and the trip's next_trip_idx. */
function stopOf(tripIdx: number, stopId: string): { stationKey: string; nextTripIdx: number | null; lineId: string } {
  const row = db.get<{ station_key: string; next_trip_idx: number | null; line_id: string }>(
    `SELECT sta.station_key, t.next_trip_idx, p.line_id
     FROM trip AS t JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
     JOIN stop_time AS st ON st.trip_idx = t.trip_idx JOIN stop AS s ON s.stop_idx = st.stop_idx
     JOIN station AS sta ON sta.station_idx = s.station_idx
     WHERE t.trip_idx = :trip_idx AND s.stop_id = :stop_id`,
    { trip_idx: tripIdx, stop_id: stopId },
  );
  assert.ok(row !== null, `trip ${tripIdx} stops at stop ${stopId}`);
  assert.ok(row.station_key.length > 0);
  return { stationKey: row.station_key, nextTripIdx: row.next_trip_idx, lineId: row.line_id };
}

describe('ScheduleRepo rides on the real schedule DB (M3.4)', () => {
  test('Knight Center -> College North (Metromover), Wed 08:00: rides through the Inner Loop block link (next_trip_idx hop)', () => {
    const from = stationKeyNamed(db, 'Knight Center', MOVER);
    const to = stationKeyNamed(db, 'College North', MOVER);
    const hops = ridesBetween(from, to, WED_0800).filter((r) => r.viaBlockLink);
    assert.ok(hops.some((r) => r.lineId === 'MM_INNER' && r.alightLineId === 'MM_INNER'), 'an Inner Loop ride crosses its half-trip seam');
    for (const ride of hops) {
      const board = stopOf(ride.boardTripIdx, ride.boardStopId);
      const alight = stopOf(ride.alightTripIdx, ride.alightStopId);
      assert.notEqual(ride.alightTripIdx, ride.boardTripIdx, 'a hop changes trips, not vehicles');
      assert.equal(board.nextTripIdx, ride.alightTripIdx, 'the second trip IS the boarding trip.next_trip_idx in the DB');
      assert.equal(board.stationKey, from);
      assert.equal(alight.stationKey, to);
    }
  });

  test('Brickell -> Government Center (Metrorail), Wed 08:00 -> direct northbound rides, no block hop', () => {
    const from = stationKeyNamed(db, 'Brickell', RAIL);
    const to = stationKeyNamed(db, 'Government Center', RAIL);
    const rides = ridesBetween(from, to, WED_0800);
    assert.ok(rides.length >= 4, `a weekday morning has >= 4 rides in 30 min, got ${rides.length}`);
    assert.ok(rides.every((r) => !r.viaBlockLink && r.alightTripIdx === r.boardTripIdx), 'rail termini never link: rides are direct');
    assert.ok(rides.every((r) => stopOf(r.boardTripIdx, r.boardStopId).stationKey === from && stopOf(r.alightTripIdx, r.alightStopId).stationKey === to));
    assert.ok(rides.every((r) => r.arrEpoch - r.depEpoch > 0 && r.arrEpoch - r.depEpoch <= 5 * MINUTES), 'one stop takes a few minutes');
  });

  test('Brickell -> Government Center (Metromover), Wed 08:00 -> rides, direct on the Brickell loop', () => {
    const from = stationKeyNamed(db, 'Brickell', MOVER);
    const to = stationKeyNamed(db, 'Government Center', MOVER);
    const rides = ridesBetween(from, to, WED_0800);
    assert.ok(rides.some((r) => !r.viaBlockLink && r.lineId === 'MM_BRICKELL'), 'the Brickell loop runs straight to Government Center');
    assert.ok(rides.every((r) => stopOf(r.alightTripIdx, r.alightStopId).stationKey === to));
  });

  test('MIA -> Brickell (Metrorail), Sat 21:00 -> needs-transfer: only the airport shuttle leaves MIA', () => {
    const mia = stationKeyNamed(db, 'Miami International Airport', RAIL);
    const brickell = stationKeyNamed(db, 'Brickell', RAIL);
    const window = windowFrom(nyEpoch('2026-10-03T21:00-04:00'), 60 * MINUTES);
    assert.deepEqual(expectOk(repo.rides(mia, brickell, window)), { kind: 'needs-transfer' });
    // Not an empty schedule: trains DO leave MIA in that hour — the shuttle to Earlington Heights.
    const departures = expectOk(repo.departures(mia, window));
    assert.ok(departures.kind === 'departures' && departures.departures.length > 0, 'trains leave MIA on Saturday night');
    assert.ok(departures.kind === 'departures' && departures.departures.every((d) => d.destName === 'Earlington Heights'));
  });

  test('MIA -> Brickell (Metrorail), Wed 08:00 -> direct Orange Line rides (the weekday line runs through)', () => {
    const rides = ridesBetween(stationKeyNamed(db, 'Miami International Airport', RAIL), stationKeyNamed(db, 'Brickell', RAIL), WED_0800);
    assert.ok(rides.length > 0, 'the weekday Orange Line rides MIA -> Brickell without a change');
    assert.ok(rides.every((r) => r.lineId === 'ORANGE' && !r.viaBlockLink));
  });
});
