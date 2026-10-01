import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { baseEpoch } from '../calendar';
import { BUILDER_VERSION, sha256Hex } from '../idempotency';
import { buildManifest, MANIFEST_FIELDS, manifestText, readManifest, serviceEndEpoch, writeManifest, type FeedSource, type Manifest } from '../manifest';
import { expectErr, expectOk } from './expect-result';
import { MINI_SHA, queryValue, removeDir, scratchDir, writeMiniDb } from './mini-db';

const DIR = scratchDir('manifest');
after(() => removeDir(DIR));
const DB = writeMiniDb(DIR);
const FEED: FeedSource = {
  url: 'https://example.invalid/google_transit.zip',
  sha256: MINI_SHA,
  validators: { etag: '"80443ab02821dd1:0"', lastModified: 'Fri, 31 Jul 2026 20:10:53 GMT' },
};

function manifest(): Manifest {
  const built = expectOk(buildManifest(DB, FEED));
  assert.equal(built.feedSha256, MINI_SHA);
  assert.equal(built.dbBytes, statSync(DB).size);
  return built;
}

/** The wall clock in New York at an epoch second, "YYYY-MM-DD HH:MM". */
function newYorkTime(epochSeconds: number): string {
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }).format(epochSeconds * 1000);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(Number.isInteger(epochSeconds));
  return text;
}

describe('buildManifest', () => {
  test('has every field, in order, each describing the DB on disk', () => {
    const m = manifest();
    assert.deepEqual(Object.keys(JSON.parse(manifestText(m)) as object), [...MANIFEST_FIELDS]);
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.builderVersion, BUILDER_VERSION);
    assert.deepEqual([m.feedUrl, m.feedEtag, m.feedLastModified], [FEED.url, FEED.validators.etag, FEED.validators.lastModified]);
    assert.equal(m.dbSha256, sha256Hex(readFileSync(DB)));
    assert.equal(m.sqliteVersion, queryValue(DB, 'SELECT sqlite_version()'));
    assert.deepEqual(m.counts, {
      stations: queryValue(DB, 'SELECT count(*) FROM station'),
      patterns: queryValue(DB, 'SELECT count(*) FROM pattern'),
      trips: queryValue(DB, 'SELECT count(*) FROM trip'),
      stopTimes: queryValue(DB, 'SELECT count(*) FROM stop_time'),
    });
    assert.equal(m.counts.trips, 12);
    assert.equal(m.serviceStartDate, 20231113, 'the Mover weekday calendar starts 2023-11-13');
  });

  test('rail service-end epoch = start(end date) + 86400 (and the Mover’s too)', () => {
    const { rail, mover } = manifest().serviceEnd;
    assert.deepEqual(rail, { date: 20261122, epoch: baseEpoch(20261122) + 86400 });
    assert.deepEqual(mover, { date: 20261231, epoch: baseEpoch(20261231) + 86400 });
    assert.deepEqual([rail.epoch, mover.epoch], [1795410000, 1798779600]);
    assert.equal(serviceEndEpoch(rail.date), rail.epoch);
    assert.equal(newYorkTime(rail.epoch), '2026-11-23 00:00', 'the schedule runs out at the end of the last service day');
  });

  test('no build timestamp: the same DB and feed give the same manifest text', () => {
    assert.equal(manifestText(manifest()), manifestText(manifest()));
    assert.doesNotMatch(manifestText(manifest()), /"(builtAt|generatedAt|timestamp)"/);
  });

  test('a DB built from a different zip -> Err (the manifest never vouches for the wrong source)', () => {
    const error = expectErr(buildManifest(DB, { ...FEED, sha256: sha256Hex(new Uint8Array([1, 2, 3])) }));
    assert.match(error.message, new RegExp(`was built from zip ${MINI_SHA}`));
    assert.equal(error.kind, 'manifest');
  });
});

describe('readManifest', () => {
  test('a written manifest reads back equal; no file reads as null', () => {
    const path = join(DIR, 'manifest.json');
    writeManifest(path, manifest());
    assert.deepEqual(expectOk(readManifest(path)), manifest());
    assert.equal(expectOk(readManifest(join(DIR, 'absent.json'))), null);
  });

  test('a manifest missing a field, or with a malformed one -> Err naming it', () => {
    const path = join(DIR, 'broken.json');
    const withoutCounts: Record<string, unknown> = { ...manifest() };
    delete withoutCounts.counts;
    writeFileSync(path, JSON.stringify(withoutCounts));
    assert.match(expectErr(readManifest(path)).message, /field counts is missing/);
    writeFileSync(path, JSON.stringify({ ...manifest(), dbSha256: 'not-a-sha' }));
    assert.match(expectErr(readManifest(path)).message, /field dbSha256 is malformed/);
    writeFileSync(path, '{ not json');
    assert.match(expectErr(readManifest(path)).message, /is not JSON/);
  });
});
