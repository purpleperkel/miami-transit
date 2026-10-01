import { fetch } from 'expo/fetch';
import { deleteDatabaseAsync, importDatabaseFromAssetAsync, openDatabaseAsync } from 'expo-sqlite';

import manifest from '../../../../assets/db/manifest.json';
import { err, ok } from '../../../lib/result';
import { judgeScheduleDb, judgeZipHead, probeBinaryFetch, probeProtobufDecode, probeSqliteAsset } from '../data-probes';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ deleteDatabaseAsync: jest.fn(), importDatabaseFromAssetAsync: jest.fn(), openDatabaseAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockImport = jest.mocked(importDatabaseFromAssetAsync);
const mockOpen = jest.mocked(openDatabaseAsync);
const mockDelete = jest.mocked(deleteDatabaseAsync);
const mockFetch = jest.mocked(fetch);
/** The meta rows the real schedule DB holds (assets/db/schedule.db), as the manifest records them. */
const TRUE_META = [
  { key: 'builder_version', value: String(manifest.builderVersion) },
  { key: 'feed_sha256', value: manifest.feedSha256 },
  { key: 'schema_version', value: String(manifest.schemaVersion) },
  { key: 'time_zone', value: 'America/New_York' },
];
const TRUE_COUNTS = { trips: manifest.counts.trips, stopTimes: manifest.counts.stopTimes };

/** The true meta rows as the key → value map the probe builds. */
function trueMeta(): Map<string, string> {
  const meta = new Map(TRUE_META.map((row) => [row.key, row.value]));
  expect(meta.size).toBe(TRUE_META.length);
  expect(meta.get('feed_sha256')).toBe(manifest.feedSha256);
  return meta;
}

/** The first 1 KB of a zip: the PK\x03\x04 signature, then bytes >= 0x80 like a real local header. */
function zipHead(length = 1024): Uint8Array {
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 0x80) % 256);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  expect(bytes.length).toBe(length);
  expect(bytes.some((b) => b >= 0x80)).toBe(true);
  return bytes;
}

/** A stand-in SQLiteDatabase answering the probe's meta query, then its counts query. */
function fakeDb(meta: readonly object[], counts: object | null) {
  const db = {
    getAllAsync: jest.fn().mockResolvedValueOnce(meta),
    getFirstAsync: jest.fn().mockResolvedValueOnce(counts),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
  expect(db.getAllAsync).not.toHaveBeenCalled();
  expect(db.closeAsync).not.toHaveBeenCalled();
  return db;
}

afterEach(() => {
  jest.resetAllMocks();
  delete (globalThis as { HermesInternal?: unknown }).HermesInternal;
});

describe('probeSqliteAsset', () => {
  it('imports this bundle’s schedule DB into its own copy (overwriting any old one), reads it, then closes and deletes it', async () => {
    const db = fakeDb(TRUE_META, TRUE_COUNTS);
    mockOpen.mockResolvedValue(db as never);
    const outcome = await probeSqliteAsset();
    expect(outcome.ok).toBe(true);
    expect(mockImport).toHaveBeenCalledWith('diagnostics-schedule.db', expect.objectContaining({ forceOverwrite: true }));
    expect(db.getAllAsync.mock.calls[0]?.[0]).toMatch(/FROM meta/);
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('diagnostics-schedule.db');
  });

  it('closes the DB and fails (never throws) when a query rejects', async () => {
    const db = fakeDb([], null);
    db.getAllAsync.mockReset().mockRejectedValue(new Error('file is not a database'));
    mockOpen.mockResolvedValue(db as never);
    await expect(probeSqliteAsset()).resolves.toEqual(err('SQLite asset: file is not a database'));
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('judgeScheduleDb', () => {
  it('passes only when the phone reads the feed, schema and counts the manifest records', () => {
    expect(judgeScheduleDb(trueMeta(), TRUE_COUNTS)).toEqual(
      ok(`5137 trips, 45937 stop times; feed ${manifest.feedSha256.slice(0, 8)}, schema 1, builder 2 match the manifest`),
    );
    expect(judgeScheduleDb(trueMeta(), null).ok).toBe(false);
  });

  it('fails on a different feed, a different builder, or one trip short', () => {
    const otherFeed = new Map([...trueMeta(), ['feed_sha256', '0'.repeat(64)]]);
    expect(judgeScheduleDb(otherFeed, TRUE_COUNTS).ok).toBe(false);
    expect(judgeScheduleDb(new Map([...trueMeta(), ['builder_version', '1']]), TRUE_COUNTS).ok).toBe(false);
    expect(judgeScheduleDb(trueMeta(), { ...TRUE_COUNTS, trips: TRUE_COUNTS.trips - 1 })).toEqual(
      err(`SQLite asset: counted 5136 trips and 45937 stop times, want 5137 and 45937`),
    );
  });
});

describe('probeProtobufDecode', () => {
  it('decodes the committed fixture on Hermes and matches every field', async () => {
    (globalThis as { HermesInternal?: unknown }).HermesInternal = {};
    const outcome = await probeProtobufDecode();
    expect(outcome).toEqual(ok('4 vehicles from 483 bytes on Hermes; every field matches'));
    expect(outcome.ok).toBe(true);
  });

  it('refuses to pass off Hermes, where it would prove nothing about Hermes', async () => {
    expect((globalThis as { HermesInternal?: unknown }).HermesInternal).toBeUndefined();
    const outcome = await probeProtobufDecode();
    expect(outcome.ok).toBe(false);
  });
});

describe('probeBinaryFetch', () => {
  it('asks the keyless county zip for its first 1 KB and passes on intact bytes', async () => {
    const body = zipHead();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 206,
      headers: { get: (name: string) => (name === 'content-length' ? '1024' : null) },
      arrayBuffer: () => Promise.resolve(body.buffer),
    } as never);
    await expect(probeBinaryFetch()).resolves.toEqual(ok('HTTP 206: 1024 of 1024 declared bytes, zip signature intact'));
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://www.miamidade.gov/transit/googletransit/current/google_transit.zip');
    expect(init).toEqual({ headers: { Range: 'bytes=0-1023' } });
  });

  it('fails on an HTTP error or a network failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as never);
    await expect(probeBinaryFetch()).resolves.toEqual(err('binary fetch: HTTP 503'));
    mockFetch.mockRejectedValueOnce(new Error('The Internet connection appears to be offline.'));
    await expect(probeBinaryFetch()).resolves.toEqual(err('binary fetch: The Internet connection appears to be offline.'));
  });
});

describe('judgeZipHead', () => {
  it('fails on an empty body, a length the server did not declare, or a wrong signature', () => {
    expect(judgeZipHead(206, '0', new Uint8Array(0))).toEqual(err('binary fetch: HTTP 206 with an empty body'));
    expect(judgeZipHead(206, '1024', zipHead(1020)).ok).toBe(false);
    expect(judgeZipHead(206, null, zipHead()).ok).toBe(false);
    const html = new TextEncoder().encode('<html>'.padEnd(1024, ' '));
    expect(judgeZipHead(200, '1024', html)).toEqual(err('binary fetch: expected zip bytes 50 4b 03 04, got 3c 68 74 6d'));
  });
});
