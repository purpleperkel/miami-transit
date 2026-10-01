import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { miniFeedZip } from '../__fixtures__/mini-feed';
import { runBuild } from '../build';
import { runCheckFeed } from '../check-feed';
import { sha256Hex } from '../idempotency';
import { REPO_PATHS } from '../paths';
import { expectOk } from './expect-result';
import { MINI_SHA, MINI_ZIP, removeDir, scratchDir } from './mini-db';

/**
 * check-feed (M9.1) against a REAL loopback node:http server, never the county host. Each test builds
 * a fresh repo root with the real runBuild on the mini feed, so the manifest it checks is exactly the
 * one the build writes; then it changes what the server serves and asserts runCheckFeed's process
 * exit code: 0 unchanged, 10 changed, and anything but 0 or 10 when the check could not look.
 */

const ETAG = '"mini-feed-v1"';
const LAST_MODIFIED = 'Fri, 31 Jul 2026 20:10:53 GMT';
/** A republished zip (the agency renamed): different bytes, so a different SHA-256. */
const REPUBLISHED_ZIP = miniFeedZip({ 'agency.txt': 'agency_id,agency_name,agency_timezone\r\nDTPW305,Miami-Dade DTPW,America/New_York\r\n' });

type Mode = 'feed' | 'http-500' | 'html';
type SeenRequest = { readonly path: string; readonly ifNoneMatch: string | null; readonly ifModifiedSince: string | null };
const served = { mode: 'feed' as Mode, zip: MINI_ZIP, etag: ETAG, requests: [] as SeenRequest[], statuses: [] as number[] };

/** One header as the server received it (null when absent). */
function header(req: IncomingMessage, name: 'if-none-match' | 'if-modified-since'): string | null {
  const value = req.headers[name];
  assert.ok(value === undefined || typeof value === 'string', `${name} arrives as one header`);
  assert.notEqual(value, '', `${name} is never sent empty`);
  return value ?? null;
}

/** The feed endpoint: honours If-None-Match like the county's IIS, or fails the way `served.mode` says. */
function serve(req: IncomingMessage, res: ServerResponse): void {
  assert.equal(req.method, 'GET');
  assert.ok(req.url !== undefined, 'node:http always sets the request URL');
  served.requests.push({ path: req.url, ifNoneMatch: header(req, 'if-none-match'), ifModifiedSince: header(req, 'if-modified-since') });
  const status = served.mode === 'http-500' ? 500 : served.mode === 'feed' && req.headers['if-none-match'] === served.etag ? 304 : 200;
  served.statuses.push(status);
  if (status === 500) {
    res.writeHead(500, 'Internal Server Error').end('boom');
  } else if (served.mode === 'html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Service unavailable</body></html>');
  } else {
    res.writeHead(status, { ETag: served.etag, 'Last-Modified': LAST_MODIFIED }).end(status === 200 ? served.zip : undefined);
  }
}

let server: Server;
let base = '';

before(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const roots: string[] = [];
after(() => roots.forEach(removeDir));

/** A fresh repo root holding a DB + manifest built by runBuild from the mini feed at `<base>/feed.zip`. */
async function builtRoot(): Promise<string> {
  const root = scratchDir('check-feed');
  roots.push(root);
  Object.assign(served, { mode: 'feed', zip: MINI_ZIP, etag: ETAG, requests: [], statuses: [] });
  const report = expectOk(await runBuild({ root, feedUrl: `${base}/feed.zip`, force: false, log: () => undefined }));
  assert.equal(report.status, 'BUILT');
  assert.deepEqual([report.manifest.feedSha256, report.manifest.feedEtag], [MINI_SHA, ETAG]);
  [served.requests, served.statuses] = [[], []];
  return root;
}

type CheckRunResult = { readonly code: number; readonly out: string[]; readonly errors: string[] };

/** runCheckFeed on `root`'s manifest against `feedUrl`: its exit code and what it printed where. */
async function check(root: string, feedUrl = `${base}/feed.zip`): Promise<CheckRunResult> {
  const out: string[] = [];
  const errors: string[] = [];
  const manifestPath = join(root, REPO_PATHS.manifest);
  const code = await runCheckFeed({ manifestPath, feedUrl, log: (line) => out.push(line), warn: (line) => errors.push(line) });
  assert.equal(out.length + errors.length, 1, 'exactly one line: a verdict on stdout or a failure on stderr');
  assert.equal(errors.length === 1, code !== 0 && code !== 10, 'failures (any exit but 0 or 10), and only failures, go to stderr');
  return { code, out, errors };
}

/** A loopback port nothing listens on (bound, then closed): connecting to it is refused. */
async function closedPort(): Promise<number> {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => closed.close((error) => (error ? reject(error) : resolve())));
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(closed.listening, false);
  return port;
}

/** sha256 + mtime of every file under `root` (the DB, the manifest and the .cache zip). */
function snapshot(root: string): string[] {
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((path) => statSync(join(root, path)).isFile());
  const lines = files.sort().map((path) => `${path} ${sha256Hex(readFileSync(join(root, path)))} ${statSync(join(root, path)).mtimeMs}`);
  assert.ok(lines.some((line) => line.startsWith(REPO_PATHS.scheduleDb)) && lines.some((line) => line.startsWith(REPO_PATHS.manifest)));
  assert.ok(lines.some((line) => line.startsWith(REPO_PATHS.feedZip)), 'the build cached its zip');
  return lines;
}

