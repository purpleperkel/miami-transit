import { fetch } from 'expo/fetch';
import { importDatabaseFromAssetAsync, openDatabaseAsync } from 'expo-sqlite';

import probeManifest from '../../../../assets/db/probe-manifest.json';
import { err, ok } from '../../../lib/result';
import { judgeProbeDb, judgeZipHead, probeBinaryFetch, probeProtobufDecode, probeSqliteAsset } from '../data-probes';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ importDatabaseFromAssetAsync: jest.fn(), openDatabaseAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockImport = jest.mocked(importDatabaseFromAssetAsync);
const mockOpen = jest.mocked(openDatabaseAsync);
const mockFetch = jest.mocked(fetch);
const TRUE_TOTALS = { rows: 1000, epochSum: probeManifest.epochSum };
const TRUE_LABEL = probeManifest.unicodeLabel.label;

/** The first 1 KB of a zip: the PK\x03\x04 signature, then bytes >= 0x80 like a real local header. */
function zipHead(length = 1024): Uint8Array {
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 0x80) % 256);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  expect(bytes.length).toBe(length);
  expect(bytes.some((b) => b >= 0x80)).toBe(true);
  return bytes;
}

/** A stand-in SQLiteDatabase answering the probe's two queries in order. */
function fakeDb(totals: object | null, label: string | null) {
  const db = {
    getFirstAsync: jest.fn().mockResolvedValueOnce(totals).mockResolvedValueOnce(label === null ? null : { label }),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
  expect(db.getFirstAsync).not.toHaveBeenCalled();
  expect(db.closeAsync).not.toHaveBeenCalled();
  return db;
}

afterEach(() => {
  jest.resetAllMocks();
  delete (globalThis as { HermesInternal?: unknown }).HermesInternal;
});

describe('probeSqliteAsset', () => {
  it('imports this bundle’s probe DB (overwriting any old copy), counts 1000 rows and closes it', async () => {
    const db = fakeDb(TRUE_TOTALS, TRUE_LABEL);
    mockOpen.mockResolvedValue(db as never);
    const outcome = await probeSqliteAsset();
    expect(outcome.ok).toBe(true);
    expect(mockImport).toHaveBeenCalledWith('probe.db', expect.objectContaining({ forceOverwrite: true }));
    expect(db.getFirstAsync.mock.calls[0]?.[0]).toMatch(/COUNT\(\*\)/);
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('closes the DB and fails (never throws) when a query rejects', async () => {
    const db = fakeDb(null, null);
    db.getFirstAsync.mockReset().mockRejectedValue(new Error('file is not a database'));
    mockOpen.mockResolvedValue(db as never);
    await expect(probeSqliteAsset()).resolves.toEqual(err('SQLite asset: file is not a database'));
    expect(db.closeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('judgeProbeDb', () => {
  it('passes only when the phone reads exactly what the Mac wrote', () => {
    expect(judgeProbeDb(TRUE_TOTALS, TRUE_LABEL)).toEqual(
      ok(`1000 rows in probe_row; epoch sum and "${TRUE_LABEL}" match the Mac`),
    );
    expect(judgeProbeDb(null, TRUE_LABEL).ok).toBe(false);
  });

  it('fails on 999 rows, a changed epoch sum or a mangled unicode label', () => {
    expect(judgeProbeDb({ ...TRUE_TOTALS, rows: 999 }, TRUE_LABEL)).toEqual(
      err('SQLite asset: counted 999 rows in probe_row, want 1000'),
    );
    expect(judgeProbeDb({ ...TRUE_TOTALS, epochSum: TRUE_TOTALS.epochSum + 60 }, TRUE_LABEL).ok).toBe(false);
    expect(judgeProbeDb(TRUE_TOTALS, 'Govâ€™t Center · 7').ok).toBe(false);
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
