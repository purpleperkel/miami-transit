import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { haversineMeters } from '../../../src/lib/geo';
import { MINI_FEED, miniFeedZip, type MiniFeedOverrides } from '../__fixtures__/mini-feed';
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
  rows ??= rowsOf(MINI_ZIP);
  assert.equal(rows.trip.length, 12, 'the mini feed has 12 in-scope trips');
  assert.ok(rows.stop_time.length > 0);
  return rows;
}

/** The schedule rows of any (mini-feed) zip, through the real pipeline. */
export function rowsOf(zip: Uint8Array): ScheduleRows {
  const feed = expectOk(loadFeed(expectOk(unzipFeed(zip))));
  const network = expectOk(buildNetwork(feed));
  const calendar = expectOk(expandCalendar(feed.calendar, feed.calendarDates, feed.timeZone));
  const built = expectOk(buildScheduleRows({ feed, network, calendar, feedSha256: sha256Hex(zip) }));
  assert.equal(built.trip.length, feed.trips.length);
  assert.equal(built.shape.length, network.shapes.length);
  return built;
}

type Coordinate = readonly [number, number];

/** The point `metres` from `from` toward `to` (linear in degrees: exact enough over a few hundred metres). */
export function towards(from: Coordinate, to: Coordinate, metres: number): [number, number] {
  const total = haversineMeters({ latitude: from[0], longitude: from[1] }, { latitude: to[0], longitude: to[1] });
  assert.ok(metres > 0 && metres < total, 'the point lies between the two');
  const f = metres / total;
  const point: [number, number] = [from[0] + f * (to[0] - from[0]), from[1] + f * (to[1] - from[1])];
  assert.ok(point.every(Number.isFinite));
  return point;
}

/** Platforms of the mini feed's shape 211239 (Green, Palmetto → Dadeland South) and their neighbours. */
export const GREEN_211239 = {
  palmetto: [25.843348, -80.323791],
  okeechobee: [25.839812, -80.301544],
  dadelandSouth: [25.685075, -80.31374],
  dadelandNorth: [25.691933, -80.305207],
} as const satisfies Record<string, Coordinate>;

/**
 * The mini feed with shape 211239 cut short like the county's real shapes: its first point moved
 * `startM` down the track toward Okeechobee, its last point (22) `endM` back toward Dadeland North
 * (0 leaves that end where it is, through the platform).
 */
export function shortShapeFeed(startM: number, endM: number): MiniFeedOverrides {
  assert.ok(startM >= 0 && endM >= 0 && startM + endM > 0, 'at least one end is cut short');
  const g = GREEN_211239;
  const edits: [string, string][] = [];
  if (startM > 0) {
    const [lat, lon] = towards(g.palmetto, g.okeechobee, startM);
    edits.push([`211239,${g.palmetto.join(',')},1,`, `211239,${lat.toFixed(7)},${lon.toFixed(7)},1,`]);
  }
  if (endM > 0) {
    const [lat, lon] = towards(g.dadelandSouth, g.dadelandNorth, endM);
    edits.push([`211239,${g.dadelandSouth.join(',')},22,`, `211239,${lat.toFixed(7)},${lon.toFixed(7)},22,`]);
  }
  let text = MINI_FEED['shapes.txt'];
  for (const [line, replacement] of edits) {
    assert.ok(text.includes(`${line}\r\n`), `shapes.txt has the line ${line}`);
    text = text.replace(`${line}\r\n`, `${replacement}\r\n`);
  }
  return { 'shapes.txt': text };
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
