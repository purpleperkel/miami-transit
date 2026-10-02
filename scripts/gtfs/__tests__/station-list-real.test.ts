import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { windowFrom } from '../../../src/domain/gtfs/service-day';
import { NEXT_DEPARTURE_HORIZON_S, stationList, type StationRowModel, type StationSection } from '../../../src/ui/stations/station-list';
import { expectOk } from './expect-result';
import { nyEpoch, openRealRepo, openRealScheduleDb } from './real-schedule';

/**
 * M6.5 + R7: the Stations tab's selector (src/ui/stations/station-list.ts — the module the tab runs)
 * on the REAL committed schedule DB, in place, on Wednesday 2026-09-30 at 08:00 New York time. The
 * line strips come from the DB's patterns; the inline next departures come from its stop_time table
 * (schedule only: the list never asks for live predictions).
 *
 * The suite runs few statements on purpose: the verify gate pipes the whole run's SQL log through
 * `grep | grep -q` under pipefail, which fails falsely once that log outgrows the pipe buffer.
 */

const db = openRealScheduleDb();
after(() => db.close());
const repo = openRealRepo(db);
const WED_0800 = nyEpoch('2026-09-30T08:00-04:00');
const list = stationList(repo, WED_0800);

/** The section of `title`. */
function section(title: string): StationSection {
  const found = list.sections.find((candidate) => candidate.title === title);
  assert.ok(found !== undefined, `the list has a ${title} section`);
  assert.ok(found.rows.length > 0);
  return found;
}

/** The trunk rows: the Metrorail stations both Green and Orange trains stop at. */
function trunkRows(): readonly StationRowModel[] {
  const rows = section('Metrorail').rows.filter((row) => row.lines.includes('GREEN') && row.lines.includes('ORANGE'));
  assert.equal(rows.length, 15, 'Earlington Heights to Dadeland South: 15 shared stations');
  assert.ok(rows.some((row) => row.stationKey === 'rail:government-ctr'));
  return rows;
}

/**
 * Each station's departing directions in the DB's own patterns (a pattern's last stop is not a
 * departure), read in ONE statement: the suite keeps its SQL log small (see the R7 suite's note).
 */
const DEPARTING: ReadonlyMap<string, readonly number[]> = (() => {
  const rows = db.all<{ station_key: string; direction_id: number }>(
    `SELECT DISTINCT x.station_key, p.direction_id FROM pattern_stop AS ps JOIN pattern AS p ON p.pattern_idx = ps.pattern_idx
     JOIN stop AS s ON s.stop_idx = ps.stop_idx JOIN station AS x ON x.station_idx = s.station_idx
     WHERE ps.seq < p.stop_count - 1 ORDER BY x.station_key, p.direction_id`,
  );
  assert.ok(rows.length >= 44, 'the DB lists departing directions');
  const byStation = new Map<string, number[]>();
  rows.forEach((row) => byStation.set(row.station_key, [...(byStation.get(row.station_key) ?? []), row.direction_id]));
  assert.equal(byStation.size, 44, 'every station has a departing direction');
  return byStation;
})();

/** The station's departing directions. */
function departingDirections(stationKey: string): readonly number[] {
  const directions = DEPARTING.get(stationKey);
  assert.ok(directions !== undefined && directions.length > 0, `${stationKey} has departures`);
  assert.ok(directions.every((d) => d === 0 || d === 1), 'GTFS directions are 0 or 1');
  return directions;
}

describe('the Stations list on the real schedule DB: sections and strips (M6.5)', () => {
  test('Metrorail section lists 23 stations', () => {
    assert.deepEqual(list.sections.map((s) => s.title), ['Metrorail', 'Metromover']);
    assert.equal(section('Metrorail').rows.length, 23);
    assert.ok(section('Metrorail').rows.every((row) => row.mode === 'rail'));
    assert.equal(section('Metromover').rows.length, 21);
    assert.equal(list.gap, null, 'the timetable covers Wed 08:00');
  });

  test('every trunk row has 2 strip segments', () => {
    for (const row of trunkRows()) {
      assert.deepEqual(row.lines, ['GREEN', 'ORANGE'], `${row.name} shows Green then Orange`);
    }
    const greenOnly = section('Metrorail').rows.filter((row) => !row.lines.includes('ORANGE'));
    assert.equal(greenOnly.length, 7, 'Palmetto to Brownsville are Green alone');
    assert.ok(greenOnly.every((row) => row.lines.length === 1 && row.lines[0] === 'GREEN'));
  });

  test('Airport row has 1 strip segment', () => {
    const airport = section('Metrorail').rows.find((row) => row.stationKey === 'rail:miami-international-airport');
    assert.ok(airport !== undefined, 'the Airport is listed');
    assert.deepEqual(airport.lines, ['ORANGE']);
  });
});

describe('the Stations list on the real schedule DB: inline next departures (R7)', () => {
  test('every trunk row has the next scheduled departure per direction at Wed 08:00', () => {
    const trunk = trunkRows();
    // Dadeland South ends every southbound train, so only its northbound direction departs there.
    assert.deepEqual(trunk.filter((row) => departingDirections(row.stationKey).length !== 2).map((row) => row.stationKey), ['rail:dadeland-south']);
    for (const row of trunk) {
      assert.deepEqual(row.next.map((next) => next.directionId), departingDirections(row.stationKey), `${row.name}: one next departure per departing direction`);
      assert.ok(row.next.every((next) => next.headsign.length > 0 && next.epoch >= WED_0800 && next.epoch - WED_0800 <= 15 * 60), `${row.name}: trains every 10-15 min at 08:00`);
    }
    // Each is the timetable's own next departure in its direction (M3.3's departures query, stop_time).
    for (const key of ['rail:government-ctr', 'rail:brickell', 'rail:dadeland-south']) {
      const scheduled = expectOk(repo.departures(key, windowFrom(WED_0800, NEXT_DEPARTURE_HORIZON_S)));
      const row = trunk.find((candidate) => candidate.stationKey === key);
      assert.ok(scheduled.kind === 'departures' && row !== undefined);
      const earliest = row.next.map((next) => scheduled.departures.find((d) => d.directionId === next.directionId));
      assert.deepEqual(row.next.map((next) => [next.epoch, next.headsign, next.lineId]), earliest.map((d) => [d?.epoch, d?.destName, d?.lineId]), key);
    }
  });

  test('a Green-only station and a Mover terminus list what departs there', () => {
    const palmetto = section('Metrorail').rows.find((row) => row.stationKey === 'rail:palmetto');
    assert.deepEqual(palmetto?.next.map((next) => next.headsign), ['Dadeland South']);
    const moverGc = section('Metromover').rows.find((row) => row.stationKey === 'mover:government-center');
    assert.deepEqual(moverGc?.lines, ['MM_INNER', 'MM_OMNI', 'MM_BRICKELL']);
    assert.equal(moverGc?.next.length, departingDirections('mover:government-center').length);
  });

  test('past the last service day the rows keep their strips and the list says the timetable has run out', () => {
    const expired = stationList(repo, nyEpoch('2027-06-01T08:00-04:00'));
    assert.equal(expired.gap?.kind, 'expired');
    assert.ok(expired.sections.every((s) => s.rows.every((row) => row.next.length === 0 && row.lines.length > 0)));
  });
});
