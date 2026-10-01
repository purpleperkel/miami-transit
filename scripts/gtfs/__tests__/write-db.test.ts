import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { err, ok } from '../../../src/lib/result';
import { BUILDER_VERSION } from '../idempotency';
import { columnsOf, declaredType, SCHEMA_VERSION, TABLE_NAMES, TABLES, type ColumnKind } from '../schema';
import { writeScheduleDb } from '../write-db';
import { expectErr, expectOk } from './expect-result';
import { miniFeedZip } from '../__fixtures__/mini-feed';
import { MINI_SHA, miniRows, queryValue, removeDir, rowsOf, scratchDir, shortShapeFeed, writeMiniDb } from './mini-db';

const DIR = scratchDir('write-db');
after(() => removeDir(DIR));

/** A fresh, empty subdirectory of DIR, so each test owns its files. */
function testDir(name: string): string {
  const dir = join(DIR, name);
  assert.ok(/^[a-z-]+$/.test(name), 'test directories have plain names');
  mkdirSync(dir);
  assert.deepEqual(readdirSync(dir), []);
  return dir;
}

describe('writeScheduleDb: the written file', () => {
  test('row counts match after reopen: every table holds exactly its rows once the file is closed and reopened', () => {
    const path = writeMiniDb(testDir('counts'));
    const db = new DatabaseSync(path, { readOnly: true });
    const counts = Object.fromEntries(TABLE_NAMES.map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() ?? {}).n]));
    db.close();
    assert.deepEqual(counts, Object.fromEntries(TABLE_NAMES.map((table) => [table, miniRows()[table].length])));
    assert.equal(counts.trip, 12);
  });

  test('integrity_check = ok on the written DB', () => {
    const path = writeMiniDb(testDir('integrity'));
    assert.equal(queryValue(path, 'PRAGMA integrity_check'), 'ok');
    assert.equal(queryValue(path, 'PRAGMA freelist_count'), 0, 'VACUUM left no free pages');
  });

  test('user_version = 1 on the written DB', () => {
    const path = writeMiniDb(testDir('user-version'));
    assert.equal(queryValue(path, 'PRAGMA user_version'), 1);
    assert.equal(SCHEMA_VERSION, 1);
  });

  test('journal_mode is delete: one self-contained file, no WAL and no sidecar files', () => {
    const dir = testDir('journal');
    const path = writeMiniDb(dir);
    assert.equal(queryValue(path, 'PRAGMA journal_mode'), 'delete');
    // Header bytes 18/19 are the read/write format versions: 1 = legacy (rollback journal), 2 = WAL.
    const header = readFileSync(path).subarray(0, 20);
    assert.deepEqual([header[18], header[19]], [1, 1]);
    assert.deepEqual(readdirSync(dir), ['schedule.db']);
  });
});

describe('writeScheduleDb: installing it', () => {
  test('the write is an atomic rename: the old DB stays whole until the finished, checked file replaces it', () => {
    const dir = testDir('atomic');
    const path = join(dir, 'schedule.db');
    writeFileSync(path, 'the previous DB');
    let seenDuringCheck = '';
    const checked = writeScheduleDb(miniRows(), path, (temp) => {
      seenDuringCheck = readFileSync(path, 'utf8');
      assert.equal(temp, `${path}.tmp`);
      return queryValue(temp, 'PRAGMA integrity_check') === 'ok' ? ok(null) : err({ message: 'temp not ok' });
    });
    expectOk(checked);
    assert.equal(seenDuringCheck, 'the previous DB', 'while the new DB was checked, the destination still held the old file');
    assert.equal(queryValue(path, 'SELECT count(*) FROM trip'), 12);
    assert.deepEqual(readdirSync(dir), ['schedule.db'], 'the temp file was renamed away, not copied');
  });

  test('the write is an atomic rename: a failed check leaves the old DB untouched and no temp file behind', () => {
    const dir = testDir('atomic-fail');
    const path = join(dir, 'schedule.db');
    writeFileSync(path, 'the previous DB');
    const error = expectErr(writeScheduleDb(miniRows(), path, () => err({ message: 'verify-db said no' })));
    assert.equal(error.step, 'check');
    assert.match(error.message, /failed its check and was not installed: verify-db said no/);
    assert.equal(readFileSync(path, 'utf8'), 'the previous DB');
    assert.deepEqual(readdirSync(dir), ['schedule.db']);
  });

  test('a leftover temp file from a crashed run is replaced, not appended to', () => {
    const dir = testDir('leftover');
    writeFileSync(join(dir, 'schedule.db.tmp'), 'half a DB from a crash');
    writeFileSync(join(dir, 'schedule.db.tmp-journal'), 'its journal');
    const path = writeMiniDb(dir);
    assert.equal(queryValue(path, 'PRAGMA integrity_check'), 'ok');
    assert.deepEqual(readdirSync(dir), ['schedule.db']);
  });
});

