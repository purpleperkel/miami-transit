import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { DeparturesOutcome } from '../../../src/data/schedule-repo';
import { type TimeWindow, windowFrom } from '../../../src/domain/gtfs/service-day';
import type { Departure } from '../../../src/domain/schedule/departures';
import { expectErr, expectOk } from './expect-result';
import { nyEpoch, openRealRepo, openRealScheduleDb, stationKeyNamed } from './real-schedule';

/**
 * M3.3: scheduled departures through ScheduleRepo, on the REAL committed schedule DB.
 * 2026-09-30 is a Wednesday; 2026-10-02/03 are Friday/Saturday.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

const RAIL = 0;
const GOVERNMENT_CENTER = stationKeyNamed(db, 'Government Center', RAIL);
const DADELAND_SOUTH = stationKeyNamed(db, 'Dadeland South', RAIL);
const MINUTES = 60;

function departuresAt(stationKey: string, window: TimeWindow): { outcome: DeparturesOutcome; list: readonly Departure[] } {
  const outcome = expectOk(repo.departures(stationKey, window));
  assert.equal(outcome.kind, 'departures', `expected departures at ${stationKey}, got ${JSON.stringify(outcome)}`);
  const list = outcome.kind === 'departures' ? outcome.departures : [];
  assert.ok(list.every((d) => d.epoch >= window.fromEpoch && d.epoch <= window.toEpoch), 'every departure is inside the window');
  return { outcome, list };
}

/** Raw DB truth: how many trains END at the station during the service day (they arrive, never depart). */
function terminatingArrivals(stationKey: string, date: number): number {
  const row = db.get<{ n: number }>(
    `SELECT count(*) AS n FROM station AS sta
     JOIN stop AS s ON s.station_idx = sta.station_idx
     JOIN stop_time AS st ON st.stop_idx = s.stop_idx
     JOIN trip AS t ON t.trip_idx = st.trip_idx
     JOIN pattern AS p ON p.pattern_idx = t.pattern_idx
     JOIN service_day_active AS a ON a.service_idx = t.service_idx AND a.date = :date
     WHERE sta.station_key = :station_key AND st.seq = p.stop_count - 1`,
    { station_key: stationKey, date },
  );
  assert.ok(row !== null, 'count(*) returns a row');
  assert.ok(Number.isInteger(row.n));
  return row.n;
}

describe('ScheduleRepo departures on the real schedule DB (M3.3)', () => {
  test('Government Center (rail:government-ctr, not the Mover station), Wed 08:00 -> >= 4 departures per direction by 08:30', () => {
    assert.equal(GOVERNMENT_CENTER, 'rail:government-ctr');
    const window = windowFrom(nyEpoch('2026-09-30T08:00-04:00'), 30 * MINUTES);
    const { outcome, list } = departuresAt(GOVERNMENT_CENTER, window);
    assert.deepEqual(outcome.kind === 'departures' ? outcome.serviceDates : [], [20260930]);
    for (const direction of [0, 1]) {
      const count = list.filter((d) => d.directionId === direction).length;
      assert.ok(count >= 4, `direction ${direction}: ${count} departures between 08:00 and 08:30, want >= 4`);
    }
    assert.ok(list.every((d) => d.lineId === 'GREEN' || d.lineId === 'ORANGE'), 'only Metrorail trains — never the Mover station');
  });

  test('Dadeland South never lists a departure to Dadeland South: terminating trains are arrivals only', () => {
    const window = windowFrom(nyEpoch('2026-09-30T04:00-04:00'), 24 * 60 * MINUTES);
    const { list } = departuresAt(DADELAND_SOUTH, window);
    assert.ok(list.length > 50, `a weekday has many departures from Dadeland South, got ${list.length}`);
    assert.ok(list.every((d) => d.destStationKey !== DADELAND_SOUTH), 'no departure is "to Dadeland South"');
    assert.ok(list.every((d) => d.directionId === 1), 'every departure from the southern terminus heads north');
    // Not vacuous: the same day really has trains ending at Dadeland South, and none were listed.
    assert.ok(terminatingArrivals(DADELAND_SOUTH, 20260930) > 50, 'trains do terminate at Dadeland South on 20260930');
  });

  test('24:xx trips: Sat 00:00-00:30 at Government Center lists Friday-service trains (dep_s >= 86400) at base_epoch + dep_s', () => {
    const saturday = nyEpoch('2026-10-03T00:00-04:00');
    const friday = db.get<{ base_epoch: number }>('SELECT base_epoch FROM service_day WHERE date = ?', [20261002]);
    assert.ok(friday !== null, 'Friday 20261002 is a service day');
    const { list } = departuresAt(GOVERNMENT_CENTER, windowFrom(saturday, 30 * MINUTES));
    const late = list.filter((d) => d.serviceDate === 20261002);
    assert.ok(late.length > 0, 'Friday trains still depart Government Center after midnight');
    assert.ok(late.every((d) => d.depS >= 86_400 && d.epoch === friday.base_epoch + d.depS && d.epoch >= saturday));
  });

  test('departures come earliest first, each at its service day base_epoch + dep_s', () => {
    const { list } = departuresAt(GOVERNMENT_CENTER, windowFrom(nyEpoch('2026-09-30T17:00-04:00'), 60 * MINUTES));
    assert.ok(list.length >= 8, `a weekday rush hour has >= 8 departures, got ${list.length}`);
    assert.ok(list.every((d, i) => i === 0 || list[i - 1]!.epoch <= d.epoch), 'sorted by departure time');
    assert.ok(list.every((d) => d.serviceDate === 20260930 && d.epoch === 1790740800 + d.depS));
  });

  test('an unknown station key -> Err naming it; after Dec 31 -> the expired calendar', () => {
    const window = windowFrom(nyEpoch('2026-09-30T08:00-04:00'), 30 * MINUTES);
    assert.deepEqual(expectErr(repo.departures('rail:nowhere', window)), { kind: 'unknown-station', stationKey: 'rail:nowhere' });
    const expired = expectOk(repo.departures(GOVERNMENT_CENTER, windowFrom(nyEpoch('2027-01-02T08:00-05:00'), 30 * MINUTES)));
    assert.deepEqual(expired, { kind: 'expired', lastDate: 20261231 });
  });
});
