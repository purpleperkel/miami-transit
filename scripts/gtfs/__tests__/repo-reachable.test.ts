import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { expectOk } from './expect-result';
import { openRealRepo, openRealScheduleDb, stationKeyNamed } from './real-schedule';

/**
 * Plan M7.9 on the REAL committed schedule DB (opened in place, read-only): the add-trip flow offers
 * as destinations only the stations one vehicle reaches from the origin, and excludes every other one
 * as `needs-transfer`. Station keys are looked up by name and mode, never guessed.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

const RAIL = 0;
const MOVER = 1;
const DADELAND_SOUTH = stationKeyNamed(db, 'Dadeland South', RAIL);

/** directReachable(Dadeland South), checked whole: the origin is left out and every other station lands in one half. */
function fromDadelandSouth() {
  const reach = expectOk(repo.directReachable(DADELAND_SOUTH));
  const keys = [...reach.direct.map((s) => s.stationKey), ...reach.excluded.map((e) => e.station.stationKey)];
  assert.equal(new Set(keys).size, repo.stations().length - 1, 'every station but the origin, once');
  assert.ok(!keys.includes(DADELAND_SOUTH), 'the origin is not its own destination');
  return reach;
}

describe('directReachable on the real schedule DB (M7.9)', () => {
  test('directReachable(Dadeland South) includes Government Center (Metrorail): one train, no change', () => {
    const governmentCenter = stationKeyNamed(db, 'Government Center', RAIL);
    const reach = fromDadelandSouth();
    assert.ok(reach.direct.some((s) => s.stationKey === governmentCenter), `${governmentCenter} is direct from ${DADELAND_SOUTH}`);
    assert.equal(governmentCenter, 'rail:government-ctr');
    // Every Metrorail station is on the line Dadeland South starts; no Metromover station is.
    assert.ok(reach.direct.every((s) => s.mode === 'rail'), 'only rail stations are direct from a rail terminus');
    assert.ok(reach.direct.length > 10, 'the Green/Orange trunk reaches many stations');
  });

  test('directReachable(Dadeland South) excludes Bayfront Park (Metromover) with the reason needs-transfer', () => {
    const bayfrontPark = stationKeyNamed(db, 'Bayfront Park', MOVER);
    const moverGovernmentCenter = stationKeyNamed(db, 'Government Center', MOVER);
    const reach = fromDadelandSouth();
    const excluded = new Map(reach.excluded.map((e) => [e.station.stationKey, e.reason] as const));
    assert.equal(excluded.get(bayfrontPark), 'needs-transfer');
    assert.equal(excluded.get(moverGovernmentCenter), 'needs-transfer', 'the Metromover side of Government Center needs a change too');
    assert.ok(!reach.direct.some((s) => s.stationKey === bayfrontPark), 'Bayfront Park is never offered as a direct destination');
  });

  test('a Metromover loop reaches its own stations directly, across the block hop', () => {
    const bayfrontPark = stationKeyNamed(db, 'Bayfront Park', MOVER);
    const reach = expectOk(repo.directReachable(bayfrontPark));
    assert.ok(reach.direct.some((s) => s.stationKey === stationKeyNamed(db, 'Government Center', MOVER)));
    assert.ok(reach.direct.every((s) => s.mode === 'mover'), 'no rail station is one Mover car away');
  });

  test('an unknown origin is an unknown-station error, not an empty list', () => {
    const outcome = repo.directReachable('rail:no-such-station');
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.ok ? null : outcome.error, { kind: 'unknown-station', stationKey: 'rail:no-such-station' });
  });
});