describe('check-feed verdicts from a local feed server', () => {
  test('unchanged feed exits 0: a 304 to the ETag and Last-Modified the build stored', async () => {
    const root = await builtRoot();
    const before = snapshot(root);
    const { code, out } = await check(root);
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /^UNCHANGED: 304 Not Modified .*ETag "mini-feed-v1"/);
    assert.deepEqual(served.requests, [{ path: '/feed.zip', ifNoneMatch: ETAG, ifModifiedSince: LAST_MODIFIED }]);
    assert.deepEqual(served.statuses, [304]);
    assert.deepEqual(snapshot(root), before, 'the check wrote nothing');
  });

  test('unchanged feed exits 0 when a new ETag arrives on the same zip bytes: the SHA-256 decides, not the ETag', async () => {
    const root = await builtRoot();
    served.etag = '"mini-feed-flapped"';
    const { code, out } = await check(root);
    assert.equal(code, 0);
    assert.deepEqual(served.statuses, [200], 'the stale ETag earned a full download');
    assert.match(out[0] ?? '', new RegExp(`^UNCHANGED: 200, ${MINI_ZIP.length} bytes, sha256 ${MINI_SHA.slice(0, 12)}… equals`));
  });

  test('changed feed exits 10 when the downloaded zip hashes differently from the manifest, and writes nothing', async () => {
    const root = await builtRoot();
    const before = snapshot(root);
    [served.zip, served.etag] = [REPUBLISHED_ZIP, '"mini-feed-v2"'];
    const { code, out } = await check(root);
    assert.equal(code, 10);
    assert.match(out[0] ?? '', new RegExp(`^CHANGED: 200, ${REPUBLISHED_ZIP.length} bytes, sha256 ${sha256Hex(REPUBLISHED_ZIP).slice(0, 12)}…`));
    assert.match(out[0] ?? '', new RegExp(`built from sha256 ${MINI_SHA.slice(0, 12)}…\\. Run npm run gtfs:refresh`));
    assert.deepEqual(snapshot(root), before, 'neither assets/db nor the .cache zip moved: the change is left for the rebuild');
    assert.equal((await check(root)).code, 10, 'so asking again still answers changed');
  });

  test('another feed URL gets an unconditional GET: the manifest validators belong to the URL it was built from', async () => {
    const root = await builtRoot();
    const { code } = await check(root, `${base}/mirror/feed.zip`);
    assert.equal(code, 0);
    assert.deepEqual(served.requests, [{ path: '/mirror/feed.zip', ifNoneMatch: null, ifModifiedSince: null }]);
  });
});

describe('check-feed when it cannot answer: neither 0 nor 10, reported on stderr', () => {
  test('server error exits neither 0 nor 10 (HTTP 500)', async () => {
    const root = await builtRoot();
    served.mode = 'http-500';
    const { code, errors } = await check(root);
    assert.equal(code, 1, 'exit 1: neither 0 (unchanged) nor 10 (changed)');
    assert.match(errors[0] ?? '', /^check-feed: FAILED at fetch: .*HTTP 500 Internal Server Error/);
  });

  test('network error exits neither 0 nor 10 (connection refused)', async () => {
    const root = await builtRoot();
    const { code, errors } = await check(root, `http://127.0.0.1:${await closedPort()}/feed.zip`);
    assert.equal(code, 1, 'exit 1: neither 0 (unchanged) nor 10 (changed)');
    assert.match(errors[0] ?? '', /FAILED at fetch: GTFS fetch network .*ECONNREFUSED/);
  });

  test('a 200 that is not a zip is an error exit, never a verdict', async () => {
    const root = await builtRoot();
    served.mode = 'html';
    const { code, errors } = await check(root);
    assert.equal(code, 1, 'exit 1: neither 0 (unchanged) nor 10 (changed)');
    assert.match(errors[0] ?? '', /FAILED at fetch: .*is not a zip/);
  });

  test('a missing manifest is an error exit: there is no committed DB to compare the feed with', async () => {
    const root = scratchDir('check-feed');
    roots.push(root);
    [served.requests, served.statuses] = [[], []];
    const { code, errors } = await check(root);
    assert.equal(code, 1, 'exit 1: neither 0 (unchanged) nor 10 (changed)');
    assert.match(errors[0] ?? '', /FAILED at manifest: no manifest at /);
    assert.deepEqual(served.requests, [], 'nothing is fetched without a manifest to compare with');
  });

  test('the CLI rejects arguments with the usage exit (2), which is neither 0 nor 10', () => {
    const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const run = spawnSync(tsx, ['scripts/gtfs/check-feed.ts', '--force'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(run.error, undefined, 'the CLI runs');
    assert.equal(run.status, 2, 'exit 2: neither 0 (unchanged) nor 10 (changed)');
    assert.match(run.stderr, /^usage: npx tsx scripts\/gtfs\/check-feed\.ts/);
    assert.equal(run.stdout, '');
  });
});
