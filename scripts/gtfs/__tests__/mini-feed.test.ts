import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { strFromU8, unzipSync } from 'fflate';

import { parseGtfsTime } from '../../../src/domain/gtfs/time';
import { MINI_FEED, MINI_FEED_FACTS as F, MINI_FEED_STOPS as S, miniFeedZip, type MiniFeedFile } from '../__fixtures__/mini-feed';
import { parseCsv, type CsvFields } from '../parse-csv';
import { expectOk } from './expect-result';

/** Every row of a fixture file, read with the pipeline's own tolerant parser. */
function rowsOf<C extends string>(file: MiniFeedFile, columns: readonly C[]): CsvFields<C>[] {
  assert.ok(columns.length > 0, 'rowsOf reads at least one column');
  const records = expectOk(parseCsv(file, MINI_FEED[file], { required: columns }));
  assert.ok(records.length > 0, `${file} has rows`);
  return records.map((record) => record.fields);
}

const TRIP_COLUMNS = ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'block_id', 'shape_id'] as const;
const STOP_TIME_COLUMNS = ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'] as const;

function tripRow(tripId: string): CsvFields<(typeof TRIP_COLUMNS)[number]> {
  const trip = rowsOf('trips.txt', TRIP_COLUMNS).find((row) => row.trip_id === tripId);
  assert.ok(trip !== undefined, `trip ${tripId} is in the fixture`);
  assert.equal(trip.trip_id, tripId);
  return trip;
}

/** A trip's stop_times in stop_sequence order. */
function stopTimesOf(tripId: string): CsvFields<(typeof STOP_TIME_COLUMNS)[number]>[] {
  const rows = rowsOf('stop_times.txt', STOP_TIME_COLUMNS).filter((row) => row.trip_id === tripId);
  rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  assert.ok(rows.length >= 2, `trip ${tripId} has at least two stop_times`);
  assert.ok(rows.every((row) => row.trip_id === tripId));
  return rows;
}

function stopsOf(tripId: string): string[] {
  const stops = stopTimesOf(tripId).map((row) => row.stop_id);
  assert.ok(stops.length >= 2);
  assert.ok(stops.every((stop) => stop.length > 0), 'every stop_time names a stop');
  return stops;
}

/** "lat,lon" of a stop, for comparing places across platforms. */
function placeOf(stopId: string): string {
  const stop = rowsOf('stops.txt', ['stop_id', 'stop_lat', 'stop_lon']).find((row) => row.stop_id === stopId);
  assert.ok(stop !== undefined, `stop ${stopId} is in the fixture`);
  assert.ok(stop.stop_lat.length > 0 && stop.stop_lon.length > 0);
  return `${stop.stop_lat},${stop.stop_lon}`;
}

const MIA = new Set<string>([S.miaS, S.miaN]);

describe('mini feed: Metrorail patterns', () => {
  test('has a Green-line stop pattern: Palmetto ↔ Dadeland South, never MIA', () => {
    const southbound = stopsOf(F.greenTrip);
    const northbound = stopsOf(F.singleTrackTrips['AFTER 8 PM']);
    assert.equal(southbound.length, 22);
    assert.deepEqual([southbound[0], southbound.at(-1)], [S.palmettoS, S.dadelandSouthS]);
    assert.deepEqual([northbound[0], northbound.at(-1)], [S.dadelandSouthN, S.palmettoN]);
    assert.ok([...southbound, ...northbound].every((stop) => !MIA.has(stop)), 'a Green pattern never touches MIA');
  });

  test('has an Orange-line stop pattern: MIA → Dadeland South through Earlington Heights', () => {
    const stops = stopsOf(F.orangeTrip);
    assert.equal(stops.length, 16);
    assert.deepEqual([stops[0], stops[1], stops.at(-1)], [S.miaS, S.earlingtonHeightsS, S.dadelandSouthS]);
    assert.ok(!stops.includes(S.palmettoS), 'an Orange pattern never touches the Green-only north branch');
  });

  test('has 2-stop MIA ↔ Earlington Heights shuttle patterns in both directions', () => {
    const patterns = F.shuttleTrips.map((tripId) => stopsOf(tripId).join('→'));
    assert.deepEqual(patterns, [
      `${S.miaS}→${S.earlingtonHeightsS}`,
      `${S.earlingtonHeightsN}→${S.miaN}`,
      `${S.miaS}→${S.earlingtonHeightsS}`,
    ]);
    assert.ok(F.shuttleTrips.every((tripId) => tripRow(tripId).route_id === F.railRoute));
  });

  test('carries the Green pattern under both single-track headsign spellings (8PM and 8 PM)', () => {
    for (const [spelling, tripId] of Object.entries(F.singleTrackTrips)) {
      assert.equal(tripRow(tripId).trip_headsign, `EHT - CUL SINGLE TRACK ${spelling}`);
      assert.equal(stopsOf(tripId).length, 22, 'the headsign says EHT - CUL, the stop pattern is full Green');
    }
  });
});

