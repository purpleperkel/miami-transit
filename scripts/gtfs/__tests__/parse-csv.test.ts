import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvariantError } from '../../../src/lib/invariant';
import { parseCsv } from '../parse-csv';
import { expectErr, expectOk } from './expect-result';

/** Rows copied from the county feed (2026-07-31): CRLF endings and a space before unpadded times. */
const STOP_TIMES =
  'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\r\n' +
  '4828771, 5:32:00, 5:32:00,795,1,,0,0,,1\r\n' +
  '4828771, 5:33:00, 5:33:00,796,2,,0,0,0.5206,1\r\n';
const STOP_TIME_COLUMNS = { required: ['trip_id', 'arrival_time', 'stop_id'] } as const;

describe('parseCsv', () => {
  test('handles CRLF line endings (no stray \\r in any field, lines counted from the header)', () => {
    const records = expectOk(parseCsv('stop_times.txt', STOP_TIMES, STOP_TIME_COLUMNS));
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => [r.line, r.fields.stop_id]),
      [
        [2, '795'],
        [3, '796'],
      ],
    );
    assert.ok(records.every((r) => Object.values(r.fields).every((value) => !value.includes('\r'))));
    const lf = expectOk(parseCsv('stop_times.txt', STOP_TIMES.replaceAll('\r\n', '\n'), STOP_TIME_COLUMNS));
    assert.deepEqual(lf, records);
  });

  test('trims leading spaces (" 5:32:00" reads as "5:32:00", padded header names too)', () => {
    const records = expectOk(parseCsv('stop_times.txt', STOP_TIMES, STOP_TIME_COLUMNS));
    assert.equal(records[0]?.fields.arrival_time, '5:32:00');
    const padded = expectOk(parseCsv('routes.txt', ' route_id , route_type\r\n 31009 ,  2\r\n', { required: ['route_id', 'route_type'] }));
    assert.deepEqual(padded[0]?.fields, { route_id: '31009', route_type: '2' });
  });

  test('strips a BOM, from a string and from raw UTF-8 bytes', () => {
    const text = '\uFEFFagency_id,agency_timezone\r\nDTPW305,America/New_York\r\n';
    const columns = { required: ['agency_id', 'agency_timezone'] } as const;
    const fromString = expectOk(parseCsv('agency.txt', text, columns));
    const fromBytes = expectOk(parseCsv('agency.txt', new TextEncoder().encode(text), columns));
    assert.equal(new TextEncoder().encode(text)[0], 0xef, 'the bytes really start with EF BB BF');
    assert.deepEqual(fromString[0]?.fields, { agency_id: 'DTPW305', agency_timezone: 'America/New_York' });
    assert.deepEqual(fromBytes, fromString);
  });

  test('keeps a quoted field whole (embedded comma, doubled quote, inner spaces)', () => {
    const text = 'route_id,route_long_name\r\n31099,"DOWNTOWN, NE 84 ST VIA ""NW"" 2 AVE"\r\n1, "  spaced  " \r\n';
    const records = expectOk(parseCsv('routes.txt', text, { required: ['route_id', 'route_long_name'] }));
    assert.equal(records[0]?.fields.route_long_name, 'DOWNTOWN, NE 84 ST VIA "NW" 2 AVE');
    assert.equal(records[1]?.fields.route_long_name, '  spaced  ');
  });

  test('missing column → Err naming file and column', () => {
    const error = expectErr(parseCsv('stop_times.txt', STOP_TIMES, { required: ['trip_id', 'block_id'] }));
    assert.equal(error.kind, 'missing-column');
    assert.equal(error.file, 'stop_times.txt');
    assert.ok(error.kind === 'missing-column' && error.column === 'block_id');
    assert.match(error.message, /stop_times\.txt.*block_id/);
  });
});

describe('parseCsv: optional columns and filtering', () => {
  test('an absent optional column reads as the empty string', () => {
    const records = expectOk(parseCsv('stop_times.txt', STOP_TIMES, { required: ['trip_id'], optional: ['stop_note'] }));
    assert.equal(records.length, 2);
    assert.deepEqual(records[0]?.fields, { trip_id: '4828771', stop_note: '' });
  });

  test('keep drops rows as they stream past and sees only the declared columns', () => {
    const seen: string[][] = [];
    const records = expectOk(
      parseCsv('stop_times.txt', STOP_TIMES, { required: ['trip_id', 'stop_id'] }, (fields) => {
        seen.push(Object.keys(fields));
        return fields.stop_id === '796';
      }),
    );
    assert.deepEqual(
      records.map((r) => [r.line, r.fields.stop_id]),
      [[3, '796']],
    );
    assert.deepEqual(seen, [
      ['trip_id', 'stop_id'],
      ['trip_id', 'stop_id'],
    ]);
  });

  test('a header with no data rows parses to no records', () => {
    const records = expectOk(parseCsv('calendar_dates.txt', 'service_id,date,exception_type\r\n', { required: ['date'] }));
    assert.equal(records.length, 0);
    assert.ok(Array.isArray(records));
  });
});

describe('parseCsv: malformed input', () => {
  test('a ragged row → Err naming the file and the line', () => {
    const error = expectErr(parseCsv('stops.txt', 'stop_id,stop_name\r\n1,A\r\n2\r\n', { required: ['stop_id'] }));
    assert.equal(error.kind, 'malformed');
    assert.ok(error.kind === 'malformed' && error.line === 3);
    assert.match(error.message, /^stops\.txt line 3: /);
  });

  test('an unclosed quote → Err naming the file', () => {
    const error = expectErr(parseCsv('stops.txt', 'stop_id,stop_name\r\n1,"Gov\r\n', { required: ['stop_id'] }));
    assert.equal(error.kind, 'malformed');
    assert.match(error.message, /^stops\.txt/);
  });

  test('bytes that are not UTF-8 → Err naming the file (never silently replaced)', () => {
    const bytes = Uint8Array.of(...new TextEncoder().encode('stop_id,stop_name\r\n1,'), 0xff, 0x0d, 0x0a);
    const error = expectErr(parseCsv('stops.txt', bytes, { required: ['stop_id'] }));
    assert.equal(error.kind, 'encoding');
    assert.match(error.message, /^stops\.txt is not valid UTF-8/);
  });

  test('an empty file → Err for its first required column', () => {
    const error = expectErr(parseCsv('agency.txt', '', { required: ['agency_timezone', 'agency_name'] }));
    assert.equal(error.kind, 'missing-column');
    assert.ok(error.kind === 'missing-column' && error.column === 'agency_timezone');
  });

  test('an exception thrown by keep is rethrown, not disguised as malformed CSV', () => {
    assert.throws(
      () =>
        parseCsv('stop_times.txt', STOP_TIMES, STOP_TIME_COLUMNS, () => {
          throw new InvariantError('keep blew up');
        }),
      { name: 'InvariantError', message: 'keep blew up' },
    );
    // Control: the same input parses when keep does not throw, so the throw above came from keep.
    assert.equal(expectOk(parseCsv('stop_times.txt', STOP_TIMES, STOP_TIME_COLUMNS, () => true)).length, 2);
  });
});
