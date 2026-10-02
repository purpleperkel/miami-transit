import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { type TimeWindow, windowFrom } from '../../../src/domain/gtfs/service-day';
import type { Ride } from '../../../src/domain/schedule/rides';
import { expectOk } from './expect-result';
import { nyEpoch, openRealRepo, openRealScheduleDb, stationKeyNamed } from './real-schedule';

/**
 * m3a's inputs to M7, on the REAL committed schedule DB (opened in place, read-only):
 *   - a distinct no-service outcome, so a trip card never says "transfer" when nothing runs;
 *   - the trip card's ride list drops loop-arounds a direct ride beats (ScheduleRepo.tripRides).
 * 2026-09-30 is a Wednesday; 2026-10-03 is a Saturday. Station keys are looked up by name.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

const RAIL = 0;
const MOVER = 1;
const MINUTES = 60;
const MIA = stationKeyNamed(db, 'Miami International Airport', RAIL);
const BRICKELL = stationKeyNamed(db, 'Brickell', RAIL);
/** Tuesday's last rail trip ends 01:04 and Wednesday's first starts 05:00 (checked 2026-10-01). */
const WED_0200 = windowFrom(nyEpoch('2026-09-30T02:00-04:00'), 60 * MINUTES);
const WED_0800_MOVER = windowFrom(nyEpoch('2026-09-30T08:00-04:00'), 30 * MINUTES);

function rideList(outcome: ReturnType<typeof repo.rides>): readonly Ride[] {
  const value = expectOk(outcome);
  assert.equal(value.kind, 'rides', `expected rides, got ${JSON.stringify(value)}`);
  const rides = value.kind === 'rides' ? value.rides : [];
  assert.ok(rides.every((r, i) => i === 0 || rides[i - 1]!.depEpoch <= r.depEpoch), 'rides come in departure order');
  return rides;
}

/** A ride's identity across two queries: its boarding trip and departure instant. */
function rideKey(r: Ride): string {
  assert.ok(Number.isSafeInteger(r.boardTripIdx) && Number.isSafeInteger(r.depEpoch));
  const key = `${r.serviceDate}:${r.boardTripIdx}:${r.depEpoch}`;
  assert.ok(key.length > 0);
  return key;
}

/** How long a ride takes, in minutes. */
function rideMinutes(r: Ride): number {
  assert.ok(r.arrEpoch >= r.depEpoch, 'a ride arrives after it departs');
  const taken = (r.arrEpoch - r.depEpoch) / MINUTES;
  assert.ok(Number.isFinite(taken));
  return taken;
}

/** The Knight Center -> College North (Metromover) rides, raw and as the trip card shows them. */
function knightCenterToCollegeNorth(window: TimeWindow): { raw: readonly Ride[]; trip: readonly Ride[] } {
  const from = stationKeyNamed(db, 'Knight Center', MOVER);
  const to = stationKeyNamed(db, 'College North', MOVER);
  const raw = rideList(repo.rides(from, to, window));
  const trip = rideList(repo.tripRides(from, to, window));
  const rawKeys = new Set(raw.map(rideKey));
  assert.ok(trip.every((r) => rawKeys.has(rideKey(r))), 'the trip list is a subset of the raw rides');
  assert.ok(raw.length > 0);
  return { raw, trip };
}

describe('trip rides on the real schedule DB', () => {
  test('MIA -> Brickell (Metrorail), Wed 02:00 -> no-service: nothing leaves MIA', () => {
    const departures = expectOk(repo.departures(MIA, WED_0200));
    assert.ok(departures.kind === 'departures' && departures.departures.length === 0, 'no train leaves MIA between 02:00 and 03:00');
    assert.deepEqual(expectOk(repo.rides(MIA, BRICKELL, WED_0200)), { kind: 'no-service' });
    assert.deepEqual(expectOk(repo.tripRides(MIA, BRICKELL, WED_0200)), { kind: 'no-service' });
  });

  test('Brickell -> Government Center (Metrorail), a direct pair, says no-service too in the dead hours', () => {
    const governmentCenter = stationKeyNamed(db, 'Government Center', RAIL);
    assert.deepEqual(expectOk(repo.rides(BRICKELL, governmentCenter, WED_0200)), { kind: 'no-service' });
    assert.deepEqual(expectOk(repo.rides(governmentCenter, BRICKELL, WED_0200)), { kind: 'no-service' });
  });

  test('MIA -> Brickell (Metrorail), Sat 21:00 -> needs-transfer: only the shuttle runs', () => {
    const window = windowFrom(nyEpoch('2026-10-03T21:00-04:00'), 60 * MINUTES);
    const departures = expectOk(repo.departures(MIA, window));
    assert.ok(departures.kind === 'departures' && departures.departures.length > 0, 'trains do leave MIA on Saturday night');
    assert.ok(departures.kind === 'departures' && departures.departures.every((d) => d.destName === 'Earlington Heights'));
    assert.deepEqual(expectOk(repo.rides(MIA, BRICKELL, window)), { kind: 'needs-transfer' });
    assert.deepEqual(expectOk(repo.tripRides(MIA, BRICKELL, window)), { kind: 'needs-transfer' });
  });

  test('Knight Center -> College North: the 17-min Omni loop a 4-min direct Brickell ride beats is dropped', () => {
    const { raw, trip } = knightCenterToCollegeNorth(WED_0800_MOVER);
    const omni = raw.filter((r) => r.lineId === 'MM_OMNI');
    assert.equal(raw.length, 24, 'repo.rides lists 24 rides in 30 min');
    assert.equal(omni.length, 6);
    for (const loop of omni) {
      assert.ok(loop.viaBlockLink && rideMinutes(loop) === 17, 'each Omni ride is a 17-min block-hop loop');
      assert.ok(raw.some((d) => d.lineId === 'MM_BRICKELL' && !d.viaBlockLink && d.depEpoch === loop.depEpoch && rideMinutes(d) === 4));
    }
    assert.equal(trip.length, 18, 'the trip filter leaves 18');
    assert.ok(trip.every((r) => r.lineId !== 'MM_OMNI'), 'no Omni loop survives');
  });

  test('Knight Center -> College North: Inner Loop block-link rides nothing beats are kept', () => {
    const { raw, trip } = knightCenterToCollegeNorth(WED_0800_MOVER);
    const inner = raw.filter((r) => r.lineId === 'MM_INNER' && r.viaBlockLink);
    assert.equal(inner.length, 12);
    assert.ok(inner.every((r) => rideMinutes(r) === 5.5), 'each Inner Loop ride takes 5.5 min');
    assert.deepEqual(
      trip.filter((r) => r.lineId === 'MM_INNER'),
      inner,
    );
    assert.deepEqual(
      trip.filter((r) => r.lineId === 'MM_BRICKELL'),
      raw.filter((r) => r.lineId === 'MM_BRICKELL'),
    );
  });
});
