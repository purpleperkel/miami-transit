import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MONDAY_TO_FRIDAY, type SavedTrip, SavedTripsRepo } from '../../../src/data/saved-trips-repo';
import { SettingsRepo, TRIP_SETTINGS } from '../../../src/data/settings-repo';
import { migrateUserDb, USER_DB_MIGRATIONS, USER_DB_VERSION, userDbVersion } from '../../../src/data/user-db';
import { NodeSqlExecutor } from '../../lib/node-sql-executor';
import { expectErr, expectOk } from './expect-result';

/**
 * M7.3: the user DB's migrations and its two repos, driven through the Mac's executor on fresh
 * IN-MEMORY databases only — the exact modules the phone runs over expo-sqlite, no file touched.
 */

/** A fresh in-memory user DB, migrated to this app's version. */
function freshUserDb(): NodeSqlExecutor {
  const db = NodeSqlExecutor.inMemory();
  assert.equal(db.path, ':memory:', 'the suite never touches a file');
  const report = expectOk(migrateUserDb(db));
  assert.deepEqual(report, { from: 0, to: USER_DB_VERSION, applied: USER_DB_MIGRATIONS.map((m) => m.version) });
  return db;
}

const WORK: SavedTrip = {
  id: 'work',
  name: 'Work',
  fromStationKey: 'rail:brickell',
  toStationKey: 'rail:government-ctr',
  start: { latitude: 25.7617, longitude: -80.1918 },
  walkOverrideMin: null,
  reminder: { days: MONDAY_TO_FRIDAY, atMin: 8 * 60 },
  createdEpoch: 1_790_740_800,
};

describe('user DB migrations (M7.3)', () => {
  test('migrations applied twice -> same user_version, and the second pass applies nothing', () => {
    const db = freshUserDb();
    const first = userDbVersion(db);
    const again = expectOk(migrateUserDb(db));
    assert.equal(first, USER_DB_VERSION);
    assert.deepEqual(again, { from: USER_DB_VERSION, to: USER_DB_VERSION, applied: [] });
    assert.equal(userDbVersion(db), first);
    db.close();
  });

  test('a DB from a newer app is refused and left untouched', () => {
    const db = NodeSqlExecutor.inMemory();
    db.exec(`PRAGMA user_version = ${USER_DB_VERSION + 1}`);
    const refused = expectErr(migrateUserDb(db));
    assert.equal(refused.kind, 'user-db');
    assert.equal(userDbVersion(db), USER_DB_VERSION + 1);
    assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").length, 0);
    db.close();
  });

  test('a failing migration rolls back whole: no half-made table, the version unchanged', () => {
    const db = NodeSqlExecutor.inMemory();
    const broken = [...USER_DB_MIGRATIONS, { version: USER_DB_VERSION + 1, sql: 'CREATE TABLE extra(x INTEGER); SELECT nope FROM nowhere;' }];
    assert.throws(() => migrateUserDb(db, broken), /no such table: nowhere/);
    assert.equal(userDbVersion(db), USER_DB_VERSION);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'extra'"), null);
    db.close();
  });

  test('the repos refuse a DB that was never migrated', () => {
    const db = NodeSqlExecutor.inMemory();
    assert.throws(() => new SavedTripsRepo(db), /migrated/);
    assert.throws(() => new SettingsRepo(db), /migrated/);
    db.close();
  });
});

describe('saved trips repo (M7.3)', () => {
  test('saved trip CRUD round-trips: create, read, list, update, delete', () => {
    const db = freshUserDb();
    const trips = new SavedTripsRepo(db);
    assert.deepEqual(expectOk(trips.create(WORK)), WORK);
    assert.deepEqual(trips.get('work'), WORK);
    const gym: SavedTrip = { ...WORK, id: 'gym', name: 'Gym', start: null, walkOverrideMin: 7, reminder: null, createdEpoch: WORK.createdEpoch + 60 };
    expectOk(trips.create(gym));
    assert.deepEqual(trips.list(), [WORK, gym]);
    const moved: SavedTrip = { ...WORK, name: 'Office', toStationKey: 'mover:college-north', walkOverrideMin: 12, reminder: null };
    assert.deepEqual(expectOk(trips.update(moved)), moved);
    assert.deepEqual(trips.get('work'), moved);
    assert.equal(trips.remove('work'), true);
    assert.equal(trips.get('work'), null);
    assert.equal(trips.remove('work'), false);
    assert.deepEqual(trips.list(), [gym]);
    db.close();
  });

  test('bad trips are refused with a reason and nothing is written', () => {
    const db = freshUserDb();
    const trips = new SavedTripsRepo(db);
    assert.equal(expectErr(trips.create({ ...WORK, toStationKey: WORK.fromStationKey })).kind, 'invalid-trip');
    assert.equal(expectErr(trips.create({ ...WORK, id: 'has:colon' })).kind, 'invalid-trip');
    assert.equal(expectErr(trips.create({ ...WORK, reminder: { days: 0, atMin: 480 } })).kind, 'invalid-trip');
    assert.equal(expectErr(trips.create({ ...WORK, name: '   ' })).kind, 'invalid-trip');
    assert.equal(expectErr(trips.update(WORK)).kind, 'unknown-trip');
    expectOk(trips.create(WORK));
    assert.equal(expectErr(trips.create({ ...WORK, name: 'Again' })).kind, 'duplicate-trip');
    assert.deepEqual(trips.list(), [WORK]);
    db.close();
  });
});

describe('settings repo (M7.3)', () => {
  test('settings round-trip: defaults, a stored value, then reset to the default', () => {
    const db = freshUserDb();
    const settings = new SettingsRepo(db);
    assert.deepEqual(settings.all(), { boardBufferS: 120, reminderLeadS: 0 });
    assert.equal(expectOk(settings.set('boardBufferS', 90)), 90);
    assert.equal(expectOk(settings.set('boardBufferS', 60)), 60);
    assert.equal(new SettingsRepo(db).get('boardBufferS'), 60);
    assert.deepEqual(settings.all(), { boardBufferS: 60, reminderLeadS: 0 });
    assert.equal(settings.reset('boardBufferS'), TRIP_SETTINGS.boardBufferS.defaultValue);
    assert.equal(settings.get('boardBufferS'), 120);
    db.close();
  });

  test('an out-of-range or fractional setting is refused and the old value kept', () => {
    const db = freshUserDb();
    const settings = new SettingsRepo(db);
    expectOk(settings.set('reminderLeadS', 300));
    assert.equal(expectErr(settings.set('reminderLeadS', 1801)).kind, 'invalid-setting');
    assert.equal(expectErr(settings.set('boardBufferS', 12.5)).kind, 'invalid-setting');
    assert.equal(settings.get('reminderLeadS'), 300);
    assert.equal(settings.get('boardBufferS'), 120);
    db.close();
  });
});
