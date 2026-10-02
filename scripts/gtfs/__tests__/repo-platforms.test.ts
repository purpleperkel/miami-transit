import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { nearestPlatform } from '../../../src/domain/hurry/platform';
import { openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M7c.3: the platforms hurry-or-chill walks the rider to, read through ScheduleRepo.platforms() from the
 * REAL committed schedule DB, in place. Every stop a train stops at is a platform with the directions
 * stopping there: a rail platform serves one direction, Mover stop 813 (Government Center) serves both.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

describe('ScheduleRepo.platforms on the real schedule DB (M7c.3)', () => {
  test('every stop of the feed is a platform of a listed station, on a Miami coordinate', () => {
    const platforms = repo.platforms();
    assert.equal(platforms.length, db.value('SELECT count(*) FROM stop'), 'every stop is visited by some pattern');
    const stations = new Set(repo.stations().map((station) => station.stationKey));
    assert.ok(platforms.every((p) => stations.has(p.stationKey)), 'each platform belongs to a listed station');
    assert.ok(platforms.every((p) => p.latitude > 25.6 && p.latitude < 25.9 && p.longitude > -80.4 && p.longitude < -80.1));
    assert.equal(new Set(platforms.map((p) => p.stopId)).size, platforms.length, 'each stop is one platform');
  });

  test('a rail platform serves one direction; Mover stop 813 serves both', () => {
    const byStop = new Map(repo.platforms().map((p) => [p.stopId, p] as const));
    assert.deepEqual(byStop.get('9512')?.directionIds, [0], 'Government Center southbound');
    assert.deepEqual(byStop.get('9513')?.directionIds, [1], 'Government Center northbound');
    assert.deepEqual(byStop.get('813')?.directionIds, [0, 1], 'the Mover at Government Center');
    assert.equal(byStop.get('813')?.stationKey, 'mover:government-center');
  });

  test('from the northbound platform, the northbound nearest platform is that one, 0 m away', () => {
    const at9513 = repo.platforms().find((p) => p.stopId === '9513');
    assert.ok(at9513 !== undefined);
    const hit = nearestPlatform(at9513, repo.platforms(), 1);
    assert.equal(hit?.platform.stopId, '9513');
    assert.equal(hit?.walkMeters, 0);
  });

  test('is read once, then kept', () => {
    assert.equal(repo.platforms(), repo.platforms());
    assert.ok(Object.isFrozen(repo.platforms()));
  });
});
