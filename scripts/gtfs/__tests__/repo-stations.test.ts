import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { StationListing } from '../../../src/data/schedule-queries';
import { REAL_STOPS } from '../../../src/domain/network/__fixtures__/real-stops';
import { buildStations } from '../../../src/domain/network/stations';
import { expectOk } from './expect-result';
import { openRealRepo, openRealScheduleDb, readRealManifest } from './real-schedule';

/**
 * M5.5: the Stations tab's list, read through ScheduleRepo.stations() from the REAL committed
 * schedule DB, in place. The 2026 feed has 44 stations: 23 Metrorail (mode 0) and 21 Metromover
 * (mode 1); Government Center and Brickell are two stations each, one per mode.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

/** The listed stations with this display name. */
function stationsNamed(name: string): readonly StationListing[] {
  const named = repo.stations().filter((station) => station.name === name);
  assert.ok(named.length > 0, `some station is named ${name}`);
  assert.ok(named.every((station) => station.name === name));
  return named;
}

describe('ScheduleRepo.stations on the real schedule DB (M5.5)', () => {
  test('station list on the real DB has all 44 stations: 23 rail + 21 Mover', () => {
    const stations = repo.stations();
    assert.equal(stations.length, 44);
    assert.equal(stations.filter((station) => station.mode === 'rail').length, 23);
    assert.equal(stations.filter((station) => station.mode === 'mover').length, 21);
    assert.equal(db.value('SELECT count(*) FROM station'), 44, 'the list is every row of the station table');
    assert.equal(stations.length, readRealManifest().counts.stations, 'the manifest counts the same stations');
  });

  test('rail comes before the Mover, each mode in name order, every key once', () => {
    const stations = repo.stations();
    const firstMover = stations.findIndex((station) => station.mode === 'mover');
    assert.ok(firstMover > 0 && stations.slice(firstMover).every((station) => station.mode === 'mover'));
    for (const mode of ['rail', 'mover'] as const) {
      const names = stations.filter((station) => station.mode === mode).map((station) => station.name);
      assert.deepEqual(names, [...names].sort(), `${mode} stations are in name order`);
    }
    assert.equal(new Set(stations.map((station) => station.stationKey)).size, stations.length);
  });

  test('both Government Centers and both Brickells are listed, one per mode, with real coordinates', () => {
    for (const name of ['Government Center', 'Brickell']) {
      assert.deepEqual(stationsNamed(name).map((station) => station.mode).sort(), ['mover', 'rail']);
    }
    const government = stationsNamed('Government Center');
    assert.ok(government.every((s) => Math.abs(s.coordinate.latitude - 25.7745) < 0.003 && Math.abs(s.coordinate.longitude + 80.1957) < 0.003));
  });
});

describe('the station list against the feed (M5.5)', () => {
  test('lists exactly the stations M2.9 clusters from the feed stops — the set the Stations tab test renders', () => {
    const clustered = expectOk(buildStations(REAL_STOPS)).stations;
    const fromDb = repo.stations();
    assert.deepEqual(fromDb.map((s) => s.stationKey).sort(), clustered.map((s) => s.key).sort());
    assert.deepEqual(
      fromDb.map((s) => `${s.stationKey} ${s.name} ${s.mode}`).sort(),
      clustered.map((s) => `${s.key} ${s.name} ${s.mode}`).sort(),
    );
  });

  test('is read once, then kept', () => {
    const first = repo.stations();
    assert.equal(repo.stations(), first);
    assert.ok(Object.isFrozen(first), 'callers cannot reorder the shared list');
  });
});
