import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { invariant } from '../../src/lib/invariant';

/**
 * The M1.14 probe database: a small SQLite file written by `node:sqlite` on the Mac, bundled as an
 * asset, and opened by expo-sqlite on the phone (risk R4: "a node:sqlite DB opens in expo-sqlite").
 *
 * It mirrors how the real schedule DB will ship (plan §4 pipeline steps 13–14): an ordinary rowid
 * table (no WITHOUT ROWID — R4's named suspect), journal_mode DELETE, written in one transaction,
 * VACUUMed, integrity-checked, renamed into place atomically, and followed by a manifest written
 * last. Deterministic: fixed rows, no clock — a rerun reproduces the DB and manifest byte for byte.
 */

export const PROBE_DB_FILE = 'probe.db';
export const PROBE_MANIFEST_FILE = 'probe-manifest.json';
export const PROBE_TABLE = 'probe_row';
/** The plan's acceptance count (M1.14 / M1.16): the phone must read exactly this many rows. */
export const PROBE_ROWS = 1000;
/** baseEpoch(20260930), 2026-09-30 00:00 America/New_York — a realistic schedule epoch. */
const BASE_EPOCH = 1_790_740_800;
/** Every 7th label carries a curly apostrophe and a middle dot, so multi-byte UTF-8 is exercised. */
const UNICODE_EVERY = 7;

/** What the phone checks the imported DB against; written next to the DB, after it. */
export type ProbeManifest = {
  readonly table: string;
  readonly rows: number;
  readonly epochSum: number;
  readonly unicodeLabel: { readonly id: number; readonly label: string };
  readonly dbBytes: number;
  readonly dbSha256: string;
};

export function probeLabel(id: number): string {
  invariant(Number.isInteger(id) && id >= 1 && id <= PROBE_ROWS, 'probe row ids run 1..PROBE_ROWS');
  const label = id % UNICODE_EVERY === 0 ? `Gov’t Center · ${id}` : `Probe row ${id}`;
  invariant(label.endsWith(String(id)), 'every label ends with its row id');
  return label;
}

function probeEpoch(id: number): number {
  invariant(Number.isInteger(id) && id >= 1 && id <= PROBE_ROWS, 'probe row ids run 1..PROBE_ROWS');
  const epoch = BASE_EPOCH + id * 60;
  invariant(Number.isSafeInteger(epoch), 'probe epochs are exact integers');
  return epoch;
}

/** Creates the table and inserts every row in one transaction, then compacts and checks the file. */
function fillProbeDb(db: DatabaseSync): void {
  invariant(db.isOpen, 'the probe DB is open for writing');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(`CREATE TABLE ${PROBE_TABLE} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, epoch INTEGER NOT NULL)`);
  const insert = db.prepare(`INSERT INTO ${PROBE_TABLE} (id, label, epoch) VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  for (let id = 1; id <= PROBE_ROWS; id += 1) {
    const { changes } = insert.run(id, probeLabel(id), probeEpoch(id));
    invariant(changes === 1, `row ${id} was inserted`);
  }
  db.exec('COMMIT');
  db.exec('VACUUM');
  const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
  invariant(check?.integrity_check === 'ok', `the probe DB passes integrity_check: ${String(check?.integrity_check)}`);
}

/** The manifest's facts, read back from the finished file with SQL (not from the generator's memory). */
function readManifestFacts(dbPath: string): Pick<ProbeManifest, 'rows' | 'epochSum' | 'unicodeLabel'> {
  invariant(existsSync(dbPath), 'the probe DB exists before it is read back');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const totals = db.prepare(`SELECT COUNT(*) AS rows, SUM(epoch) AS epochSum FROM ${PROBE_TABLE}`).get() as
    | { rows: number; epochSum: number }
    | undefined;
  const sample = db.prepare(`SELECT id, label FROM ${PROBE_TABLE} WHERE id = ?`).get(UNICODE_EVERY) as
    | { id: number; label: string }
    | undefined;
  db.close();
  invariant(totals !== undefined && totals.rows === PROBE_ROWS, `the probe table holds exactly ${PROBE_ROWS} rows`);
  invariant(sample !== undefined && sample.label === probeLabel(UNICODE_EVERY), 'the unicode label round-trips');
  return { rows: totals.rows, epochSum: totals.epochSum, unicodeLabel: { id: sample.id, label: sample.label } };
}

/** Writes `data` beside `path` and renames it into place, so a reader never sees a half-written file. */
function writeAtomically(path: string, data: string | Uint8Array): void {
  invariant(path.length > 0, 'an atomic write needs a destination');
  const temp = `${path}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
  invariant(!existsSync(temp), 'the temp file was renamed into place');
}

/**
 * Builds `<dir>/probe.db` then `<dir>/probe-manifest.json`, overwriting both cleanly: the DB is
 * written to a fresh temp file (any leftover from a crashed run is removed first) and renamed.
 */
export function buildProbeDb(dir: string): ProbeManifest {
  invariant(existsSync(dir), `the output directory ${dir} exists`);
  const dbPath = join(dir, PROBE_DB_FILE);
  const tempPath = `${dbPath}.tmp`;
  rmSync(tempPath, { force: true });
  rmSync(`${tempPath}-journal`, { force: true });
  const db = new DatabaseSync(tempPath);
  fillProbeDb(db);
  db.close();
  renameSync(tempPath, dbPath);
  const bytes = readFileSync(dbPath);
  const manifest: ProbeManifest = {
    table: PROBE_TABLE,
    ...readManifestFacts(dbPath),
    dbBytes: bytes.length,
    dbSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeAtomically(join(dir, PROBE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  invariant(!existsSync(tempPath) && existsSync(dbPath), 'the DB was renamed into place');
  return manifest;
}
