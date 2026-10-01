import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { InvariantError } from '../../../src/lib/invariant';
import { miniFeedZip } from '../__fixtures__/mini-feed';
import { BUILDER_VERSION, decideBuild, sha256Hex, sha256OfFile, type BuildFingerprint, type BuildInputs } from '../idempotency';

const ZIP_SHA = sha256Hex(miniFeedZip());
const DB_BYTES = new TextEncoder().encode('SQLite format 3\u0000 (stand-in DB bytes)');
const DB_SHA = sha256Hex(DB_BYTES);

/** A stored manifest that matches CURRENT exactly; each test changes one thing. */
const STORED: BuildFingerprint = { feedSha256: ZIP_SHA, builderVersion: BUILDER_VERSION, dbSha256: DB_SHA };
const CURRENT: BuildInputs = { feedSha256: ZIP_SHA, builderVersion: BUILDER_VERSION, dbSha256OnDisk: DB_SHA, force: false };

describe('decideBuild', () => {
  test('all match → skip (UNCHANGED)', () => {
    assert.deepEqual(decideBuild(CURRENT, STORED), { action: 'skip', reason: 'unchanged' });
    assert.deepEqual(decideBuild({ ...CURRENT }, { ...STORED }), { action: 'skip', reason: 'unchanged' });
  });

  test('zip mismatch → build', () => {
    const otherZip = sha256Hex(miniFeedZip({ 'agency.txt': 'agency_timezone\r\nAmerica/New_York\r\n' }));
    assert.notEqual(otherZip, ZIP_SHA, 'a changed file changes the zip hash');
    assert.deepEqual(decideBuild({ ...CURRENT, feedSha256: otherZip }, STORED), { action: 'build', reason: 'zip-changed' });
  });

  test('builder version mismatch → build', () => {
    const decision = decideBuild({ ...CURRENT, builderVersion: BUILDER_VERSION + 1 }, STORED);
    assert.deepEqual(decision, { action: 'build', reason: 'builder-version-changed' });
    assert.equal(decision.action, 'build');
  });

  test('db hash mismatch → build (the DB on disk is not the one the manifest describes)', () => {
    const tampered = sha256Hex(new TextEncoder().encode('SQLite format 3\u0000 (edited by hand)'));
    assert.deepEqual(decideBuild({ ...CURRENT, dbSha256OnDisk: tampered }, STORED), { action: 'build', reason: 'db-changed' });
    assert.deepEqual(decideBuild({ ...CURRENT, dbSha256OnDisk: null }, STORED), { action: 'build', reason: 'db-missing' });
  });

  test('--force → build even when everything matches', () => {
    assert.deepEqual(decideBuild({ ...CURRENT, force: true }, STORED), { action: 'build', reason: 'force' });
    assert.deepEqual(decideBuild({ ...CURRENT, force: true }, null), { action: 'build', reason: 'force' });
  });

  test('no manifest → build (the first build)', () => {
    assert.deepEqual(decideBuild(CURRENT, null), { action: 'build', reason: 'no-manifest' });
    assert.deepEqual(decideBuild({ ...CURRENT, dbSha256OnDisk: null }, null), { action: 'build', reason: 'no-manifest' });
  });

  test('refuses a hash that is not a SHA-256 hex digest (a broken caller, not a decision)', () => {
    assert.throws(() => decideBuild({ ...CURRENT, feedSha256: 'abc' }, STORED), InvariantError);
    assert.throws(() => decideBuild({ ...CURRENT, dbSha256OnDisk: DB_SHA.toUpperCase() }, STORED), InvariantError);
  });
});

describe('hashing', () => {
  test('sha256Hex matches the FIPS 180-2 vector for "abc"', () => {
    const digest = sha256Hex(new TextEncoder().encode('abc'));
    assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256Hex(miniFeedZip()), ZIP_SHA, 'the fixture zip hashes the same every time');
  });

  test('sha256OfFile hashes a DB file on disk, and is null when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idempotency-'));
    const path = join(dir, 'schedule.db');
    assert.equal(sha256OfFile(path), null);
    writeFileSync(path, DB_BYTES);
    assert.equal(sha256OfFile(path), DB_SHA);
    assert.equal(decideBuild({ ...CURRENT, dbSha256OnDisk: sha256OfFile(path) }, STORED).action, 'skip');
    rmSync(dir, { recursive: true });
  });
});
