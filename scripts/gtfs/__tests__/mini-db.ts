import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { miniFeedZip } from '../__fixtures__/mini-feed';
import { buildNetwork } from '../build-network';
import { expandCalendar } from '../calendar';
import { sha256Hex } from '../idempotency';
import { loadFeed } from '../load-feed';
import { buildScheduleRows } from '../schedule-rows';
import type { ScheduleRows } from '../schema';
import { unzipFeed } from '../unzip-feed';
import { writeScheduleDb } from '../write-db';
import { expectOk } from './expect-result';

/**
 * Shared by the schedule-DB node:test suites (write-db, verify-db, manifest, report): the M2.4 mini
 * feed run through the real pipeline — zip → unzip → load → network → calendar → rows — and written
 * to a throwaway directory. Every suite works on its own temp files, so suites can run in parallel
 * and any single test can run alone (the ratchet gates run cases by name).
 */

export const MINI_ZIP = miniFeedZip();
export const MINI_SHA = sha256Hex(MINI_ZIP);

let rows: ScheduleRows | null = null;

/** The mini feed's schedule rows (computed once per process). */
export function miniRows(): ScheduleRows {
  if (rows === null) {
    const feed = expectOk(loadFeed(expectOk(unzipFeed(MINI_ZIP))));
    const network = expectOk(buildNetwork(feed));
    const calendar = expectOk(expandCalendar(feed.calendar, feed.calendarDates, feed.timeZone));
    rows = expectOk(buildScheduleRows({ feed, network, calendar, feedSha256: MINI_SHA }));
  }
  assert.equal(rows.trip.length, 12, 'the mini feed has 12 in-scope trips');
  assert.ok(rows.stop_time.length > 0);
  return rows;
}

/** A fresh empty directory under the OS temp dir. */
export function scratchDir(label: string): string {
  assert.match(label, /^[a-z-]+$/);
  const dir = mkdtempSync(join(tmpdir(), `miami-transit-${label}-`));
  assert.ok(statSync(dir).isDirectory());
  return dir;
}

export function removeDir(dir: string): void {
  assert.ok(dir.startsWith(tmpdir()), 'only temp directories are removed');
  rmSync(dir, { recursive: true, force: true });
  assert.throws(() => statSync(dir));
}

/** The mini-feed DB written by writeScheduleDb to `<dir>/<name>`; its path. */
export function writeMiniDb(dir: string, name = 'schedule.db'): string {
  const path = join(dir, name);
  const written = expectOk(writeScheduleDb(miniRows(), path));
  assert.equal(written.path, path);
  assert.ok(existsSync(path) && !existsSync(`${path}.tmp`));
  return path;
}

/** A copy of `source` at `<dir>/<name>`, for a test to damage. */
export function copyDb(source: string, dir: string, name: string): string {
  const path = join(dir, name);
  assert.notEqual(path, source, 'a copy never overwrites its source');
  copyFileSync(source, path);
  assert.deepEqual(readFileSync(path), readFileSync(source));
  return path;
}

/** Apply `sql` to the DB file at `path` (a test's deliberate damage). */
export function mutateDb(path: string, sql: string): void {
  assert.ok(sql.trim().length > 0, 'a mutation has SQL');
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  assert.equal(db.isOpen, false);
}

/** One value from the DB file at `path`. */
export function queryValue(path: string, sql: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare(sql).get();
  db.close();
  assert.ok(row !== undefined, `"${sql}" returned a row`);
  assert.equal(Object.keys(row).length, 1, `"${sql}" returns one column`);
  return Object.values(row)[0];
}
