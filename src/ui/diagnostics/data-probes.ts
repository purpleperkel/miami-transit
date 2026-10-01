import { fetch } from 'expo/fetch';
import { importDatabaseFromAssetAsync, openDatabaseAsync } from 'expo-sqlite';

import probeDbAsset from '@/assets/db/probe.db';
import probeManifest from '@/assets/db/probe-manifest.json';
import {
  VEHICLE_POSITIONS_FIXTURE_BYTES,
  VEHICLE_POSITIONS_FIXTURE_DECODED,
} from '@/domain/gtfsrt/__fixtures__/vehicle-positions.fixture';
import { decodeFeedMessage } from '@/domain/gtfsrt/decode-feed';
import { invariant } from '@/lib/invariant';
import { err, ok } from '@/lib/result';

import { firstDifference } from './first-difference';
import { type ProbeOutcome, settleProbe } from './probe-kit';

/**
 * M1.16 data probes — the three data paths the app depends on, run on the phone (Hermes, Expo Go):
 *   probeSqliteAsset     the bundled node:sqlite DB imports and opens in expo-sqlite (risk R4)
 *   probeProtobufDecode  our GTFS-realtime decoder runs on Hermes and reproduces the Mac's decode
 *   probeBinaryFetch     `expo/fetch` hands back binary bytes intact (risk R6)
 */

/** The plan's acceptance count for the bundled probe DB (M1.14 / M1.16). */
const EXPECTED_ROWS = 1000;
/** The imported copy's file name in expo-sqlite's database directory. */
const PROBE_DB_NAME = 'probe.db';
const SQLITE_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Public and keyless: the county's GTFS schedule zip (plan §1), the same file the Mac pipeline
 * reads. An HTTP Range request asks for its first 1 KB only, so the probe costs ~1 KB of cellular.
 */
const BINARY_PROBE_URL = 'https://www.miamidade.gov/transit/googletransit/current/google_transit.zip';
const BINARY_PROBE_RANGE = 'bytes=0-1023';
/** "PK\x03\x04", a zip's local-file-header signature: proves these are the zip's first bytes. */
const ZIP_SIGNATURE: readonly number[] = [0x50, 0x4b, 0x03, 0x04];

type ProbeTotals = { readonly rows: number; readonly epochSum: number };

export function probeSqliteAsset(): Promise<ProbeOutcome> {
  invariant(typeof probeDbAsset === 'number', 'the probe DB is bundled as a Metro asset (metro.config.js)');
  invariant(probeManifest.rows === EXPECTED_ROWS, `the bundled manifest describes the ${EXPECTED_ROWS}-row probe DB`);
  return settleProbe('SQLite asset', readBundledProbeDb, SQLITE_TIMEOUT_MS);
}

/**
 * The import is exactly what SQLiteProvider's documented `assetSource` prop runs
 * (expo-sqlite 57 src/hooks.tsx, openDatabaseWithInitAsync), called directly so the probe can
 * report a Result. `forceOverwrite` makes every run read THIS bundle's DB, never a stale copy.
 */
async function readBundledProbeDb(): Promise<ProbeOutcome> {
  const table = probeManifest.table;
  invariant(/^[a-z_]+$/.test(table), 'the manifest names a plain SQL table');
  await importDatabaseFromAssetAsync(PROBE_DB_NAME, { assetId: probeDbAsset, forceOverwrite: true });
  const db = await openDatabaseAsync(PROBE_DB_NAME, { useNewConnection: true });
  try {
    const totals = await db.getFirstAsync<ProbeTotals>(`SELECT COUNT(*) AS rows, SUM(epoch) AS epochSum FROM ${table}`);
    const sample = await db.getFirstAsync<{ label: string }>(
      `SELECT label FROM ${table} WHERE id = ?`,
      probeManifest.unicodeLabel.id,
    );
    const outcome = judgeProbeDb(totals, sample?.label ?? null);
    invariant(outcome.ok || outcome.error.length > 0, 'a failed SQLite probe says why');
    return outcome;
  } finally {
    await db.closeAsync();
  }
}

