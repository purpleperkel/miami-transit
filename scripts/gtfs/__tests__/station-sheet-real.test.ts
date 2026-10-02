import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { SHEET_HORIZON_S, SHEET_LEAD_S, stationSheet, type StationSheetModel } from '../../../src/ui/stations/station-sheet';
import { nyEpoch, openRealRepo, openRealScheduleDb, stationKeyNamed } from './real-schedule';

/**
 * M6.4: the station sheet's selector (src/ui/stations/station-sheet.ts — the module the station route
 * runs) on the REAL committed schedule DB, in place, on Wednesday 2026-09-30 at 08:00 New York time.
 * Groups are per DIRECTION (GTFS direction_id), never per terminus; a train ending at the station is
 * not a departure from it.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const WED_0800 = nyEpoch('2026-09-30T08:00-04:00');

/** The sheet of the rail station named `name` at Wed 08:00, which must have timetable groups. */
function railSheet(name: string): Extract<StationSheetModel, { kind: 'sheet' }> {
  const sheet = stationSheet(repo, stationKeyNamed(db, name, 0), WED_0800);
  assert.equal(sheet.kind, 'sheet', `${name} has a timetable at Wed 08:00`);
  assert.ok(sheet.kind === 'sheet');
  assert.deepEqual(sheet.window, { fromEpoch: WED_0800 - SHEET_LEAD_S, toEpoch: WED_0800 + SHEET_HORIZON_S });
  return sheet;
}

describe('station sheet on the real schedule DB (M6.4)', () => {
  test('Government Center trunk station gives 2 direction groups', () => {
    const sheet = railSheet('Government Center');
    assert.equal(epochIs(WED_0800), 1_790_769_600);
    assert.equal(sheet.groups.length, 2);
    assert.deepEqual(sheet.groups.map((group) => group.directionId), [0, 1]);
    for (const group of sheet.groups) {
      assert.ok(group.departures.length > 0, `direction ${group.directionId} has departures`);
      assert.ok(group.departures.every((d) => d.directionId === group.directionId), 'a group holds only its own direction');
    }
    const [south, north] = sheet.groups;
    assert.equal(south?.title, 'To Dadeland South');
    // Northbound MIXES termini and lines: Green to Palmetto and Orange to the Airport share one group.
    assert.deepEqual(new Set(north?.departures.map((d) => d.destName)), new Set(['Palmetto', 'Miami International Airport']));
    assert.deepEqual(new Set(north?.departures.map((d) => d.lineId)), new Set(['GREEN', 'ORANGE']));
    assert.equal(north?.title, 'To Palmetto or Miami International Airport');
    assert.deepEqual(sheet.lines, ['GREEN', 'ORANGE']);
  });

  test('Palmetto gives 1 direction group', () => {
    const sheet = railSheet('Palmetto');
    assert.equal(sheet.groups.length, 1);
    const [only] = sheet.groups;
    assert.equal(only?.title, 'To Dadeland South');
    // Every northbound train ENDS at Palmetto, so none of them is a departure from it.
    assert.ok(only?.departures.every((d) => d.destName === 'Dadeland South' && d.lineId === 'GREEN'));
    assert.ok((only?.departures.length ?? 0) >= 6, 'about six Green trains an hour, two hours ahead');
    assert.deepEqual(sheet.lines, ['GREEN']);
  });

  test('a station key the timetable does not have is an unknown-station sheet', () => {
    const sheet = stationSheet(repo, 'rail:nowhere', WED_0800);
    assert.deepEqual(sheet, { kind: 'unknown-station', stationKey: 'rail:nowhere' });
  });

  test('past the last service day the sheet says the timetable has run out', () => {
    const sheet = stationSheet(repo, stationKeyNamed(db, 'Government Center', 0), nyEpoch('2027-06-01T08:00-04:00'));
    assert.equal(sheet.kind, 'gap');
    assert.equal(sheet.kind === 'gap' ? sheet.gap.kind : null, 'expired');
  });
});

/** The instant as a plain number (the pinned acceptance epoch). */
function epochIs(epoch: number): number {
  assert.ok(Number.isSafeInteger(epoch));
  assert.ok(epoch > 0);
  return epoch;
}
