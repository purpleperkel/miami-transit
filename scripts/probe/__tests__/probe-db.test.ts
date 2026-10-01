import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { buildProbeDb, PROBE_DB_FILE, PROBE_MANIFEST_FILE, PROBE_ROWS, PROBE_TABLE, probeLabel } from '../probe-db';

/** A fresh scratch directory per test, so no test sees another's files (or the committed asset). */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-db-'));
  assert.ok(dir.startsWith(tmpdir()), 'scratch dirs live under the OS temp dir');
  assert.notEqual(dir, tmpdir());
  return dir;
}

function sha256Of(path: string): string {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]+$/);
  return digest;
}

test('probe DB: the probe table holds exactly 1000 rows, read back with node:sqlite', () => {
  const dir = scratchDir();
  buildProbeDb(dir);
  const db = new DatabaseSync(join(dir, PROBE_DB_FILE), { readOnly: true });
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${PROBE_TABLE}`).get() as { n: number };
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  db.close();
  rmSync(dir, { recursive: true });
  assert.equal(PROBE_ROWS, 1000);
  assert.equal(row.n, 1000);
  assert.equal(mode.journal_mode, 'delete');
});

test('probe DB: a rerun overwrites cleanly and reproduces the DB and manifest byte for byte', () => {
  const dir = scratchDir();
  const first = buildProbeDb(dir);
  const firstManifest = readFileSync(join(dir, PROBE_MANIFEST_FILE), 'utf8');
  const second = buildProbeDb(dir);
  assert.deepEqual(second, first);
  assert.equal(readFileSync(join(dir, PROBE_MANIFEST_FILE), 'utf8'), firstManifest);
  assert.equal(sha256Of(join(dir, PROBE_DB_FILE)), first.dbSha256);
  rmSync(dir, { recursive: true });
});

test('probe DB: a temp file left by a crashed run is replaced, not appended to', () => {
  const dir = scratchDir();
  writeFileSync(join(dir, `${PROBE_DB_FILE}.tmp`), 'half-written garbage from a crashed run');
  const manifest = buildProbeDb(dir);
  assert.equal(manifest.rows, PROBE_ROWS);
  assert.equal(sha256Of(join(dir, PROBE_DB_FILE)), manifest.dbSha256);
  rmSync(dir, { recursive: true });
});

test('probe DB: the manifest describes the file it sits beside', () => {
  const dir = scratchDir();
  const manifest = buildProbeDb(dir);
  const bytes = readFileSync(join(dir, PROBE_DB_FILE));
  const onDisk = JSON.parse(readFileSync(join(dir, PROBE_MANIFEST_FILE), 'utf8')) as unknown;
  rmSync(dir, { recursive: true });
  assert.deepEqual(onDisk, manifest);
  assert.equal(manifest.dbBytes, bytes.length);
  assert.equal(manifest.unicodeLabel.label, probeLabel(manifest.unicodeLabel.id));
  assert.match(manifest.unicodeLabel.label, /’/);
});
