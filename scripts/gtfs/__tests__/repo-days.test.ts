import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { instantWindow, type ServiceDayResolution } from '../../../src/domain/gtfs/service-day';
import { nyEpoch, openRealRepo, openRealScheduleDb, readRealManifest } from './real-schedule';

/**
 * M3.2: service-day resolution through ScheduleRepo, on the REAL committed schedule DB.
 * 2026-09-30 is a Wednesday; 2026-10-02/03 are Friday/Saturday; the Mover's last service day is
 * 2026-12-31; the calendar starts 2023-11-13.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);

function activeDates(resolution: ServiceDayResolution): number[] {
  assert.equal(resolution.kind, 'active', `expected running service days, got ${JSON.stringify(resolution)}`);
  assert.ok(resolution.kind === 'active' && resolution.days.length > 0);
  return resolution.days.map((day) => day.date);
}

describe('ScheduleRepo service days on the real schedule DB (M3.2)', () => {
  test('opens the real DB: schema 1, America/New_York, and the manifest feed hash', () => {
    assert.equal(repo.meta.schemaVersion, 1);
    assert.equal(repo.meta.timeZone, 'America/New_York');
    assert.equal(repo.meta.feedSha256, readRealManifest().feedSha256);
  });

  test('the test clock is absolute: 2026-09-30T00:00-04:00 is the DB base_epoch of 20260930 (1790740800)', () => {
    const row = db.get<{ base_epoch: number }>('SELECT base_epoch FROM service_day WHERE date = ?', [20260930]);
    assert.equal(nyEpoch('2026-09-30T00:00-04:00'), 1790740800);
    assert.equal(row?.base_epoch, 1790740800);
  });

  test('Wed 12:00 (2026-09-30) resolves to exactly [20260930]', () => {
    const resolution = repo.serviceDays(instantWindow(nyEpoch('2026-09-30T12:00-04:00')));
    assert.deepEqual(activeDates(resolution), [20260930]);
  });

  test('Sat 00:30 (2026-10-03) includes Friday 20261002, whose late trains still run, then Saturday 20261003', () => {
    const at = nyEpoch('2026-10-03T00:30-04:00');
    assert.deepEqual(activeDates(repo.serviceDays(instantWindow(at))), [20261002, 20261003]);
    // Not a formality: a Friday-service trip really is still running at Sat 00:30.
    const running = db.get<{ n: number }>(
      `SELECT count(*) AS n FROM trip t
       JOIN service_day_active a ON a.service_idx = t.service_idx AND a.date = 20261002
       JOIN service_day d ON d.date = a.date
       WHERE d.base_epoch + t.start_s <= :at AND d.base_epoch + t.end_s > :at`,
      { at },
    );
    assert.ok(running !== null && running.n > 0, 'some Friday-service train runs past Saturday 00:30');
  });

  test('an instant after Dec 31 (2027-01-01 12:00 EST) resolves to expired, naming 20261231 as the last day', () => {
    const resolution = repo.serviceDays(instantWindow(nyEpoch('2027-01-01T12:00-05:00')));
    assert.deepEqual(resolution, { kind: 'expired', lastDate: 20261231 });
    assert.equal(db.get<{ last: number }>('SELECT max(date) AS last FROM service_day')?.last, 20261231);
  });

  test('before the first service day (2023-11-12 12:00 EST) resolves to not-started', () => {
    const resolution = repo.serviceDays(instantWindow(nyEpoch('2023-11-12T12:00-05:00')));
    assert.deepEqual(resolution, { kind: 'not-started', firstDate: 20231113 });
  });

  test('DST end, Sun 2026-11-01 12:00 EST -> [20261101], counted from noon minus 12 h (1793509200), not midnight', () => {
    const resolution = repo.serviceDays(instantWindow(nyEpoch('2026-11-01T12:00-05:00')));
    assert.equal(resolution.kind, 'active');
    assert.deepEqual(resolution.kind === 'active' ? resolution.days : [], [{ date: 20261101, baseEpoch: 1793509200 }]);
    assert.notEqual(nyEpoch('2026-11-01T00:00-04:00'), 1793509200, 'local midnight (EDT) is an hour earlier');
  });
});
