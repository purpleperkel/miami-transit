import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { after, describe, test } from 'node:test';

import { MAX_DB_BYTES, verifyScheduleDb, type CheckName, type VerifyError } from '../verify-db';
import { expectErr, expectOk } from './expect-result';
import { copyDb, mutateDb, queryValue, removeDir, scratchDir, writeMiniDb } from './mini-db';

const DIR = scratchDir('verify-db');
after(() => removeDir(DIR));
const MINI_DB = writeMiniDb(DIR);

/** A private copy of the mini DB with `sql` applied — one injected defect per test. */
function damaged(name: string, sql: string): string {
  const path = copyDb(MINI_DB, DIR, `${name}.db`);
  mutateDb(path, sql);
  assert.notEqual(path, MINI_DB);
  assert.notDeepEqual(readFileSync(path), readFileSync(MINI_DB), 'the defect changed the file');
  return path;
}

/** verify-db on `path` must fail, on exactly `check`, with the check named in the message. */
function failsOn(path: string, check: CheckName): VerifyError {
  const error = expectErr(verifyScheduleDb(path));
  assert.equal(error.check, check, error.message);
  assert.ok(error.message.startsWith(`verify-db: FAIL [${check}]`), error.message);
  return error;
}

describe('verifyScheduleDb: the plan’s acceptance cases', () => {
  test('the mini-feed DB passes every check', () => {
    const summary = expectOk(verifyScheduleDb(MINI_DB));
    assert.equal(summary.checks.length, 13);
    assert.equal(summary.bytes, statSync(MINI_DB).size);
  });

  test('every trip has ≥ 2 stop times: a trip cut to 1 stop time -> Err naming the check', () => {
    const path = damaged('one-stop', 'DELETE FROM stop_time WHERE trip_idx = 0 AND seq > 0');
    const error = failsOn(path, 'every trip has ≥ 2 stop times');
    assert.match(error.message, /trip \S+ has 1 stop time\(s\)/);
  });

  test('every trip has ≥ 2 stop times: an emptied stop_time table -> Err naming the stop-time check', () => {
    const path = damaged('no-stop-times', 'DELETE FROM stop_time');
    assert.equal(queryValue(path, 'SELECT count(*) FROM stop_time'), 0);
    assert.match(failsOn(path, 'every trip has ≥ 2 stop times').message, /has 0 stop time\(s\)/);
  });

  test('times are monotone: a departure before its own arrival -> Err', () => {
    const path = damaged('dep-before-arr', 'UPDATE stop_time SET dep_s = arr_s - 60 WHERE trip_idx = 0 AND seq = 1');
    assert.match(failsOn(path, 'times are monotone').message, /stop 1 departs \(\d+ s\) before it arrives/);
  });

  test('times are monotone: an arrival before the previous stop’s departure -> Err', () => {
    const path = damaged('backwards', 'UPDATE stop_time SET arr_s = 0, dep_s = 0 WHERE trip_idx = 0 AND seq = 1');
    assert.match(failsOn(path, 'times are monotone').message, /stop 1 arrives \(0 s\) before it left the previous stop/);
  });

  test('every line is in the catalog: a pattern on a line the catalog lacks -> Err', () => {
    const path = damaged('unknown-line', "UPDATE pattern SET line_id = 'PURPLE' WHERE pattern_idx = 0");
    assert.match(failsOn(path, 'every line is in the catalog').message, /pattern 0 is on line PURPLE, which the catalog lacks/);
  });

  test('every line is in the catalog: a renamed line row -> Err', () => {
    const path = damaged('renamed-line', "UPDATE line SET name = 'Lime Line' WHERE line_id = 'GREEN'");
    assert.match(failsOn(path, 'every line is in the catalog').message, /GREEN\/0\/Lime Line/);
  });

  test(`size < 6 MB: a DB padded past ${MAX_DB_BYTES} bytes -> Err`, () => {
    const path = damaged('padded', `CREATE TABLE padding(b BLOB); INSERT INTO padding VALUES (zeroblob(${MAX_DB_BYTES}));`);
    assert.ok(statSync(path).size >= MAX_DB_BYTES);
    assert.match(failsOn(path, 'size < 6 MB').message, /\d+ bytes; the limit is 6000000/);
  });
});