describe('writeScheduleDb: what it holds', () => {
  test('the same rows write a byte-identical file (no clock, no hash order)', () => {
    const [first, second] = [writeMiniDb(testDir('same-a')), writeMiniDb(testDir('same-b'))];
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.equal(statSync(first).size % 4096, 0, 'whole pages');
  });

  test('the declared columns match the DDL, table by table: all 15 tables, trip.next_trip_idx, shape.extended_start_m/extended_end_m', () => {
    const path = writeMiniDb(testDir('columns'));
    const db = new DatabaseSync(path, { readOnly: true });
    for (const table of TABLE_NAMES) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[];
      const kinds: Readonly<Record<string, ColumnKind>> = TABLES[table];
      assert.deepEqual(info.map((c) => `${c.name} ${c.type}`), columnsOf(table).map((c) => `${c} ${declaredType(kinds[c] ?? 'text')}`), table);
      const nullable = info.filter((c) => c.notnull === 0 && c.pk === 0).map((c) => c.name);
      assert.deepEqual(nullable, columnsOf(table).filter((c) => (kinds[c] ?? '').endsWith('?')), `${table}: exactly the '?' columns may be NULL`);
    }
    db.close();
    assert.equal(TABLE_NAMES.length, 15);
    assert.ok(columnsOf('trip').includes('next_trip_idx'));
    assert.deepEqual(columnsOf('shape').slice(-2), ['extended_start_m', 'extended_end_m']);
  });

  test('meta records the source zip, the schema and the builder', () => {
    const path = writeMiniDb(testDir('meta'));
    const db = new DatabaseSync(path, { readOnly: true });
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value]));
    db.close();
    assert.deepEqual(meta, { builder_version: String(BUILDER_VERSION), feed_sha256: MINI_SHA, schema_version: '1', time_zone: 'America/New_York' });
    assert.equal(Object.keys(meta).length, 4);
  });

  test('a shape overhanging at both ends stores each end in its own column (extended_start_m 103, extended_end_m 50)', () => {
    const path = join(testDir('both-ends'), 'schedule.db');
    expectOk(writeScheduleDb(rowsOf(miniFeedZip(shortShapeFeed(103, 50))), path));
    const [start, end] = [
      queryValue(path, "SELECT extended_start_m FROM shape WHERE shape_id = '211239'"),
      queryValue(path, "SELECT extended_end_m FROM shape WHERE shape_id = '211239'"),
    ];
    assert.ok(typeof start === 'number' && Math.abs(start - 103) < 0.5, `extended_start_m ${String(start)}`);
    assert.ok(typeof end === 'number' && Math.abs(end - 50) < 0.5, `extended_end_m ${String(end)}`);
    assert.equal(queryValue(path, "SELECT count(*) FROM shape WHERE shape_id != '211239' AND (extended_start_m != 0 OR extended_end_m != 0)"), 0);
  });

  test("stop_time.seq is the pattern's stop position: every trip's stop i is its pattern's stop i", () => {
    const path = writeMiniDb(testDir('seq'));
    const mismatched = queryValue(
      path,
      `SELECT count(*) FROM stop_time s JOIN trip t ON t.trip_idx = s.trip_idx
        LEFT JOIN pattern_stop ps ON ps.pattern_idx = t.pattern_idx AND ps.seq = s.seq WHERE ps.stop_idx IS NOT s.stop_idx`,
    );
    assert.equal(mismatched, 0);
    assert.equal(queryValue(path, 'SELECT min(seq) FROM stop_time'), 0);
  });
});
