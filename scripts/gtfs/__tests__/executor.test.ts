import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { SqlExecutor } from '../../../src/data/sql-executor';
import { openRealScheduleDb, readRealManifest, REAL_PATHS } from './real-schedule';

/**
 * M3.1: the platform-neutral SqlExecutor contract, served by the Mac's node:sqlite executor over
 * the REAL committed assets/db/schedule.db (in place, read-only). The schedule engine sees only
 * `db: SqlExecutor`; assigning the node executor to it is the compile-time proof that the M2.15
 * executor satisfies the same interface as the on-device expo-sqlite one.
 */

const node = openRealScheduleDb();
after(() => node.close());
const db: SqlExecutor = node;

describe('SqlExecutor contract over node:sqlite, on the real schedule DB (M3.1)', () => {
  test('meta.feed_sha256 read through the SqlExecutor equals feedSha256 in assets/db/manifest.json', () => {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key: 'feed_sha256' });
    const manifest = readRealManifest();
    assert.ok(row !== null, 'the DB records its feed hash in meta');
    assert.match(row.value, /^[0-9a-f]{64}$/);
    assert.equal(row.value, manifest.feedSha256);
  });

  test('named (:name) and positional (?) parameters bind the same row', () => {
    const sql = 'SELECT station_idx, station_key, name, mode FROM station WHERE station_key = ';
    const named = db.get(`${sql}:station_key`, { station_key: 'rail:government-ctr' });
    const positional = db.get(`${sql}?`, ['rail:government-ctr']);
    assert.ok(named !== null, 'the named lookup finds the rail station');
    assert.deepEqual(named, positional);
    assert.equal(named.name, 'Government Center');
    assert.equal(named.mode, 0);
  });

  test('all() returns every row in SQL order; get() returns null when nothing matches', () => {
    const lines = db.all<{ line_id: string }>('SELECT line_id FROM line ORDER BY sort');
    assert.deepEqual(
      lines.map((line) => line.line_id),
      ['GREEN', 'ORANGE', 'MM_INNER', 'MM_OMNI', 'MM_BRICKELL'],
    );
    assert.equal(db.get('SELECT station_key FROM station WHERE station_key = ?', ['rail:nowhere']), null);
    assert.deepEqual(db.all('SELECT station_key FROM station WHERE station_key = ?', ['rail:nowhere']), []);
  });

  test('the executor reads the committed DB in place and cannot write to it', () => {
    assert.equal(node.path, REAL_PATHS.scheduleDb);
    assert.equal(db.all('SELECT station_idx FROM station').length, readRealManifest().counts.stations);
    assert.throws(() => node.run("UPDATE meta SET value = value WHERE key = 'feed_sha256'"), /readonly/i);
  });
});