describe('mini feed: Metromover and out-of-scope routes', () => {
  test('has Inner Loop half-trips chained by block_id', () => {
    const halves = F.innerLoopHalfTrips.map((tripId) => ({ trip: tripRow(tripId), times: stopTimesOf(tripId) }));
    assert.ok(halves.every(({ trip }) => trip.route_id === F.innerLoopRoute && trip.block_id === F.innerLoopBlock));
    for (let i = 1; i < halves.length; i += 1) {
      const previous = halves[i - 1]?.times.at(-1);
      const next = halves[i]?.times[0];
      assert.ok(previous !== undefined && next !== undefined);
      assert.equal(placeOf(next.stop_id), placeOf(previous.stop_id), 'each half starts where the last one ended');
      const [arrived, leaves] = [previous.arrival_time, next.departure_time].map((t) => expectOk(parseGtfsTime(t)));
      assert.ok(leaves !== undefined && arrived !== undefined && leaves >= arrived, 'and leaves no earlier than it arrived');
    }
    assert.deepEqual([stopsOf(F.innerLoopHalfTrips[0]).at(-1), stopsOf(F.innerLoopHalfTrips[1])[0]], ['813', '813']);
  });

  test('has both MMO legs (Omni and Brickell) on one route_id, told apart by shape', () => {
    const omni = tripRow(F.omniTrip);
    const brickell = tripRow(F.brickellTrip);
    assert.deepEqual([omni.route_id, brickell.route_id], [F.omniBrickellRoute, F.omniBrickellRoute]);
    assert.deepEqual([omni.shape_id, brickell.shape_id], ['123745', '123746']);
    assert.equal(stopsOf(F.omniTrip).at(-1), S.moverGovernmentCenter);
  });

  test('has a bus route (31161, route_type 3) with the real pickup_type=1 row, for load-feed to drop', () => {
    const route = rowsOf('routes.txt', ['route_id', 'route_type']).find((row) => row.route_id === F.busRoute);
    assert.equal(route?.route_type, '3');
    assert.equal(tripRow(F.busTrip).route_id, F.busRoute);
    const last = stopTimesOf(F.busTrip).at(-1);
    assert.deepEqual([last?.pickup_type, last?.drop_off_type], ['1', '1']);
  });

  test('has the MIA airport mover (14458), which is out of scope', () => {
    const route = rowsOf('routes.txt', ['route_id', 'route_long_name']).find((row) => row.route_id === F.airportMoverRoute);
    assert.equal(route?.route_long_name, 'AIRPORT PEOPLE MOVER');
    assert.equal(tripRow(F.airportMoverTrip).route_id, F.airportMoverRoute);
  });
});

const CALENDAR_COLUMNS = ['service_id', 'saturday', 'sunday', 'monday', 'start_date', 'end_date'] as const;

/** Service ids running on `date` (a `weekday`), from calendar.txt plus calendar_dates.txt exceptions. */
function servicesOn(date: number, weekday: 'monday' | 'saturday' | 'sunday'): Set<string> {
  const active = new Set<string>();
  for (const row of rowsOf('calendar.txt', CALENDAR_COLUMNS)) {
    if (row[weekday] === '1' && Number(row.start_date) <= date && date <= Number(row.end_date)) {
      active.add(row.service_id);
    }
  }
  for (const row of rowsOf('calendar_dates.txt', ['service_id', 'date', 'exception_type'])) {
    if (Number(row.date) === date) {
      assert.ok(row.exception_type === '1' || row.exception_type === '2', 'exception_type is 1 (add) or 2 (remove)');
      if (row.exception_type === '1') {
        active.add(row.service_id);
      } else {
        active.delete(row.service_id);
      }
    }
  }
  assert.ok(active.size > 0, `some service runs on ${date}`);
  return active;
}

