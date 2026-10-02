import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import type { ModeStatusOutcome } from '../../../src/data/schedule-repo';
import { STARTING_SOON_S } from '../../../src/domain/schedule/mode-status';
import { formatClockFromServiceSec } from '../../../src/ui/format';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * mfix4 on the REAL committed schedule DB, in place: ScheduleRepo.modeStatusAt — is rail running, is
 * the Mover? — at the instants behind Jamie's 2026-10-01 23:03 report ("Not seeing any metro move cars").
 * Every expected time is read from the DB here (the first trip of a mode on a service day, by SQL), so
 * the cases pin the timetable's own numbers, never a guess.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const MODE_CODE = { rail: 0, mover: 1 } as const;

type Statuses = Extract<ModeStatusOutcome, { kind: 'mode-status' }>;

/** The repo's outcome at a New York instant, which must be a mode status (inside the calendar). */
function statusAt(iso: string): Statuses {
  const outcome = repo.modeStatusAt(nyEpoch(iso));
  assert.equal(outcome.kind, 'mode-status', `${iso} lies inside the bundled calendar`);
  assert.ok(outcome.kind === 'mode-status');
  return outcome;
}

/** A mode's first trip on a service day, from SQL: its start_s and the instant it leaves. */
function firstTrip(date: number, mode: keyof typeof MODE_CODE): { readonly startS: number; readonly epoch: number } {
  const row = db.get<{ start_s: number | null; base_epoch: number }>(
    `SELECT min(t.start_s) AS start_s, sd.base_epoch
     FROM trip AS t JOIN pattern AS p USING (pattern_idx) JOIN line AS l USING (line_id)
     JOIN service_day_active AS a ON a.service_idx = t.service_idx JOIN service_day AS sd ON sd.date = a.date
     WHERE a.date = :date AND l.mode = :mode`,
    { date, mode: MODE_CODE[mode] },
  );
  assert.ok(row !== null && row.start_s !== null, `${mode} runs on ${date}`);
  assert.ok(Number.isSafeInteger(row.base_epoch), `${date} has a base epoch`);
  return { startS: row.start_s, epoch: row.base_epoch + row.start_s };
}

/** How many trips of `mode` are in progress at `epoch` on service day `date`, from SQL. */
function inProgress(date: number, mode: keyof typeof MODE_CODE, epoch: number): number {
  const row = db.get<{ n: number }>(
    `SELECT count(*) AS n
     FROM trip AS t JOIN pattern AS p USING (pattern_idx) JOIN line AS l USING (line_id)
     JOIN service_day_active AS a ON a.service_idx = t.service_idx JOIN service_day AS sd ON sd.date = a.date
     WHERE a.date = :date AND l.mode = :mode AND sd.base_epoch + t.start_s <= :epoch AND sd.base_epoch + t.end_s >= :epoch`,
    { date, mode: MODE_CODE[mode], epoch },
  );
  assert.ok(row !== null && Number.isInteger(row.n), 'the count is read');
  assert.ok(row.n >= 0);
  return row.n;
}

describe('which modes run at Jamie\'s 23:03 report (mfix4, real DB)', () => {
  test('thu 23:03 the mover is closed until its first friday trip', () => {
    const first = firstTrip(20261002, 'mover');
    // The DB's own first Friday Mover: 19800 s = 5:30 AM, as the county's "5:30 a.m. to 10 p.m." says.
    assert.equal(first.startS, 19_800);
    assert.equal(formatClockFromServiceSec(first.startS), '5:30 AM');
    assert.equal(inProgress(20261001, 'mover', nyEpoch('2026-10-01T23:03-04:00')), 0, 'premise: no Mover trip runs at 23:03');
    const { mover } = statusAt('2026-10-01T23:03-04:00');
    assert.deepEqual(mover, { kind: 'closed', nextStart: { epoch: first.epoch, serviceDate: 20261002, serviceSec: first.startS } });
  });

  test('thu 23:03 rail is running', () => {
    assert.ok(inProgress(20261001, 'rail', nyEpoch('2026-10-01T23:03-04:00')) > 0, 'premise: Thursday rail trips run at 23:03');
    assert.deepEqual(statusAt('2026-10-01T23:03-04:00').rail, { kind: 'running' });
  });

  test('thu 12:00 rail and the mover are both running', () => {
    const noon = statusAt('2026-10-01T12:00-04:00');
    assert.deepEqual(noon.rail, { kind: 'running' });
    assert.deepEqual(noon.mover, { kind: 'running' });
  });
});

describe('closed lines and data gaps (mfix4, real DB)', () => {
  test('fri 02:00 rail is closed in its night gap until its first friday trip', () => {
    const first = firstTrip(20261002, 'rail');
    // The DB's own first Friday train: 18000 s = 5:00 AM. Thursday's last ran out at 25:04 (01:04).
    assert.equal(first.startS, 18_000);
    assert.equal(inProgress(20261001, 'rail', nyEpoch('2026-10-02T02:00-04:00')), 0, 'premise: Thursday rail has run out by 02:00');
    const { rail } = statusAt('2026-10-02T02:00-04:00');
    assert.deepEqual(rail, { kind: 'closed', nextStart: { epoch: first.epoch, serviceDate: 20261002, serviceSec: first.startS } });
  });

  test('a first trip inside the starting soon window counts as running', () => {
    const first = firstTrip(20261002, 'mover');
    const fiveBefore = repo.modeStatusAt(first.epoch - 300);
    assert.ok(300 <= STARTING_SOON_S, 'five minutes before is inside the window');
    assert.ok(fiveBefore.kind === 'mode-status' && fiveBefore.mover.kind === 'running', 'the Mover starting in 5 min is running');
    const outside = repo.modeStatusAt(first.epoch - STARTING_SOON_S - 60);
    assert.ok(outside.kind === 'mode-status');
    assert.deepEqual(outside.mover, { kind: 'closed', nextStart: { epoch: first.epoch, serviceDate: 20261002, serviceSec: first.startS } });
  });

  test('past the bundled rail timetable rail has no timetable rather than closed', () => {
    const last = db.get<{ last_date: number }>(
      `SELECT max(a.date) AS last_date
       FROM service_day_active AS a JOIN trip AS t ON t.service_idx = a.service_idx
       JOIN pattern AS p USING (pattern_idx) JOIN line AS l USING (line_id) WHERE l.mode = 0`,
    );
    assert.equal(last?.last_date, 20261122, 'the bundled rail timetable ends Sun 2026-11-22');
    const monday = statusAt('2026-11-23T12:00-05:00');
    assert.deepEqual(monday.rail, { kind: 'no-timetable' });
    assert.deepEqual(monday.mover, { kind: 'running' }, 'the Mover timetable runs on to 2026-12-31');
  });

  test('outside the bundled calendar the outcome is the calendar gap', () => {
    const outcome = repo.modeStatusAt(nyEpoch('2027-01-05T12:00-05:00'));
    assert.equal(outcome.kind, 'expired');
    assert.ok(outcome.kind === 'expired' && outcome.lastDate === 20261231);
  });
});
