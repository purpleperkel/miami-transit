import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';

import { sha256Hex } from '../idempotency';
import { openRealScheduleDb, REAL_PATHS } from './real-schedule';

/**
 * M3.8: the phone keys its copy of the schedule DB on the manifest's dbSha256
 * (src/data/schedule-db-provider.tsx names it `schedule-<first 12 hex>.db`). That key only lands new
 * data on the phone if it is the hash of the bytes actually bundled — so the committed pair must
 * agree: the manifest describes assets/db/schedule.db exactly, byte for byte and feed for feed.
 */

const db = openRealScheduleDb();
after(() => db.close());

type BundledManifest = { readonly dbSha256: string; readonly dbBytes: number; readonly feedSha256: string };

function readBundledManifest(): BundledManifest {
  const manifest = JSON.parse(readFileSync(REAL_PATHS.manifest, 'utf8')) as BundledManifest;
  assert.match(manifest.dbSha256, /^[0-9a-f]{64}$/, 'the manifest records the DB hash');
  assert.ok(Number.isSafeInteger(manifest.dbBytes) && manifest.dbBytes > 0, 'the manifest records the DB size');
  return manifest;
}

describe('the bundled schedule DB and its manifest (M3.8 provider key)', () => {
  test('dbSha256 and dbBytes are the hash and size of the committed assets/db/schedule.db', () => {
    const manifest = readBundledManifest();
    const bytes = readFileSync(REAL_PATHS.scheduleDb);
    assert.equal(bytes.length, manifest.dbBytes);
    assert.equal(sha256Hex(bytes), manifest.dbSha256, 'the provider’s copy name tracks the bundled bytes');
  });

  test('the committed DB’s meta.feed_sha256 is the manifest’s feedSha256 (the provider refuses any other copy)', () => {
    const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'feed_sha256'");
    assert.ok(row !== null, 'meta records the feed hash');
    assert.equal(row.value, readBundledManifest().feedSha256);
  });
});
