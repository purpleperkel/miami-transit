import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { strToU8, zipSync } from 'fflate';

import type { Result } from '../../../src/lib/result';
import { MINI_FEED, MINI_FEED_FACTS as F, miniFeedEntries, type MiniFeedOverrides } from '../__fixtures__/mini-feed';
import { loadFeed, type LoadedFeed, type LoadError } from '../load-feed';
import { unzipFeed } from '../unzip-feed';
import { expectErr, expectOk } from './expect-result';

/** zip → unzip → load, exactly as the pipeline runs; `extra` adds files the fixture lacks. */
function load(overrides: MiniFeedOverrides = {}, extra: Record<string, string> = {}): Result<LoadedFeed, LoadError> {
  const entries = { ...miniFeedEntries(overrides), ...Object.fromEntries(Object.entries(extra).map(([n, t]) => [n, strToU8(t)])) };
  const files = expectOk(unzipFeed(zipSync(entries)));
  assert.ok(files['stop_times.txt'].length > 0);
  assert.equal(files['frequencies.txt'] === undefined, !('frequencies.txt' in extra));
  return loadFeed(files);
}

/** The fixture with one exact line of one file replaced (the line must exist). */
function withLine(file: keyof typeof MINI_FEED, line: string, replacement: string): MiniFeedOverrides {
  const text = MINI_FEED[file];
  assert.ok(text.includes(`${line}\r\n`), `${file} has the line ${line}`);
  const changed = text.replace(`${line}\r\n`, `${replacement}\r\n`);
  assert.notEqual(changed, text);
  return { [file]: changed };
}

const IN_SCOPE: readonly string[] = [F.railRoute, F.innerLoopRoute, F.omniBrickellRoute];

describe('loadFeed: scope', () => {
  test('excludes bus rows (and the airport mover): only routes 31009, 14457 and 14456 remain', () => {
    const feed = expectOk(load());
    assert.deepEqual(feed.routes.map((route) => route.route_id).sort(), [...IN_SCOPE].sort());
    assert.ok(feed.trips.every((trip) => IN_SCOPE.includes(trip.route_id)));
    assert.equal(feed.trips.length, 12, '7 rail + 3 Inner Loop + 2 MMO trips');
    const tripIds = new Set(feed.trips.map((trip) => trip.trip_id));
    assert.ok(!tripIds.has(F.busTrip) && !tripIds.has(F.airportMoverTrip));
    assert.ok(feed.stopTimes.every((row) => tripIds.has(row.trip_id)), 'the bus pickup_type=1 row is gone, not an Err');
    assert.ok(!feed.stops.some((stop) => ['271', '9656', '10369', '56', '10493'].includes(stop.stop_id)), 'no bus/MIA-mover stops');
    assert.ok(!feed.shapePoints.some((point) => ['212037', '123752'].includes(point.shape_id)), 'no bus/MIA-mover shapes');
    assert.deepEqual(feed.calendar.map((row) => row.service_id), ['6', '7', '8', '11'], 'bus services 1 and 3 dropped');
  });

  test('asserts the agency time zone: America/New_York loads, any other → Err', () => {
    assert.equal(expectOk(load()).timeZone, 'America/New_York');
    const chicago = MINI_FEED['agency.txt'].replace('America/New_York', 'America/Chicago');
    const error = expectErr(load({ 'agency.txt': chicago }));
    assert.deepEqual([error.kind, error.file], ['feed', 'agency.txt']);
    assert.match(error.message, /"America\/Chicago".*America\/New_York/);
  });

  test('pickup_type=1 → Err on an in-scope stop_time', () => {
    const overrides = withLine('stop_times.txt', '6283551, 5:15:00, 5:15:00,9486,1,,0,0,,1', '6283551, 5:15:00, 5:15:00,9486,1,,1,0,,1');
    const error = expectErr(load(overrides));
    assert.deepEqual([error.kind, error.file], ['feed', 'stop_times.txt']);
    assert.match(error.message, /pickup_type=1 on trip 6283551 stop_sequence 1 \(stop 9486\)/);
  });

  test('drop_off_type=1 → Err on an in-scope stop_time', () => {
    const overrides = withLine('stop_times.txt', '6283551, 5:15:00, 5:15:00,9486,1,,0,0,,1', '6283551, 5:15:00, 5:15:00,9486,1,,0,1,,1');
    const error = expectErr(load(overrides));
    assert.equal(error.kind, 'feed');
    assert.match(error.message, /drop_off_type=1 on trip 6283551/);
  });

  test('a missing in-scope route → Err naming it', () => {
    const overrides = withLine('routes.txt', '14456,DTPW305,MMO,METROMOVER OMNI/BRICKELL OUTER LOOP,,0,,008000,FFFFFF', '');
    const error = expectErr(load(overrides));
    assert.equal(error.file, 'routes.txt');
    assert.match(error.message, /no route_id 14456/);
  });
});