describe('verifyScheduleDb: damage', () => {
  test('a corrupted DB -> Err naming the check: overwritten pages fail integrity_check', () => {
    const path = copyDb(MINI_DB, DIR, 'corrupt-pages.db');
    const fd = openSync(path, 'r+');
    const garbage = Buffer.alloc(4096 * 3, 0xa5);
    assert.equal(writeSync(fd, garbage, 0, garbage.length, 4096 * 2), garbage.length);
    closeSync(fd);
    assert.match(failsOn(path, 'integrity_check').message, /\S/);
  });

  test('a corrupted DB -> Err naming the check: a dropped table fails the tables check', () => {
    const path = damaged('dropped-table', 'DROP TABLE transfer');
    assert.match(failsOn(path, 'tables').message, /table transfer is missing/);
  });

  test('a dangling index (next_trip_idx naming no trip) fails the references check', () => {
    const path = damaged('dangling', 'UPDATE trip SET next_trip_idx = 999 WHERE trip_idx = 0');
    assert.match(failsOn(path, 'references').message, /trip\.next_trip_idx = 999 names no trip\.trip_idx/);
  });
});

describe('verifyScheduleDb: file format and geometry', () => {
  test('a stamped schema version other than 1 -> Err', () => {
    const path = damaged('version', 'PRAGMA user_version = 2');
    assert.match(failsOn(path, 'user_version = 1').message, /user_version is 2, want 1/);
  });

  test('a WAL-mode file -> Err: the bundled DB must be one self-contained file', () => {
    const path = damaged('wal', 'PRAGMA journal_mode = WAL');
    assert.match(failsOn(path, 'journal_mode = delete').message, /journal_mode is wal/);
  });

  test('a trip that leaves its pattern -> Err', () => {
    const path = damaged('off-pattern', 'UPDATE stop_time SET stop_idx = (SELECT max(stop_idx) FROM stop) WHERE trip_idx = 0 AND seq = 0');
    assert.match(failsOn(path, 'trips follow their pattern').message, /stops somewhere its pattern does not/);
  });

  test('a pattern stop off the end of its shape -> Err', () => {
    const path = damaged('off-shape', 'UPDATE pattern_stop SET dist_m = 1e9 WHERE pattern_idx = 0 AND seq = 1');
    assert.match(failsOn(path, 'stop distances').message, /pattern 0 stop 1: distance is off its shape or goes backwards/);
  });

  test('a shape extended more than 150 m at either end -> Err naming that end (the M2.11 ruling)', () => {
    const start = damaged('over-extended-start', 'UPDATE shape SET extended_start_m = 150.5 WHERE shape_idx = 0');
    assert.match(failsOn(start, 'shape extension ≤ 150 m per end').message, /extended 150\.5 m at its start \(max 150 m per end\)/);
    const end = damaged('over-extended-end', 'UPDATE shape SET extended_end_m = 151 WHERE shape_idx = 0');
    assert.match(failsOn(end, 'shape extension ≤ 150 m per end').message, /extended 151\.0 m at its end/);
  });

  test('two ends of 140 m each pass: the limit is per end, not on their sum', () => {
    const path = damaged('both-ends-140', 'UPDATE shape SET extended_start_m = 140, extended_end_m = 140 WHERE shape_idx = 0');
    assert.equal(expectOk(verifyScheduleDb(path)).checks.length, 13);
    assert.equal(queryValue(path, 'SELECT extended_start_m + extended_end_m FROM shape WHERE shape_idx = 0'), 280);
  });

  test('a missing file -> Err naming the open step', () => {
    const error = expectErr(verifyScheduleDb(`${DIR}/no-such.db`));
    assert.equal(error.check, 'open');
  });
});
