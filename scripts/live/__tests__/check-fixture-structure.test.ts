import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { transit_realtime } from 'gtfs-realtime-bindings';

import { SYNTHETIC_DEPARTURES } from '../../../src/domain/live/__fixtures__/synthetic-departures';
import { SYNTHETIC_VEHICLE_POSITIONS_BYTES } from '../../../src/domain/live/__fixtures__/synthetic-vehicle-positions';
import { type StructureInput, structureGaps } from '../check-fixture-structure';

/**
 * M8.3: the structure checker says NO when the synthetic fixtures lack a field path, a key path or
 * an enum value of the real captures, and YES when they cover everything. Every document here is
 * made up for the test (or is the synthetic fixture itself); no capture is read.
 */

const { IN_TRANSIT_TO, STOPPED_AT } = transit_realtime.VehiclePosition.VehicleStopStatus;
const WORK = mkdtempSync(join(tmpdir(), 'check-fixture-structure-test-'));
after(() => rmSync(WORK, { recursive: true, force: true }));

const VEHICLE: transit_realtime.IVehiclePosition = {
  trip: { tripId: 'syn-trip-1', routeId: 'syn-route-1', scheduleRelationship: 0 },
  position: { latitude: 25.77, longitude: -80.19 },
  currentStatus: IN_TRANSIT_TO,
  timestamp: 1_790_770_480,
  vehicle: { id: 'syn-1', label: 'syn-1' },
};

/** A made-up feed of these vehicles, encoded by the reference bindings. */
function feedOf(...vehicles: transit_realtime.IVehiclePosition[]): Uint8Array {
  const message: transit_realtime.IFeedMessage = {
    header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: 1_790_770_500 },
    entity: vehicles.map((vehicle, i) => ({ id: `syn-${i + 1}`, vehicle })),
  };
  assert.equal(transit_realtime.FeedMessage.verify(message), null);
  const bytes = transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject(message)).finish();
  assert.ok(bytes.length > 0);
  return bytes;
}

/** A made-up departures response with one row, reshaped by `edit`. */
function departuresOf(edit: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row): unknown {
  const row = { trip: { trip_id: 'syn-trip-1', schedule_relationship: 'SCHEDULED' }, departure: { scheduled_local: '2026-09-30T08:20:00-04:00', estimated_utc: '2026-09-30T12:21:00Z' } };
  const body = { stops: [{ stop_id: '9512', departures: [edit(row)] }] };
  assert.equal(body.stops.length, 1);
  assert.equal(body.stops[0]?.departures.length, 1);
  return body;
}

const BASE: StructureInput = { vehiclePositions: feedOf(VEHICLE), departures: [departuresOf()] };

describe('check-fixture-structure (M8.3): what the synthetic lacks', () => {
  test('a protobuf field path missing from the synthetic is not conformant', () => {
    const real = { ...BASE, vehiclePositions: feedOf({ ...VEHICLE, position: { latitude: 25.77, longitude: -80.19, odometer: 1_200 } }) };
    const verdict = structureGaps(real, BASE);
    assert.equal(verdict.conformant, false);
    assert.deepEqual(verdict.missing, ['vehicle_positions entity[].vehicle.position.odometer']);
  });

  test('a json key path missing from the synthetic is not conformant', () => {
    const real = { ...BASE, departures: [departuresOf((row) => ({ ...row, stop_headsign: null }))] };
    const verdict = structureGaps(real, BASE);
    assert.equal(verdict.conformant, false);
    assert.deepEqual(verdict.missing, ['departures stops[].departures[].stop_headsign']);
  });

  test('an enum value missing from the synthetic is not conformant', () => {
    const stopped = { ...BASE, vehiclePositions: feedOf({ ...VEHICLE, currentStatus: STOPPED_AT }) };
    assert.deepEqual(structureGaps(stopped, BASE), { conformant: false, missing: ['vehicle_positions entity[].vehicle.currentStatus=STOPPED_AT'] });
    const statics = { ...BASE, departures: [departuresOf((row) => ({ ...row, trip: { trip_id: 'syn-trip-1', schedule_relationship: 'STATIC' } }))] };
    assert.deepEqual(structureGaps(statics, BASE), { conformant: false, missing: ['departures stops[].departures[].trip.schedule_relationship=STATIC'] });
  });

  test('all covered: every real path and enum value present is conformant, extra synthetic structure allowed', () => {
    const richer: StructureInput = {
      vehiclePositions: feedOf(VEHICLE, { ...VEHICLE, currentStatus: STOPPED_AT, position: { latitude: 25.78, longitude: -80.2, bearing: 90 } }),
      departures: [departuresOf(), departuresOf((row) => ({ ...row, stop_headsign: null }))],
    };
    assert.deepEqual(structureGaps(BASE, BASE), { conformant: true, missing: [] });
    assert.deepEqual(structureGaps(BASE, richer), { conformant: true, missing: [] });
    assert.equal(structureGaps(richer, BASE).conformant, false, 'the relation is one-way: real ⊆ synthetic');
  });
});

/** A capture directory holding these three documents. */
function captureDir(name: string, vehicles: Uint8Array, departures: readonly [unknown, unknown]): string {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vehicle_positions.pb'), vehicles);
  departures.forEach((body, i) => writeFileSync(join(dir, `departures-${i === 0 ? '9512' : '9513'}.json`), JSON.stringify(body)));
  assert.ok(dir.startsWith(WORK));
  assert.ok(vehicles.length > 0);
  return dir;
}

function runChecker(dir: string): { readonly status: number | null; readonly lines: string[] } {
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const run = spawnSync(tsx, [join('scripts', 'live', 'check-fixture-structure.ts'), '--captures', dir], { encoding: 'utf8' });
  assert.equal(run.error, undefined);
  const lines = run.stdout.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, `exactly one stdout line, got: ${run.stdout}${run.stderr}`);
  return { status: run.status, lines };
}

describe('check-fixture-structure (M8.3): the command line', () => {
  test('one stdout line: exit 0 for captures shaped like the synthetic fixtures, 1 for a new key or no capture', () => {
    const same = captureDir('same', SYNTHETIC_VEHICLE_POSITIONS_BYTES, [SYNTHETIC_DEPARTURES['9512'], SYNTHETIC_DEPARTURES['9513']]);
    assert.deepEqual(runChecker(same), { status: 0, lines: ['{"conformant":true,"missing":[]}'] });
    const extra = captureDir('extra', SYNTHETIC_VEHICLE_POSITIONS_BYTES, [{ ...SYNTHETIC_DEPARTURES['9512'], meta: { after: 1 } }, SYNTHETIC_DEPARTURES['9513']]);
    assert.deepEqual(runChecker(extra), { status: 1, lines: ['{"conformant":false,"missing":["departures meta","departures meta.after"]}'] });
    const none = runChecker(join(WORK, 'no-such-dir'));
    assert.equal(none.status, 1);
    assert.match(none.lines[0] ?? '', /^\{"conformant":false,"missing":\[\],"error":"no capture at /);
  });
});
