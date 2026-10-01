import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { readRuntimeNetwork } from '../../../src/data/live-network';
import { linesNear } from '../../../src/domain/live/line-from-position';
import { openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M4.9: the live runtime's network (trip → line, stop → station, station → stops, line tracks) read
 * from the REAL committed schedule.db, checked against plain SQL written here — never through the
 * readers under test — and fed to the live domain's own position test (linesNear).
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const network = repo.liveNetwork();

type Count = { readonly n: number };

function sqlCount(sql: string): number {
  const row = db.get<Count>(sql);
  assert.ok(row !== null, `${sql} returns a row`);
  assert.ok(Number.isSafeInteger(row.n), 'a count is a whole number');
  return row.n;
}

function station(key: string): { readonly latitude: number; readonly longitude: number } {
  const row = db.get<{ lat: number; lon: number }>('SELECT lat, lon FROM station WHERE station_key = ?', [key]);
  assert.ok(row !== null, `${key} is a station`);
  assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon), `${key} has a coordinate`);
  return { latitude: row.lat, longitude: row.lon };
}

describe('live network from the real schedule.db (M4.9)', () => {
  test('the repo reads the network once and keeps it', () => {
    assert.equal(repo.liveNetwork(), network);
    assert.notEqual(readRuntimeNetwork(db), network, 'a fresh read is a new object over the same rows');
  });

  test('lineOfTrip: every trip has its pattern\'s line — per-line counts equal plain SQL', () => {
    const trips = db.all<{ trip_id: string; line_id: string }>('SELECT t.trip_id, p.line_id FROM trip t JOIN pattern p USING (pattern_idx)');
    assert.equal(trips.length, sqlCount('SELECT count(*) AS n FROM trip'));
    assert.ok(trips.length > 5_000, 'the real schedule has thousands of trips');
    const mismatched = trips.filter((trip) => network.lineOfTrip(trip.trip_id) !== trip.line_id);
    assert.deepEqual(mismatched, []);
    assert.equal(network.lineOfTrip('not-a-trip-in-this-feed'), null);
  });

  test('stationOfStop and stopsOfStation: Government Center rail is stops 9512 + 9513; the Mover stop 813 is its own station', () => {
    assert.equal(network.stationOfStop('9512'), 'rail:government-ctr');
    assert.equal(network.stationOfStop('9513'), 'rail:government-ctr');
    assert.equal(network.stationOfStop('813'), 'mover:government-center');
    assert.deepEqual(network.stopsOfStation('rail:government-ctr'), ['9512', '9513']);
    assert.deepEqual(network.stopsOfStation('mover:government-center'), ['813']);
    assert.equal(network.stationOfStop('not-a-stop'), null);
    assert.deepEqual(network.stopsOfStation('rail:not-a-station'), []);
  });

  test('stopsOfStation covers every stop exactly once across every station', () => {
    const keys = db.all<{ station_key: string }>('SELECT station_key FROM station').map((row) => row.station_key);
    const stops = keys.flatMap((key) => network.stopsOfStation(key));
    assert.equal(stops.length, sqlCount('SELECT count(*) AS n FROM stop'));
    assert.equal(new Set(stops).size, stops.length);
    assert.ok(stops.every((stopId) => keys.includes(network.stationOfStop(stopId) ?? '')));
  });

  test('tracks: one per line_shape row, each with its shape\'s points — rail 1 per line, Mover 2 per line', () => {
    const expected = db.all<{ line_id: string; points: number }>(
      'SELECT ls.line_id, count(*) AS points FROM line_shape ls JOIN shape_point sp USING (shape_idx) GROUP BY ls.line_id, ls.shape_idx ORDER BY 1, 2',
    ).map((row) => ({ line_id: row.line_id, points: row.points })); // node:sqlite rows have a null prototype
    const actual = network.tracks.map((track) => ({ line_id: track.lineId, points: track.points.length }));
    actual.sort((a, b) => (a.line_id < b.line_id ? -1 : a.line_id > b.line_id ? 1 : a.points - b.points));
    assert.deepEqual(actual, expected);
    assert.equal(network.tracks.length, sqlCount('SELECT count(*) AS n FROM line_shape'));
  });

  test('the tracks drive the live domain\'s position rule: Okeechobee is Green-only track, the Airport is Orange-only, Brickell is shared trunk', () => {
    assert.deepEqual(linesNear('31009', station('rail:okeechobee'), network.tracks), ['GREEN']);
    assert.deepEqual(linesNear('31009', station('rail:miami-international-airport'), network.tracks), ['ORANGE']);
    assert.deepEqual(linesNear('31009', station('rail:brickell'), network.tracks), ['GREEN', 'ORANGE']);
  });
});
