import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvariantError } from '../../../src/lib/invariant';
import { MINI_FEED_FACTS as F, miniFeedZip } from '../__fixtures__/mini-feed';
import { baseEpoch, expandCalendar, type ServiceCalendar, type ServiceDay } from '../calendar';
import { loadFeed } from '../load-feed';
import { unzipFeed } from '../unzip-feed';
import { expectErr, expectOk } from './expect-result';

function miniCalendar(): ServiceCalendar {
  const feed = expectOk(loadFeed(expectOk(unzipFeed(miniFeedZip()))));
  assert.equal(feed.calendar.length, 4, 'rail weekday/Saturday/Sunday and Mover weekday');
  assert.equal(feed.calendarDates.length, 2, 'the Labor Day swap');
  return expectOk(expandCalendar(feed.calendar, feed.calendarDates));
}

const CALENDAR = miniCalendar();

function day(date: number): ServiceDay {
  const found = CALENDAR.days.find((candidate) => candidate.date === date);
  assert.ok(found !== undefined, `${date} is a service day`);
  assert.equal(found.date, date);
  return found;
}

/** The wall-clock time in New York at an epoch second, as "YYYY-MM-DD HH:MM". */
function newYorkTime(epochSeconds: number): string {
  assert.ok(Number.isInteger(epochSeconds), 'an epoch second');
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone: F.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(epochSeconds * 1000);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  return text;
}

describe('baseEpoch: GTFS noon minus 12 h, computed with Intl on the Mac', () => {
  test('baseEpoch(20260930) = 1790740800 (EDT: noon is 16:00Z, minus 12 h)', () => {
    assert.equal(baseEpoch(20260930), 1790740800);
    assert.equal(newYorkTime(1790740800), '2026-09-30 00:00', 'on an ordinary day it is local midnight');
  });

  test('baseEpoch(20261101) = 1793509200 on the DST-end day: noon minus 12 h, not local midnight (1793505600)', () => {
    assert.equal(baseEpoch(F.dstEndDate), 1793509200);
    assert.notEqual(baseEpoch(F.dstEndDate), 1793505600);
    assert.equal(newYorkTime(1793505600), '2026-11-01 00:00', 'local midnight is an hour earlier, still in EDT');
    assert.equal(newYorkTime(1793509200 + 12 * 3600), '2026-11-01 12:00', 'base + 12 h is noon');
  });

  test('baseEpoch(20260308) = 1772942400 on the DST-start day: 23:00 the evening before', () => {
    assert.equal(baseEpoch(20260308), 1772942400);
    assert.equal(newYorkTime(1772942400), '2026-03-07 23:00');
  });

  test('a departure at 25:04:00 on 20260930 is 01:04 on 2026-10-01', () => {
    assert.equal(newYorkTime(baseEpoch(20260930) + 90240), '2026-10-01 01:04');
    assert.equal(baseEpoch(20261001) - baseEpoch(20260930), 86400);
  });

  test('a date that is not a real YYYYMMDD is a broken contract, not a value', () => {
    assert.throws(() => baseEpoch(20260931), InvariantError);
    assert.throws(() => baseEpoch(2026930), InvariantError);
  });
});

describe('expandCalendar on the mini feed', () => {
  test('Labor Day 20260907 swaps the weekday service for the Sunday service', () => {
    assert.equal(F.laborDay, 20260907);
    assert.deepEqual(day(F.laborDay).serviceIds, [F.weekdayMoverService, F.sundayRailService]);
    assert.ok(!day(F.laborDay).serviceIds.includes(F.weekdayRailService), 'weekday rail service 6 is removed');
    assert.deepEqual(day(20260914).serviceIds, [F.weekdayMoverService, F.weekdayRailService], 'the next Monday is an ordinary weekday');
  });

  test('one service day per date, from the first service date to the last', () => {
    const dates = CALENDAR.days.map((candidate) => candidate.date);
    assert.deepEqual([dates[0], dates[dates.length - 1], dates.length], [20231113, 20261231, 1145]);
    assert.ok(CALENDAR.days.every((candidate, i) => i === 0 || candidate.baseEpoch > (CALENDAR.days[i - 1]?.baseEpoch ?? Infinity)));
    assert.deepEqual(CALENDAR.serviceIds, ['11', '6', '7', '8']);
  });

  test('the DST-end date 20261101 runs Sunday service from base epoch 1793509200', () => {
    assert.deepEqual(day(F.dstEndDate), { date: 20261101, baseEpoch: 1793509200, serviceIds: [F.sundayRailService] });
    // The repeated 1 AM hour falls between the 10-31 and 11-01 bases (04:00Z, then 05:00Z).
    assert.deepEqual([day(F.dstEndDate).baseEpoch - day(20261031).baseEpoch, day(20261102).baseEpoch - day(F.dstEndDate).baseEpoch], [90000, 86400]);
  });

  test('rail service stops after 20261122; the Mover runs to 20261231', () => {
    assert.deepEqual(day(20261122).serviceIds, [F.sundayRailService]);
    assert.deepEqual([day(20261123).serviceIds, day(20261231).serviceIds], [[F.weekdayMoverService], [F.weekdayMoverService]]);
  });

  test('a service that ends before it starts -> Err', () => {
    const row = { service_id: 'X', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: 20261201, end_date: 20261101 };
    const error = expectErr(expandCalendar([row], []));
    assert.equal(error.kind, 'calendar');
    assert.match(error.message, /service X ends \(20261101\) before it starts \(20261201\)/);
  });
});
