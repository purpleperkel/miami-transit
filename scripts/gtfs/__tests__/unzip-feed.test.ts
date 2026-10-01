import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { strFromU8, strToU8, zipSync } from 'fflate';

import { MINI_FEED, miniFeedEntries, miniFeedZip } from '../__fixtures__/mini-feed';
import { REQUIRED_FEED_FILES, unzipFeed } from '../unzip-feed';
import { expectErr, expectOk } from './expect-result';

describe('unzipFeed', () => {
  test('extracts the 7 required files, byte for byte', () => {
    const files = expectOk(unzipFeed(miniFeedZip()));
    assert.deepEqual(REQUIRED_FEED_FILES, [
      'agency.txt',
      'routes.txt',
      'trips.txt',
      'stop_times.txt',
      'stops.txt',
      'calendar.txt',
      'shapes.txt',
    ]);
    for (const name of REQUIRED_FEED_FILES) {
      assert.ok(Buffer.from(files[name]).equals(Buffer.from(strToU8(MINI_FEED[name]))), `${name} round-trips byte for byte`);
    }
  });

  test('missing file → Err naming it', () => {
    const error = expectErr(unzipFeed(miniFeedZip({ 'stops.txt': null })));
    assert.equal(error.kind, 'missing-file');
    assert.ok(error.kind === 'missing-file' && error.file === 'stops.txt');
    assert.match(error.message, /stops\.txt/);
  });

  test('carries the optional calendar_dates.txt when the zip has it', () => {
    const files = expectOk(unzipFeed(miniFeedZip()));
    assert.equal(strFromU8(files['calendar_dates.txt'] ?? new Uint8Array()), MINI_FEED['calendar_dates.txt']);
    assert.equal(files['stops.txt'][0], 0xef, 'the BOM on stops.txt survives the zip (it is stripped only when decoded)');
    assert.equal(files['feed_info.txt'], undefined, 'like the county feed, the fixture has no feed_info.txt');
  });

  test('an absent optional calendar_dates.txt is no error — it is simply absent', () => {
    const files = expectOk(unzipFeed(miniFeedZip({ 'calendar_dates.txt': null })));
    assert.equal(files['calendar_dates.txt'], undefined);
    assert.ok(files['calendar.txt'] instanceof Uint8Array);
  });

  test('extracts only the files the pipeline reads', () => {
    const zip = zipSync({ ...miniFeedEntries(), 'README.txt': strToU8('not GTFS'), 'extra/stops.txt': strToU8('x') });
    const files = expectOk(unzipFeed(zip));
    assert.ok(!('README.txt' in files) && !('extra/stops.txt' in files));
    assert.ok(Buffer.from(files['stops.txt']).equals(Buffer.from(strToU8(MINI_FEED['stops.txt']))), 'not the nested stops.txt');
  });

  test('a corrupt or truncated zip → Err', () => {
    const garbage = expectErr(unzipFeed(new TextEncoder().encode('<html>not a zip</html>')));
    assert.equal(garbage.kind, 'corrupt-zip');
    const zip = miniFeedZip();
    const truncated = expectErr(unzipFeed(zip.subarray(0, Math.floor(zip.length / 2))));
    assert.equal(truncated.kind, 'corrupt-zip');
    assert.match(truncated.message, /cannot be read/);
  });
});
