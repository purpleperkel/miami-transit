import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { ScheduledVehicle } from '../../../src/domain/schedule/positions';
import type { LatLon } from '../../../src/lib/geo';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M3.6: the scheduled-vehicle snapshot on the REAL committed schedule DB (assets/db/schedule.db,
 * in place), Wednesday 2026-09-30 08:00 New York. Three checks, each independent of the engine:
 *  - the counts per mode are DISTINCT vehicle keys (date:block_id), so the Inner Loop's chained
 *    half-trips — two trips touching at one join — count as one vehicle;
 *  - the key set is exactly what plain SQL says is out there: every block with a trip in progress
 *    at 08:00, plus every block standing in a gap of at most 600 s between two of its trips;
 *  - every vehicle lies within 50 m of its own trip's shape_point polyline, measured here with a
 *    separate point-to-segment computation, never through the interpolator.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

const WED_DATE = 20260930;
const WED_0800 = nyEpoch('2026-09-30T08:00-04:00');
/** 08:00 as seconds of Wednesday's service day (base_epoch 1790740800, local midnight). */
const WED_0800_S = 28_800;
const METRES_PER_DEGREE = (6_371_008.8 * Math.PI) / 180;

type ExpectedVehicle = { readonly block_id: string; readonly mode: number };

const SNAPSHOT = takeSnapshot();

function takeSnapshot(): readonly ScheduledVehicle[] {
  assert.equal(WED_0800, 1_790_769_600, 'Wed 2026-09-30 08:00 America/New_York');
  const outcome = repo.vehiclesAt(WED_0800);
  assert.ok(outcome.kind === 'vehicles', `expected vehicles at Wed 08:00, got ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.serviceDates, [WED_DATE], 'only Wednesday’s service runs around 08:00');
  return outcome.vehicles;
}

/** Plain SQL, not the engine: the blocks running a trip at 08:00, plus the blocks in a gap of <= 600 s. */
function expectedVehicles(): ExpectedVehicle[] {
  const rows = db.all<ExpectedVehicle>(
    `WITH day_trip AS (
       SELECT t.block_id, t.start_s, t.end_s, l.mode
       FROM trip AS t
       JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
       JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
       JOIN line AS l ON l.line_id = p.line_id)
     SELECT block_id, mode FROM day_trip WHERE start_s <= :s AND end_s >= :s
     UNION
     SELECT x.block_id, x.mode FROM day_trip AS x JOIN day_trip AS y ON y.block_id = x.block_id
     WHERE x.end_s < :s AND y.start_s > :s AND y.start_s - x.end_s <= 600
       AND NOT EXISTS (SELECT 1 FROM day_trip AS z WHERE z.block_id = x.block_id AND z.start_s > x.start_s AND z.start_s < y.start_s)
     ORDER BY block_id`,
    { date: WED_DATE, s: WED_0800_S },
  );
  assert.ok(rows.length > 0, 'trains and movers run at 08:00 on a Wednesday');
  assert.equal(new Set(rows.map((r) => r.block_id)).size, rows.length, 'a block runs one mode');
  return rows;
}

/** How many TRIPS (not vehicles) of a mode are in progress at 08:00 — a join counts two. */
function tripsInProgress(mode: number): number {
  const row = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM trip AS t
     JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
     JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
     JOIN line AS l ON l.line_id = p.line_id
     WHERE l.mode = :mode AND t.start_s <= :s AND t.end_s >= :s`,
    { date: WED_DATE, s: WED_0800_S, mode },
  );
  assert.ok(row !== null && Number.isInteger(row.n), 'count(*) returns a row');
  assert.ok(row.n > 0, `mode ${mode} has trips in progress at 08:00`);
  return row.n;
}

/** The trip's shape polyline straight from shape_point, found from the trip_id (not the engine's shape index). */
function tripShapePoints(tripId: string): LatLon[] {
  const rows = db.all<{ lat: number; lon: number }>(
    `SELECT sp.lat, sp.lon FROM trip AS t
     JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
     JOIN shape_point AS sp ON sp.shape_idx = p.shape_idx
     WHERE t.trip_id = :trip_id ORDER BY sp.seq`,
    { trip_id: tripId },
  );
  assert.ok(rows.length >= 2, `trip ${tripId} runs on a shape with points`);
  assert.ok(rows.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)), `trip ${tripId}'s shape points are coordinates`);
  return rows.map((r) => ({ latitude: r.lat, longitude: r.lon }));
}

