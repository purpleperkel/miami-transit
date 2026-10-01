import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { miniFeedZip } from '../__fixtures__/mini-feed';
import { parseArgs, runBuild, type BuildReport } from '../build';
import { sha256Hex } from '../idempotency';
import { REPO_PATHS } from '../paths';
import { verifyScheduleDb } from '../verify-db';
import { expectOk } from './expect-result';
import { MINI_SHA, MINI_ZIP, removeDir, scratchDir } from './mini-db';

/**
 * runBuild end to end on the mini feed, served by a REAL loopback node:http server that honours
 * If-None-Match (so reruns exercise the 304 path and the zip cache). Each test builds into its own
 * fresh "repo root", so any single test can run alone.
 */

const ETAG = '"mini-feed-v1"';
/** A different zip (the agency renamed) for the "feed changed" case. */
const CHANGED_ZIP = miniFeedZip({
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\r\nDTPW305,Miami-Dade DTPW,http://www.miamidade.gov/transit,America/New_York\r\n',
});
const served = { zip: MINI_ZIP, etag: ETAG, statuses: [] as number[] };

function serve(req: IncomingMessage, res: ServerResponse): void {
  assert.equal(req.url, '/google_transit.zip');
  assert.equal(req.method, 'GET');
  const status = req.headers['if-none-match'] === served.etag ? 304 : 200;
  served.statuses.push(status);
  res.writeHead(status, { ETag: served.etag, 'Last-Modified': 'Fri, 31 Jul 2026 20:10:53 GMT' });
  res.end(status === 200 ? served.zip : undefined);
}

let server: Server;
let feedUrl = '';

before(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/google_transit.zip`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const roots: string[] = [];
after(() => roots.forEach(removeDir));

/** A fresh, empty repo root for one test, served the original mini feed. */
function freshRoot(): string {
  const root = scratchDir('build');
  roots.push(root);
  [served.zip, served.etag, served.statuses] = [MINI_ZIP, ETAG, []];
  assert.equal(sha256Hex(served.zip), MINI_SHA);
  assert.deepEqual(readdirSync(root), [], 'the root starts empty');
  return root;
}

async function build(root: string, force = false): Promise<{ report: BuildReport; log: string[] }> {
  const log: string[] = [];
  const report = expectOk(await runBuild({ root, feedUrl, force, log: (line) => log.push(line) }));
  assert.equal(log.length, 2, 'one fetch line, then BUILT or UNCHANGED');
  assert.ok(log[1]?.startsWith(report.status), log.join('\n'));
  return { report, log };
}

/** sha256 + mtime of the DB and the manifest under `root`. */
function snapshot(root: string): string[] {
  const files = [REPO_PATHS.scheduleDb, REPO_PATHS.manifest].map((path) => join(root, path));
  assert.equal(files.length, 2);
  const lines = files.map((path) => `${path} ${sha256Hex(readFileSync(path))} ${statSync(path).mtimeMs}`);
  assert.ok(lines.every((line) => /\b[0-9a-f]{64}\b/.test(line)));
  return lines;
}

describe('runBuild', () => {
  test('mini feed -> BUILT: a verified DB, then its manifest, from a fresh download', async () => {
    const root = freshRoot();
    const { report, log } = await build(root);
    assert.deepEqual([report.status, report.reason], ['BUILT', 'no-manifest']);
    assert.match(log[0] ?? '', /^fetch: 200 — \d+ bytes/);
    const db = join(root, REPO_PATHS.scheduleDb);
    expectOk(verifyScheduleDb(db));
    assert.equal(report.manifest.dbSha256, sha256Hex(readFileSync(db)));
    assert.equal(sha256Hex(readFileSync(join(root, REPO_PATHS.feedZip))), MINI_SHA, 'the zip is cached for later --force runs');
    assert.deepEqual(served.statuses, [200]);
  });

  test('a rerun -> UNCHANGED, DB mtime unchanged: a 304, and nothing written', async () => {
    const root = freshRoot();
    await build(root);
    const before = snapshot(root);
    const { report, log } = await build(root);
    assert.deepEqual([report.status, report.reason], ['UNCHANGED', 'unchanged']);
    assert.match(log[0] ?? '', /^fetch: 304 Not Modified — using the cached \.cache\/gtfs\/google_transit\.zip/);
    assert.deepEqual(snapshot(root), before, 'sha256 and mtime of schedule.db and manifest.json are untouched');
    assert.deepEqual(served.statuses, [200, 304]);
  });

  test('--force gives the identical dbSha256: a real rebuild from the cached zip after a 304, byte for byte', async () => {
    const root = freshRoot();
    const first = (await build(root)).report.manifest;
    const db = join(root, REPO_PATHS.scheduleDb);
    const [bytes, mtime] = [readFileSync(db), statSync(db).mtimeMs];
    const { report } = await build(root, true);
    assert.deepEqual([report.status, report.reason], ['BUILT', 'force']);
    assert.equal(report.manifest.dbSha256, first.dbSha256);
    assert.deepEqual(readFileSync(db), bytes);
    assert.notEqual(statSync(db).mtimeMs, mtime, 'the DB really was rewritten');
    assert.deepEqual(served.statuses, [200, 304], '--force rebuilt from the cache after a 304');
  });

  test('a republished feed -> BUILT again from the new zip, with the new feed hash', async () => {
    const root = freshRoot();
    const first = (await build(root)).report.manifest;
    [served.zip, served.etag] = [CHANGED_ZIP, '"mini-feed-v2"'];
    const { report } = await build(root);
    assert.deepEqual([report.status, report.reason], ['BUILT', 'zip-changed']);
    assert.equal(report.manifest.feedSha256, sha256Hex(CHANGED_ZIP));
    assert.equal(report.manifest.feedEtag, '"mini-feed-v2"');
    assert.notEqual(report.manifest.feedSha256, first.feedSha256);
  });

  test('a DB edited by hand -> BUILT again (the manifest no longer describes it)', async () => {
    const root = freshRoot();
    const first = (await build(root)).report.manifest;
    const db = join(root, REPO_PATHS.scheduleDb);
    writeFileSync(db, 'not the DB any more');
    const { report } = await build(root);
    assert.deepEqual([report.status, report.reason], ['BUILT', 'db-changed']);
    assert.equal(report.manifest.dbSha256, first.dbSha256, 'and the rebuild restores the same bytes');
  });
});

describe('parseArgs', () => {
  test('--force is the only option', () => {
    assert.deepEqual(parseArgs([]), { force: false });
    assert.deepEqual(parseArgs(['--force']), { force: true });
    assert.equal(parseArgs(['--forse']), null);
  });
});
