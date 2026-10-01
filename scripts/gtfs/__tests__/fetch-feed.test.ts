import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { miniFeedZip } from '../__fixtures__/mini-feed';
import { conditionalHeaders, fetchFeed, NO_VALIDATORS } from '../fetch-feed';
import { expectErr, expectOk } from './expect-result';

/**
 * fetchFeed against a REAL loopback node:http server (never the county host). The server reads the
 * conditional request headers itself and answers 304 only when they match what it is serving.
 */

const ZIP = miniFeedZip();
const ETAG = '"80443ab02821dd1:0"';
const LAST_MODIFIED = 'Fri, 31 Jul 2026 20:10:53 GMT';

type SeenRequest = { readonly path: string; readonly ifNoneMatch?: string; readonly ifModifiedSince?: string };
const seen: SeenRequest[] = [];

function header(req: IncomingMessage, name: 'if-none-match' | 'if-modified-since'): string | undefined {
  const value = req.headers[name];
  assert.ok(value === undefined || typeof value === 'string', `${name} arrives as one header`);
  assert.notEqual(value, '', `${name} is never sent empty`);
  return value;
}

/** RFC 9110 §13.2.2: If-None-Match decides when present; otherwise If-Modified-Since does. */
function isNotModified(request: SeenRequest): boolean {
  assert.ok(request.path.length > 0);
  assert.ok(!Number.isNaN(Date.parse(LAST_MODIFIED)));
  if (request.ifNoneMatch !== undefined) {
    return request.ifNoneMatch.split(',').some((tag) => tag.trim() === ETAG);
  }
  return request.ifModifiedSince !== undefined && Date.parse(LAST_MODIFIED) <= Date.parse(request.ifModifiedSince);
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  assert.ok(req.url !== undefined, 'node:http always sets the request URL');
  const request: SeenRequest = {
    path: req.url,
    ifNoneMatch: header(req, 'if-none-match'),
    ifModifiedSince: header(req, 'if-modified-since'),
  };
  seen.push(request);
  if (request.path === '/feed.zip' && isNotModified(request)) {
    res.writeHead(304, { ETag: ETAG, 'Last-Modified': LAST_MODIFIED }).end();
  } else if (request.path === '/feed.zip') {
    res.writeHead(200, { 'Content-Type': 'application/x-zip-compressed', ETag: ETAG, 'Last-Modified': LAST_MODIFIED });
    res.end(ZIP);
  } else if (request.path === '/broken') {
    res.writeHead(500, 'Internal Server Error').end('boom');
  } else if (request.path === '/html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body>Service unavailable</body></html>');
  } else if (request.path === '/always-304') {
    res.writeHead(304).end();
  } else if (request.path !== '/hang') {
    res.writeHead(404).end();
  }
  assert.equal(seen.at(-1), request, 'every request is recorded; /hang is left unanswered on purpose');
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

describe('fetchFeed: conditional GET', () => {
  test('fresh → zip bytes, plus the ETag and Last-Modified to store', async () => {
    const outcome = expectOk(await fetchFeed(`${base}/feed.zip`, NO_VALIDATORS));
    assert.equal(outcome.kind, 'fresh');
    assert.ok(outcome.kind === 'fresh' && Buffer.from(outcome.bytes).equals(Buffer.from(ZIP)));
    assert.deepEqual(outcome.kind === 'fresh' && outcome.validators, { etag: ETAG, lastModified: LAST_MODIFIED });
    assert.deepEqual(seen.at(-1), { path: '/feed.zip', ifNoneMatch: undefined, ifModifiedSince: undefined });
  });

  test('ETag → not-modified (If-None-Match sent, the server answers 304)', async () => {
    const outcome = expectOk(await fetchFeed(`${base}/feed.zip`, { etag: ETAG, lastModified: null }));
    assert.deepEqual(outcome, { kind: 'not-modified' });
    assert.equal(seen.at(-1)?.ifNoneMatch, ETAG);
  });

  test('Last-Modified → not-modified (If-Modified-Since sent, the server answers 304)', async () => {
    const outcome = expectOk(await fetchFeed(`${base}/feed.zip`, { etag: null, lastModified: LAST_MODIFIED }));
    assert.deepEqual(outcome, { kind: 'not-modified' });
    assert.equal(seen.at(-1)?.ifModifiedSince, LAST_MODIFIED);
  });

  test('a stale ETag gets the fresh zip again (the 304 is earned, not hardwired)', async () => {
    const outcome = expectOk(await fetchFeed(`${base}/feed.zip`, { etag: '"older"', lastModified: LAST_MODIFIED }));
    assert.equal(outcome.kind, 'fresh');
    assert.equal(seen.at(-1)?.ifNoneMatch, '"older"', 'If-None-Match outranks If-Modified-Since');
  });

  test('sends exactly the stored validators as If-None-Match and If-Modified-Since', () => {
    assert.deepEqual(conditionalHeaders(NO_VALIDATORS), {});
    assert.deepEqual(conditionalHeaders({ etag: ETAG, lastModified: LAST_MODIFIED }), {
      'If-None-Match': ETAG,
      'If-Modified-Since': LAST_MODIFIED,
    });
  });
});

describe('fetchFeed: failures are Errs', () => {
  test('HTTP 500 → Err', async () => {
    const error = expectErr(await fetchFeed(`${base}/broken`, NO_VALIDATORS));
    assert.deepEqual([error.kind, error.status], ['http', 500]);
    assert.match(error.message, /HTTP 500 Internal Server Error/);
  });

  test('non-zip body → Err (an HTML page served with 200)', async () => {
    const error = expectErr(await fetchFeed(`${base}/html`, NO_VALIDATORS));
    assert.equal(error.kind, 'not-zip');
    assert.match(error.message, /is not a zip/);
  });

  test('a 304 to a request that sent no validators → Err', async () => {
    const error = expectErr(await fetchFeed(`${base}/always-304`, NO_VALIDATORS));
    assert.deepEqual([error.kind, error.status], ['http', 304]);
    assert.match(error.message, /sent no validators/);
  });

  test('connection refused → network Err', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = expectErr(await fetchFeed(`http://127.0.0.1:${port}/feed.zip`, NO_VALIDATORS));
    assert.equal(error.kind, 'network');
    assert.match(error.message, /ECONNREFUSED/);
  });

  test('no response within the timeout → timeout Err', async () => {
    const error = expectErr(await fetchFeed(`${base}/hang`, NO_VALIDATORS, 200));
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /within 200 ms/);
  });
});
