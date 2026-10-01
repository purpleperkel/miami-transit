import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ScheduleRepo } from '../../../src/data/schedule-repo';
import type { SqlExecutor } from '../../../src/data/sql-executor';
import { NodeSqlExecutor } from '../../lib/node-sql-executor';
import { pipelinePaths } from '../paths';
import { expectOk } from './expect-result';

/**
 * Shared by the schedule-engine suites (M3.1–M3.4): the REAL committed assets/db/schedule.db,
 * opened read-only IN PLACE (no fixture DB, no temp copy), and absolute New York instants.
 *
 * Instants are written as ISO-8601 with an explicit UTC offset and checked against the
 * America/New_York offset at that instant (Intl) — never built with a local-time Date constructor,
 * so the suites mean the same thing on any machine's clock and zone.
 */

export const REAL_PATHS = pipelinePaths(process.cwd());

/** The committed schedule DB, read-only, through the Mac's executor. */
export function openRealScheduleDb(): NodeSqlExecutor {
  const db = expectOk(NodeSqlExecutor.open(REAL_PATHS.scheduleDb, 'read-only'));
  assert.equal(db.path, REAL_PATHS.scheduleDb, 'the suites query the committed DB in place');
  assert.match(db.path, /\/assets\/db\/schedule\.db$/);
  return db;
}

/** The schedule engine over the real DB, through the platform-neutral contract only. */
export function openRealRepo(db: SqlExecutor): ScheduleRepo {
  const repo = expectOk(ScheduleRepo.open(db));
  assert.match(repo.meta.feedSha256, /^[0-9a-f]{64}$/);
  assert.equal(repo.meta.timeZone, 'America/New_York');
  return repo;
}

export type RealManifest = { readonly feedSha256: string; readonly counts: { readonly stations: number } };

export function readRealManifest(): RealManifest {
  const manifest = JSON.parse(readFileSync(REAL_PATHS.manifest, 'utf8')) as RealManifest;
  assert.match(manifest.feedSha256, /^[0-9a-f]{64}$/, 'the manifest records the feed hash');
  assert.ok(manifest.counts.stations > 0, 'the manifest counts stations');
  return manifest;
}

const NEW_YORK_OFFSET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

/**
 * Epoch seconds of a New York wall-clock instant written with its offset, e.g.
 * '2026-09-30T08:00-04:00' (EDT) or '2027-01-01T12:00-05:00' (EST). The stated offset must be
 * New York's actual offset at that instant, so a wrong-season offset fails loudly.
 */
export function nyEpoch(iso: string): number {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(-0[45]:00)$/.exec(iso);
  assert.ok(match !== null, `"${iso}" states a New York offset (-04:00 EDT or -05:00 EST)`);
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms) && ms % 1000 === 0, `"${iso}" is a whole-second instant`);
  const zone = NEW_YORK_OFFSET.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName');
  assert.equal(zone?.value, `GMT${match[1]}`, `New York's offset at ${iso}`);
  return ms / 1000;
}

/** The station key the DB gives a station name in one mode (0 rail, 1 mover) — looked up, never guessed. */
export function stationKeyNamed(db: SqlExecutor, name: string, mode: 0 | 1): string {
  const rows = db.all<{ station_key: string }>('SELECT station_key FROM station WHERE name = :name AND mode = :mode', { name, mode });
  assert.equal(rows.length, 1, `exactly one ${mode === 0 ? 'rail' : 'mover'} station is named ${name}`);
  assert.ok(rows[0] !== undefined && rows[0].station_key.length > 0);
  return rows[0].station_key;
}
