import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { buildReport } from '../report';
import { expectOk } from './expect-result';
import { copyDb, mutateDb, removeDir, scratchDir, writeMiniDb } from './mini-db';

const DIR = scratchDir('report');
after(() => removeDir(DIR));
const MINI_DB = writeMiniDb(DIR);

describe('buildReport (M2.20 derivation report)', () => {
  test('the mini DB passes every derivation check and prints one table row per pattern', () => {
    const report = expectOk(buildReport(MINI_DB));
    assert.equal(report.ok, true, report.lines.join('\n'));
    assert.deepEqual(report.checks.map((check) => check.ok), [true, true, true]);
    const rows = report.lines.filter((line) => /^\s+\d+\s{2,}/.test(line));
    assert.equal(rows.length, 10, 'the mini feed has 10 patterns');
    assert.ok(rows.some((row) => /GREEN\s+full\s+31009/.test(row)) && rows.some((row) => /ORANGE\s+airport_shuttle/.test(row)));
  });

  test('an ORANGE pattern without Miami International Airport -> the report fails that check', () => {
    const path = copyDb(MINI_DB, DIR, 'orange-without-mia.db');
    // Relabel a Green pattern (it never visits MIA) as Orange.
    mutateDb(path, "UPDATE pattern SET line_id = 'ORANGE' WHERE pattern_idx = (SELECT min(pattern_idx) FROM pattern WHERE line_id = 'GREEN')");
    const report = expectOk(buildReport(path));
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.map((check) => check.ok), [false, true, true]);
    assert.ok(report.lines.some((line) => /FAIL every ORANGE pattern includes Miami International Airport: pattern\(s\) \d+ lack it/.test(line)));
  });

  test('no airport shuttle -> the report fails that check', () => {
    const path = copyDb(MINI_DB, DIR, 'no-shuttle.db');
    mutateDb(path, "UPDATE pattern SET variant = 'short_turn' WHERE variant = 'airport_shuttle'");
    const report = expectOk(buildReport(path));
    assert.deepEqual(report.checks.map((check) => check.ok), [true, true, false]);
    assert.equal(report.ok, false);
  });
});