/**
 * Metres from `point` to the polyline: the nearest point of any segment, in a local equirectangular
 * frame centred on `point` (exact to well under a metre at these distances).
 */
function metresToPolyline(point: LatLon, polyline: readonly LatLon[]): number {
  assert.ok(polyline.length >= 2, 'a polyline has a segment');
  const east = Math.cos((point.latitude * Math.PI) / 180) * METRES_PER_DEGREE;
  const xy = polyline.map((p) => [(p.longitude - point.longitude) * east, (p.latitude - point.latitude) * METRES_PER_DEGREE] as const);
  let nearest = Infinity;
  for (let i = 1; i < xy.length; i += 1) {
    const [ax, ay] = xy[i - 1]!;
    const [bx, by] = xy[i]!;
    const [dx, dy] = [bx - ax, by - ay];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy));
  }
  assert.ok(Number.isFinite(nearest), 'the polyline has a nearest point');
  return nearest;
}

function byMode(mode: 'rail' | 'mover'): ScheduledVehicle[] {
  const vehicles = SNAPSHOT.filter((v) => v.mode === mode);
  assert.equal(new Set(vehicles.map((v) => v.vehicleKey)).size, vehicles.length, `${mode}: one vehicle per key`);
  assert.ok(vehicles.every((v) => v.vehicleKey.startsWith(`${WED_DATE}:`)), 'every key is Wednesday’s');
  return vehicles;
}

describe('scheduled vehicles on the real schedule DB (M3.6)', () => {
  test('Wed 08:00 → 8–30 rail vehicles, exactly the blocks SQL finds running or in a <= 600 s layover', () => {
    const rail = byMode('rail');
    assert.ok(rail.length >= 8 && rail.length <= 30, `${rail.length} rail vehicles at Wed 08:00, want 8–30`);
    const expected = expectedVehicles().filter((v) => v.mode === 0).map((v) => `${WED_DATE}:${v.block_id}`);
    assert.deepEqual(rail.map((v) => v.vehicleKey), expected);
    assert.ok(rail.every((v) => v.lineId === 'GREEN' || v.lineId === 'ORANGE'), 'rail vehicles run the Green or Orange Line');
  });

  test('Wed 08:00 → 10–40 Mover vehicles, counted as distinct keys: chained Inner Loop half-trips are one vehicle', () => {
    const mover = byMode('mover');
    assert.ok(mover.length >= 10 && mover.length <= 40, `${mover.length} Mover vehicles at Wed 08:00, want 10–40`);
    const expected = expectedVehicles().filter((v) => v.mode === 1).map((v) => `${WED_DATE}:${v.block_id}`);
    assert.deepEqual(mover.map((v) => v.vehicleKey), expected);
    // Not vacuous: at 08:00 sharp a block hands over between half-trips, so counting trips over-counts.
    assert.ok(tripsInProgress(1) > mover.filter((v) => v.state !== 'layover').length, 'a join at 08:00 puts two trips on one vehicle');
    assert.ok(mover.some((v) => v.lineId === 'MM_INNER'), 'the Inner Loop is running');
  });

  test('every Wed 08:00 vehicle lies within 50 m of its own trip’s shape_point polyline, measured independently', () => {
    assert.ok(SNAPSHOT.length >= 18, `a full snapshot is measured (${SNAPSHOT.length} vehicles)`);
    const offsets = SNAPSHOT.map((v) => ({ key: v.vehicleKey, metres: metresToPolyline(v.position, tripShapePoints(v.tripId)) }));
    const worst = offsets.reduce((a, b) => (b.metres > a.metres ? b : a));
    assert.ok(worst.metres <= 50, `${worst.key} is ${worst.metres.toFixed(1)} m from its shape (max 50 m)`);
  });

  test('the independent 50 m measure can fail: a point 200 m north of an east–west track reads 200 m', () => {
    const on: LatLon = { latitude: 25.77, longitude: -80.19 };
    const track = [{ ...on, longitude: on.longitude - 0.01 }, { ...on, longitude: on.longitude + 0.01 }];
    const north = { ...on, latitude: on.latitude + 200 / METRES_PER_DEGREE };
    assert.ok(Math.abs(metresToPolyline(north, track) - 200) < 0.5, 'a 200 m offset measures 200 m');
    assert.ok(metresToPolyline(on, track) < 1e-6, 'a point on the track measures 0 m');
  });
});