describe('mini feed: calendar', () => {
  test('has calendar_dates exceptions: Labor Day 20260907 swaps weekday rail service 6 for Sunday service 8', () => {
    assert.equal(new Date(Date.UTC(2026, 8, 7)).getUTCDay(), 1, '20260907 is a Monday');
    const laborDay = servicesOn(F.laborDay, 'monday');
    const ordinaryMonday = servicesOn(20260914, 'monday');
    assert.ok(ordinaryMonday.has(F.weekdayRailService) && !ordinaryMonday.has(F.sundayRailService));
    assert.ok(!laborDay.has(F.weekdayRailService), 'Labor Day removes weekday rail service');
    assert.ok(laborDay.has(F.sundayRailService), 'Labor Day adds Sunday rail service');
  });

  test('runs rail service on the DST date 20261101 (Sunday), including the night before past 24:00', () => {
    assert.equal(F.dstEndDate, 20261101);
    assert.equal(new Date(Date.UTC(2026, 10, 1)).getUTCDay(), 0, '20261101 is a Sunday');
    const sunday = servicesOn(F.dstEndDate, 'sunday');
    const sundayRail = rowsOf('trips.txt', TRIP_COLUMNS).filter((t) => t.route_id === F.railRoute && sunday.has(t.service_id));
    assert.deepEqual(
      sundayRail.map((t) => t.trip_id),
      [F.shuttleTrips[2]],
    );
    assert.ok(servicesOn(20261031, 'saturday').has(F.saturdayRailService), 'Saturday 20261031 runs service 7');
    const saturdayNight = stopTimesOf(F.singleTrackTrips['AFTER 8 PM']);
    assert.ok(saturdayNight.every((row) => row.departure_time.startsWith('24:')), 'its trip runs into Sunday 20261101');
  });
});

describe('mini feed: bytes', () => {
  test('carries the real feed quirks: CRLF, leading spaces, unpadded times, times past 24:00', () => {
    const stopTimes = MINI_FEED['stop_times.txt'];
    assert.ok(Object.values(MINI_FEED).every((text) => text.includes('\r\n') && !/[^\r]\n/.test(text)), 'CRLF only');
    assert.match(stopTimes, /^4828771, 5:32:00, 5:32:00,795,1,/m, 'a leading space before an unpadded hour');
    assert.match(stopTimes, /^6283569,25:04:00,25:04:00,9528,22,/m, 'a time past 24:00');
    assert.ok(MINI_FEED['stops.txt'].startsWith('\uFEFFstop_id,'), 'and the one synthetic quirk: a BOM on stops.txt');
  });

  test('is internally consistent: every stop_time names a known trip and stop, every shape has points', () => {
    const trips = new Set(rowsOf('trips.txt', TRIP_COLUMNS).map((t) => t.trip_id));
    const stops = new Set(rowsOf('stops.txt', ['stop_id']).map((s) => s.stop_id));
    const shapes = new Set(rowsOf('shapes.txt', ['shape_id']).map((s) => s.shape_id));
    const stopTimes = rowsOf('stop_times.txt', STOP_TIME_COLUMNS);
    assert.ok(stopTimes.every((row) => trips.has(row.trip_id) && stops.has(row.stop_id)));
    assert.ok(rowsOf('trips.txt', TRIP_COLUMNS).every((t) => shapes.has(t.shape_id)));
    assert.equal(trips.size, 14);
  });

  test('zips all 8 files deterministically, and an override replaces or omits a file', () => {
    assert.deepEqual(miniFeedZip(), miniFeedZip(), 'the same overrides give the same bytes');
    const entries = unzipSync(miniFeedZip());
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(MINI_FEED).sort());
    assert.equal(strFromU8(entries['trips.txt'] ?? new Uint8Array()), MINI_FEED['trips.txt']);
    const changed = unzipSync(miniFeedZip({ 'agency.txt': 'x', 'calendar_dates.txt': null }));
    assert.equal(strFromU8(changed['agency.txt'] ?? new Uint8Array()), 'x');
    assert.ok(!('calendar_dates.txt' in changed));
  });
});
