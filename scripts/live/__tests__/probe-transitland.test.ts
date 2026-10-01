import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { readRuntimeNetwork } from '../../../src/data/live-network';
import { decodeFeedMessage } from '../../../src/domain/gtfsrt/decode-feed';
import { SYNTHETIC_DEPARTURES } from '../../../src/domain/live/__fixtures__/synthetic-departures';
import { SYNTHETIC_VEHICLE_POSITIONS_BYTES } from '../../../src/domain/live/__fixtures__/synthetic-vehicle-positions';
import { REPO_PATHS } from '../../gtfs/paths';
import { NodeSqlExecutor } from '../../lib/node-sql-executor';
import { NOT_CACHED_RETRIES, NOT_CACHED_RETRY_MS, type ProbeDeps, type ProbeFetch, type ProbeInit, type ProbeReport, runProbe } from '../probe-transitland';

/**
 * M8.2a: the Transitland probe's branches, forced with an injected fetch and clock — the network is
 * never touched and no test waits a real minute. Response bodies are the SYNTHETIC fixtures
 * (generated from the public GTFS); the key is a FAKE generated per run.
 */

const KEY = `testfake${randomBytes(16).toString('hex')}`;
const WORK = mkdtempSync(join(tmpdir(), 'probe-transitland-test-'));
const opened = NodeSqlExecutor.open(join(process.cwd(), REPO_PATHS.scheduleDb), 'read-only');
assert.ok(opened.ok, 'the committed schedule.db opens');
const db = opened.value;
const network = readRuntimeNetwork(db);
after(() => {
  db.close();
  rmSync(WORK, { recursive: true, force: true });
});

const decoded = decodeFeedMessage(SYNTHETIC_VEHICLE_POSITIONS_BYTES);
assert.ok(decoded.ok && decoded.value.header.timestamp !== null, 'the synthetic feed has a header timestamp');
const FEED_TIMESTAMP = decoded.value.header.timestamp;
const DEPARTURE_BODIES: Readonly<Record<string, Uint8Array>> = {
  '9512': new Uint8Array(Buffer.from(JSON.stringify(SYNTHETIC_DEPARTURES['9512']))),
  '9513': new Uint8Array(Buffer.from(JSON.stringify(SYNTHETIC_DEPARTURES['9513']))),
};

type Answer = { readonly status: number; readonly body: Uint8Array };
type Call = { readonly url: string; readonly init: ProbeInit };
type Harness = { readonly deps: ProbeDeps; readonly calls: Call[]; readonly sleeps: number[]; readonly logs: string[]; readonly dir: string };

const OK_VEHICLES: Answer = { status: 200, body: SYNTHETIC_VEHICLE_POSITIONS_BYTES };
const NOT_FOUND: Answer = { status: 404, body: new Uint8Array(Buffer.from('{"error":"not found"}')) };

/** A fake Transitland answering the n-th vehicles download with `vehicles(n)` and each stop's departures with its synthetic body. */
function harness(name: string, vehicles: (n: number) => Answer, departures: (stopId: string) => Answer = (stopId) => ({ status: 200, body: DEPARTURE_BODIES[stopId] ?? new Uint8Array() })): Harness {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const dir = join(WORK, name);
  const fetch: ProbeFetch = async (url, init) => {
    assert.ok(url.startsWith('https://transit.land/api/v2/rest/'), `a Transitland REST call: ${url}`);
    assert.equal(init.method, 'GET');
    calls.push({ url, init });
    const stop = /:(\d+)\/departures\?/.exec(url)?.[1];
    const answer = stop === undefined ? vehicles(calls.filter((c) => c.url.endsWith('/vehicle_positions.pb')).length) : departures(stop);
    return { status: answer.status, arrayBuffer: async () => new Uint8Array(answer.body).buffer };
  };
  const deps: ProbeDeps = {
    key: KEY,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nowMs: () => (FEED_TIMESTAMP + 30) * 1000,
    log: (line) => logs.push(line),
    captureDir: dir,
    network,
  };
  assert.equal(calls.length, 0);
  assert.ok(dir.startsWith(WORK), 'captures stay in the throwaway directory');
  return { deps, calls, sleeps, logs, dir };
}

function savedFiles(dir: string): string[] {
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.ok(files.every((name) => !name.endsWith('.tmp')), 'no half-written capture is left behind');
  assert.ok(Array.isArray(files));
  return files;
}

function vehicleCalls(calls: readonly Call[]): number {
  const n = calls.filter((call) => call.url.endsWith('/download_latest_rt/vehicle_positions.pb')).length;
  assert.ok(Number.isInteger(n));
  assert.ok(calls.every((call) => !call.url.includes('trip_updates')), 'the 1 MB trip-updates download is never fetched');
  return n;
}