/** The phone's reading of the DB must match what the Mac wrote (assets/db/probe-manifest.json). */
export function judgeProbeDb(totals: ProbeTotals | null, unicodeLabel: string | null): ProbeOutcome {
  invariant(probeManifest.rows === EXPECTED_ROWS, 'the manifest is the 1000-row probe manifest');
  invariant(probeManifest.unicodeLabel.label.length > 0, 'the manifest carries a unicode sample label');
  if (totals === null) {
    return err(`SQLite asset: ${probeManifest.table} returned no totals row`);
  }
  if (totals.rows !== EXPECTED_ROWS) {
    return err(`SQLite asset: counted ${totals.rows} rows in ${probeManifest.table}, want ${EXPECTED_ROWS}`);
  }
  if (totals.epochSum !== probeManifest.epochSum) {
    return err(`SQLite asset: epoch sum ${totals.epochSum} differs from the Mac's ${probeManifest.epochSum}`);
  }
  if (unicodeLabel !== probeManifest.unicodeLabel.label) {
    return err(`SQLite asset: row ${probeManifest.unicodeLabel.id} reads ${JSON.stringify(unicodeLabel)}`);
  }
  return ok(`${totals.rows} rows in ${probeManifest.table}; epoch sum and "${unicodeLabel}" match the Mac`);
}

export function probeProtobufDecode(): Promise<ProbeOutcome> {
  invariant(VEHICLE_POSITIONS_FIXTURE_BYTES.length > 0, 'the GTFS-realtime fixture has bytes to decode');
  invariant(VEHICLE_POSITIONS_FIXTURE_DECODED.entity.length > 0, 'the fixture expects vehicles');
  return settleProbe('protobuf decode', decodeFixtureOnHermes, DECODE_TIMEOUT_MS);
}

/** Decodes the committed fixture with OUR decoder and compares every field with the Mac's decode. */
function decodeFixtureOnHermes(): ProbeOutcome {
  invariant(VEHICLE_POSITIONS_FIXTURE_BYTES instanceof Uint8Array, 'the fixture is raw protobuf bytes');
  if (typeof HermesInternal !== 'object' || HermesInternal === null) {
    return err('protobuf decode: this JS engine is not Hermes, so the run proves nothing about Hermes');
  }
  const decoded = decodeFeedMessage(VEHICLE_POSITIONS_FIXTURE_BYTES);
  if (!decoded.ok) {
    return err(`protobuf decode: ${decoded.error.message}`);
  }
  const difference = firstDifference(decoded.value, VEHICLE_POSITIONS_FIXTURE_DECODED);
  if (difference !== null) {
    return err(`protobuf decode: differs from the Mac's decode at ${difference}`);
  }
  const vehicles = decoded.value.entity.length;
  invariant(vehicles === VEHICLE_POSITIONS_FIXTURE_DECODED.entity.length, 'every expected vehicle decoded');
  return ok(`${vehicles} vehicles from ${VEHICLE_POSITIONS_FIXTURE_BYTES.length} bytes on Hermes; every field matches`);
}

export function probeBinaryFetch(): Promise<ProbeOutcome> {
  invariant(BINARY_PROBE_URL.startsWith('https://'), 'the probe fetches over TLS');
  invariant(!BINARY_PROBE_URL.includes('?'), 'no query string, so no credential can ride along');
  return settleProbe('binary fetch', fetchZipHead, FETCH_TIMEOUT_MS);
}

async function fetchZipHead(): Promise<ProbeOutcome> {
  const response = await fetch(BINARY_PROBE_URL, { headers: { Range: BINARY_PROBE_RANGE } });
  if (!response.ok) {
    return err(`binary fetch: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  invariant(buffer instanceof ArrayBuffer, 'expo/fetch arrayBuffer() yields an ArrayBuffer');
  const bytes = new Uint8Array(buffer);
  invariant(bytes.length === buffer.byteLength, 'the byte view spans the whole buffer');
  return judgeZipHead(response.status, response.headers.get('content-length'), bytes);
}

/**
 * The body must be the zip's head, byte for byte: the right signature, and exactly the length the
 * server declared. The length is the binary-integrity check (R6) — a text round-trip would replace
 * every byte >= 0x80 (a zip head is full of them) with U+FFFD and change the length.
 */
export function judgeZipHead(status: number, declaredLength: string | null, bytes: Uint8Array): ProbeOutcome {
  invariant(Number.isInteger(status) && status >= 200 && status < 300, 'only a successful response is judged');
  invariant(bytes instanceof Uint8Array, 'the body is judged as raw bytes');
  if (bytes.byteLength === 0) {
    return err(`binary fetch: HTTP ${status} with an empty body`);
  }
  if (declaredLength === null || Number(declaredLength) !== bytes.byteLength) {
    return err(`binary fetch: got ${bytes.byteLength} bytes, the server declared ${String(declaredLength)}`);
  }
  if (!ZIP_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    const head = Array.from(bytes.subarray(0, ZIP_SIGNATURE.length), (b) => b.toString(16).padStart(2, '0'));
    return err(`binary fetch: expected zip bytes 50 4b 03 04, got ${head.join(' ')}`);
  }
  return ok(`HTTP ${status}: ${bytes.byteLength} of ${declaredLength} declared bytes, zip signature intact`);
}
