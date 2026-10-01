import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { transit_realtime } from 'gtfs-realtime-bindings';

import { decodeFeedMessage } from '../../src/domain/gtfsrt/decode-feed';
import type { FeedMessage } from '../../src/domain/gtfsrt/types';
import { invariant } from '../../src/lib/invariant';

/**
 * Generates `src/domain/gtfsrt/__fixtures__/vehicle-positions.fixture.ts` — a small, synthetic
 * Miami VehiclePositions feed for tests and the on-device decode probe (M1.16):
 *   - ENCODED by the reference GTFS-realtime bindings (the test oracle; Mac-side only, never shipped),
 *   - DECODED by our own decoder, and written as the bytes plus that decoded value.
 * oracle.test.ts then proves the reference decoder reads the same bytes identically.
 *
 * Deterministic by construction: fixed timestamps, no clock, no time zone, no randomness — so a
 * rerun reproduces the file byte for byte. Run from the repo root:
 *   npx tsx scripts/fixtures/make-gtfsrt-fixture.ts
 */

const OUTPUT = 'src/domain/gtfsrt/__fixtures__/vehicle-positions.fixture.ts';
/** 2026-10-01T16:30:00Z, written as a number so no Date (and no time zone) is ever involved. */
const FEED_TIMESTAMP = 1_790_872_200;
const BYTES_PER_LINE = 16;

type VehicleSpec = {
  readonly id: string;
  readonly label: string;
  readonly tripId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly at: readonly [latitude: number, longitude: number];
  readonly bearing: number;
  readonly speed: number;
  readonly secondsOld: number;
  readonly stop?: { readonly stopId: string; readonly status: number; readonly sequence: number };
};

/**
 * Route ids 31009 (Metrorail), 14456 (Metromover Omni) and 14457 (Metromover Inner) and stop ids
 * 9512 / 9513 (Government Center rail, SB / NB) and 813 (Mover) are the ones the plan's §3 live
 * check named. Vehicle ids, trip ids and coordinates are synthetic. The last vehicle's label
 * carries a curly apostrophe so the fixture exercises multi-byte UTF-8.
 */
const VEHICLES: readonly VehicleSpec[] = [
  { id: 'rail-213', label: '213', tripId: 'fixture-rail-0815', routeId: '31009', directionId: 0, at: [25.7747, -80.1955], bearing: 0, speed: 0, secondsOld: 12, stop: { stopId: '9513', status: 1, sequence: 12 } },
  { id: 'rail-157', label: '157', tripId: 'fixture-rail-0822', routeId: '31009', directionId: 1, at: [25.7586, -80.1951], bearing: 182, speed: 15.6, secondsOld: 25, stop: { stopId: '9512', status: 2, sequence: 14 } },
  { id: 'mover-31', label: '31', tripId: 'fixture-omni-1630', routeId: '14456', directionId: 0, at: [25.7761, -80.1902], bearing: 270, speed: 6.7, secondsOld: 8, stop: { stopId: '813', status: 0, sequence: 3 } },
  { id: 'mover-07', label: 'Gov’t Center', tripId: 'fixture-inner-1631', routeId: '14457', directionId: 0, at: [25.7739, -80.1917], bearing: 45, speed: 4.2, secondsOld: 40 },
];

function vehicleEntity(spec: VehicleSpec): transit_realtime.IFeedEntity {
  invariant(spec.secondsOld >= 0 && spec.secondsOld < 300, 'fixture vehicles are a few seconds to minutes old');
  invariant(spec.at[0] > 25 && spec.at[0] < 26.5 && spec.at[1] > -81 && spec.at[1] < -80, 'fixture vehicles are in Miami');
  const stop = spec.stop === undefined ? {} : { stopId: spec.stop.stopId, currentStatus: spec.stop.status, currentStopSequence: spec.stop.sequence };
  return {
    id: `vehicle-${spec.id}`,
    vehicle: {
      trip: { tripId: spec.tripId, routeId: spec.routeId, directionId: spec.directionId, startDate: '20261001' },
      vehicle: { id: spec.id, label: spec.label },
      position: { latitude: spec.at[0], longitude: spec.at[1], bearing: spec.bearing, speed: spec.speed },
      timestamp: FEED_TIMESTAMP - spec.secondsOld,
      ...stop,
    },
  };
}

/** The feed encoded by the reference bindings, as a plain Uint8Array (not a Node Buffer). */
function encodeFeed(): Uint8Array {
  const plain: transit_realtime.IFeedMessage = {
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: FEED_TIMESTAMP },
    entity: VEHICLES.map((spec) => vehicleEntity(spec)),
  };
  const problem = transit_realtime.FeedMessage.verify(plain);
  invariant(problem === null, `the fixture feed is a valid FeedMessage: ${String(problem)}`);
  const bytes = Uint8Array.from(transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject(plain)).finish());
  invariant(bytes.length > 0, 'the encoded feed has bytes');
  return bytes;
}

function formatBytes(bytes: Uint8Array): string {
  invariant(bytes.length > 0, 'there are bytes to format');
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += BYTES_PER_LINE) {
    const row = Array.from(bytes.subarray(at, at + BYTES_PER_LINE), (byte) => `0x${byte.toString(16).padStart(2, '0')},`);
    lines.push(`  ${row.join(' ')}`);
  }
  invariant(lines.length === Math.ceil(bytes.length / BYTES_PER_LINE), 'one line per 16 bytes');
  return lines.join('\n');
}

function renderFixture(bytes: Uint8Array, decoded: FeedMessage): string {
  invariant(decoded.entity.length === VEHICLES.length, 'every fixture vehicle decoded');
  const text = [
    '// GENERATED by scripts/fixtures/make-gtfsrt-fixture.ts — do not edit by hand; rerun the generator.',
    "import type { FeedMessage } from '../types';",
    '',
    `/** A synthetic Miami GTFS-realtime VehiclePositions feed: ${decoded.entity.length} vehicles, ${bytes.length} bytes. */`,
    'export const VEHICLE_POSITIONS_FIXTURE_BYTES: Uint8Array = new Uint8Array([',
    formatBytes(bytes),
    ']);',
    '',
    '/** What `decodeFeedMessage(VEHICLE_POSITIONS_FIXTURE_BYTES)` returns (oracle.test.ts proves the reference decoder agrees). */',
    `export const VEHICLE_POSITIONS_FIXTURE_DECODED: FeedMessage = ${JSON.stringify(decoded, null, 2)};`,
    '',
  ].join('\n');
  invariant(!text.includes('\r'), 'the fixture uses LF line endings on every platform');
  return text;
}

function main(): number {
  invariant(existsSync('package.json') && existsSync('src/domain/gtfsrt'), 'run the generator from the repo root');
  const bytes = encodeFeed();
  const decoded = decodeFeedMessage(bytes);
  invariant(decoded.ok, `our decoder reads the fixture: ${decoded.ok ? '' : decoded.error.message}`);
  const text = renderFixture(bytes, decoded.value);
  mkdirSync(dirname(join(process.cwd(), OUTPUT)), { recursive: true });
  writeFileSync(OUTPUT, text, 'utf8');
  invariant(statSync(OUTPUT).size === Buffer.byteLength(text, 'utf8'), 'the fixture was written in full');
  console.log(`wrote ${OUTPUT} (${bytes.length} feed bytes, ${decoded.value.entity.length} vehicles)`);
  return 0;
}

process.exitCode = main();