describe('probe-transitland (M8.2a): the vehicle-positions download', () => {
  test('a 404 retries every 60 s, up to 5 times, then gives up: six calls, five 60 s waits, status 404, nothing saved', async () => {
    const h = harness('not-cached', () => NOT_FOUND);
    const report = await runProbe(h.deps);
    assert.equal(NOT_CACHED_RETRIES, 5);
    assert.equal(NOT_CACHED_RETRY_MS, 60_000);
    assert.deepEqual(h.sleeps, [60_000, 60_000, 60_000, 60_000, 60_000]);
    assert.equal(vehicleCalls(h.calls), 6);
    assert.equal(h.calls.length, 6, 'no departures call after the download failed');
    assert.equal(report.status, 404);
    assert.equal(report.attempts, 6);
    assert.equal(report.ok, false);
    assert.match(report.failures.join('; '), /404 on all 6 attempts/);
    assert.throws(() => savedFiles(h.dir), /ENOENT/, 'nothing was saved');
  });

  test('a 404 that clears is retried after 60 s and the run goes on with the cached message', async () => {
    const h = harness('clears', (n) => (n <= 2 ? NOT_FOUND : OK_VEHICLES));
    const report = await runProbe(h.deps);
    assert.deepEqual(h.sleeps, [60_000, 60_000]);
    assert.equal(vehicleCalls(h.calls), 3);
    assert.equal(report.attempts, 3);
    assert.equal(report.status, 200);
    assert.equal(report.ok, true, report.failures.join('; '));
  });

  test('a 401 stops at once: one call, no wait, no retry, no departures, nothing saved', async () => {
    const h = harness('refused', () => ({ status: 401, body: new Uint8Array(Buffer.from('{"message":"Unauthorized"}')) }));
    const report = await runProbe(h.deps);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.equal(report.status, 401);
    assert.equal(report.attempts, 1);
    assert.equal(report.ok, false);
    assert.match(report.failures.join('; '), /401.*refused the key.*no retry/);
    assert.deepEqual(report.departures, {});
    assert.throws(() => savedFiles(h.dir), /ENOENT/, 'nothing was saved');
  });
});

/** The report and captures of one full synthetic run. */
async function fullRun(name: string): Promise<{ readonly h: Harness; readonly report: ProbeReport }> {
  const h = harness(name, () => OK_VEHICLES);
  const report = await runProbe(h.deps);
  assert.equal(h.calls.length, 3, 'one download and two departures calls');
  assert.equal(report.ok, true, report.failures.join('; '));
  return { h, report };
}

describe('probe-transitland (M8.2a): a whole run', () => {
  test('the key never in the URL: every request carries it in the apikey header alone, and no report, log or capture holds it', async () => {
    const { h, report } = await fullRun('key-hygiene');
    for (const call of h.calls) {
      assert.ok(!call.url.includes(KEY), `no key in ${call.url}`);
      assert.deepEqual(call.init.headers, { apikey: KEY });
    }
    assert.ok(!JSON.stringify(report).includes(KEY));
    assert.ok(h.logs.every((line) => !line.includes(KEY)));
    for (const name of savedFiles(h.dir)) {
      assert.ok(!readFileSync(join(h.dir, name)).includes(Buffer.from(KEY)), `${name} holds no key`);
    }
  });

  test('on the synthetic bodies the report carries every acceptance value, and each capture is saved byte for byte', async () => {
    const { h, report } = await fullRun('full');
    const inScope = decoded.ok ? decoded.value.entity.filter((e) => ['31009', '14456', '14457'].includes(e.vehicle?.trip?.routeId ?? '')).length : 0;
    assert.equal(report.railMover, inScope);
    assert.equal(report.matchRate, 1);
    assert.equal(report.oracleMatch, true);
    assert.equal(report.feedAgeS, 30);
    assert.equal(report.bytesPerPoll, SYNTHETIC_VEHICLE_POSITIONS_BYTES.length);
    assert.deepEqual(savedFiles(h.dir), ['departures-9512.json', 'departures-9513.json', 'vehicle_positions.pb']);
    assert.deepEqual(new Uint8Array(readFileSync(join(h.dir, 'vehicle_positions.pb'))), SYNTHETIC_VEHICLE_POSITIONS_BYTES);
    for (const stopId of ['9512', '9513'] as const) {
      const rows = SYNTHETIC_DEPARTURES[stopId].stops[0]?.departures ?? [];
      const live = rows.filter((row) => row.trip.schedule_relationship !== 'STATIC' && row.departure.estimated_utc !== null).length;
      assert.deepEqual(report.departures[stopId], { status: 200, bytes: DEPARTURE_BODIES[stopId]?.length, rows: rows.length, realtime: live });
    }
  });

  test('an empty 200 body is a reported failure, never a crash: nothing to decode, nothing saved', async () => {
    const empty: Answer = { status: 200, body: new Uint8Array() };
    const download = await runProbe(harness('empty-download', () => empty).deps);
    assert.equal(download.ok, false);
    assert.match(download.failures.join('; '), /HTTP 200 with an empty body from the vehicle-positions download/);
    const h = harness('empty-departures', () => OK_VEHICLES, (stopId) => (stopId === '9512' ? empty : { status: 200, body: DEPARTURE_BODIES[stopId] ?? new Uint8Array() }));
    const report = await runProbe(h.deps);
    assert.deepEqual(report.departures['9512'], { status: 200, bytes: 0, rows: null, realtime: null });
    assert.deepEqual(savedFiles(h.dir), ['departures-9513.json', 'vehicle_positions.pb']);
  });

  test('a response that echoes the key is not saved, and the probe fails', async () => {
    const echo = new Uint8Array(Buffer.from(JSON.stringify({ ...SYNTHETIC_DEPARTURES['9513'], echoed: KEY })));
    const h = harness('echo', () => OK_VEHICLES, (stopId) => ({ status: 200, body: stopId === '9513' ? echo : (DEPARTURE_BODIES[stopId] ?? new Uint8Array()) }));
    const report = await runProbe(h.deps);
    assert.equal(report.ok, false);
    assert.match(report.failures.join('; '), /departures-9513\.json response echoed the key/);
    assert.deepEqual(savedFiles(h.dir), ['departures-9512.json', 'vehicle_positions.pb']);
  });
});