describe('loadFeed: values', () => {
  test('reads times as service seconds: " 5:32:00" → 19920 and "25:04:00" → 90240', () => {
    const feed = expectOk(load());
    const omniFirst = feed.stopTimes.find((row) => row.trip_id === F.omniTrip && row.stop_sequence === 1);
    const lateLast = feed.stopTimes.find((row) => row.trip_id === F.singleTrackTrips['AFTER 8PM'] && row.stop_sequence === 22);
    assert.deepEqual([omniFirst?.arrival_time, omniFirst?.departure_time], [19920, 19920]);
    assert.equal(lateLast?.arrival_time, 90240);
  });

  test('a malformed time → Err naming the file, line and column', () => {
    const overrides = withLine('stop_times.txt', '4828771, 5:32:00, 5:32:00,795,1,,0,0,,1', '4828771, 5:32:00, 5:3:00,795,1,,0,0,,1');
    const error = expectErr(load(overrides));
    assert.equal(error.kind, 'field');
    assert.ok(error.kind === 'field' && error.column === 'departure_time' && error.value === '5:3:00');
    assert.match(error.message, /^stop_times\.txt line \d+: departure_time "5:3:00" is not a GTFS time/);
  });

  test('types the columns: coordinates, dates, flags and sequences are numbers', () => {
    const feed = expectOk(load());
    const palmetto = feed.stops.find((stop) => stop.stop_id === '9486');
    assert.deepEqual([palmetto?.stop_lat, palmetto?.stop_lon], [25.843348, -80.323791]);
    const weekday = feed.calendar.find((row) => row.service_id === F.weekdayRailService);
    assert.deepEqual([weekday?.monday, weekday?.sunday, weekday?.start_date, weekday?.end_date], [1, 0, 20260803, 20261122]);
  });

  test('a stop_time naming an unknown stop → Err', () => {
    const overrides = withLine('stop_times.txt', '4828771, 5:32:00, 5:32:00,795,1,,0,0,,1', '4828771, 5:32:00, 5:32:00,99999,1,,0,0,,1');
    const error = expectErr(load(overrides));
    assert.equal(error.file, 'stops.txt');
    assert.match(error.message, /no stop_id 99999, referenced by in-scope stop_times/);
  });
});

describe('loadFeed: calendar and optional files', () => {
  test('loads the Labor Day 20260907 calendar_dates swap for in-scope services only', () => {
    const dates = expectOk(load()).calendarDates.map((row) => [row.service_id, row.date, row.exception_type]);
    assert.deepEqual(dates, [
      ['8', 20260907, 1],
      ['6', 20260907, 2],
    ]);
    assert.ok(dates.every(([service]) => service !== '1' && service !== '3'), 'the bus swap rows are dropped');
  });

  test('an absent calendar_dates.txt loads as no exceptions', () => {
    const feed = expectOk(load({ 'calendar_dates.txt': null }));
    assert.deepEqual(feed.calendarDates, []);
    assert.equal(feed.calendar.length, 4);
  });

  test('an in-scope frequency-based trip → Err; out-of-scope frequencies are ignored', () => {
    const header = 'trip_id,start_time,end_time,headway_secs\r\n';
    const busOnly = expectOk(load({}, { 'frequencies.txt': `${header}${F.busTrip},06:00:00,09:00:00,600\r\n` }));
    assert.equal(busOnly.trips.length, 12);
    const error = expectErr(load({}, { 'frequencies.txt': `${header}${F.greenTrip},06:00:00,09:00:00,600\r\n` }));
    assert.equal(error.file, 'frequencies.txt');
    assert.match(error.message, /in-scope trip 6283551 is frequency-based/);
  });

  test('feed_info.txt is loaded when present, and null when absent (as in the county feed)', () => {
    assert.equal(expectOk(load()).feedInfo, null);
    const feedInfo = 'feed_publisher_name,feed_publisher_url,feed_lang,feed_version\r\nMiami-Dade DTPW,https://example.org,en,2026-07\r\n';
    const feed = expectOk(load({}, { 'feed_info.txt': feedInfo }));
    assert.deepEqual([feed.feedInfo?.feed_publisher_name, feed.feedInfo?.feed_version], ['Miami-Dade DTPW', '2026-07']);
  });
});
