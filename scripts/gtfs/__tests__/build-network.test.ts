import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { haversineMeters } from '../../../src/lib/geo';
import type { Result } from '../../../src/lib/result';
import { MINI_FEED, MINI_FEED_FACTS as F, miniFeedZip, type MiniFeedOverrides } from '../__fixtures__/mini-feed';
import { linkBlocks, MAX_THROUGH_GAP_S, type BlockTrip } from '../block-links';
import { buildNetwork, tripNote, type NetworkError, type NetworkModel, type NetworkTrip } from '../build-network';
import { loadFeed } from '../load-feed';
import { isSymmetric, MAX_RAIL_MOVER_TRANSFER_M, SAME_STATION_TRANSFER_S, WALK_DETOUR_FACTOR, WALK_SPEED_M_PER_S } from '../transfers';
import { unzipFeed } from '../unzip-feed';
import { expectErr, expectOk } from './expect-result';

/** zip → unzip → load → build, exactly as the pipeline runs it, on the M2.4 mini feed. */
function network(overrides: MiniFeedOverrides = {}): Result<NetworkModel, NetworkError> {
  const feed = expectOk(loadFeed(expectOk(unzipFeed(miniFeedZip(overrides)))));
  assert.equal(feed.timeZone, F.timeZone);
  assert.equal(feed.trips.length, 12);
  return buildNetwork(feed);
}

/** The fixture with exact lines of one file replaced: [line, replacement] pairs (each line must exist). */
function withLines(file: keyof typeof MINI_FEED, ...edits: readonly (readonly [string, string])[]): MiniFeedOverrides {
  let text = MINI_FEED[file];
  for (const [line, replacement] of edits) {
    assert.ok(text.includes(`${line}\r\n`), `${file} has the line ${line}`);
    text = text.replace(`${line}\r\n`, `${replacement}\r\n`);
  }
  assert.notEqual(text, MINI_FEED[file]);
  return { [file]: text };
}

const MINI = expectOk(network());

function trip(tripId: string): NetworkTrip {
  const found = MINI.trips.find((candidate) => candidate.tripId === tripId);
  assert.ok(found !== undefined, `trip ${tripId} is in the network`);
  assert.equal(MINI.trips[found.idx], found, 'a trip sits at its own index');
  return found;
}

function patternLine(tripId: string): string {
  const pattern = MINI.patterns[trip(tripId).patternIdx];
  assert.ok(pattern !== undefined, `trip ${tripId} has a pattern`);
  assert.equal(pattern.idx, trip(tripId).patternIdx);
  return `${pattern.lineId}/${pattern.variant}`;
}

/** A synthetic block member for the linkBlocks unit cases. */
function blockTrip(idx: number, routeId: string, startS: number, endS: number, originKey: string, destinationKey: string): BlockTrip {
  assert.ok(startS <= endS, 'a block trip ends after it starts');
  assert.ok(idx >= 0, 'block trips are indexed');
  return { idx, tripId: `t${idx}`, routeId, serviceId: 'S', blockId: 'B', startS, endS, originKey, destinationKey };
}

/** next_trip_idx for a two-trip Mover block: trip 1 starts `gap` s after trip 0 ends (at mover:b), from `origin`. */
function linksAfter(gap: number, origin: string): (number | null)[] {
  assert.ok(gap >= 0, 'the second trip starts after the first ends');
  const links = expectOk(linkBlocks([blockTrip(0, F.innerLoopRoute, 0, 100, 'mover:a', 'mover:b'), blockTrip(1, F.innerLoopRoute, 100 + gap, 900 + gap, origin, 'mover:a')]));
  assert.equal(links.length, 2);
  return links;
}

describe('buildNetwork: stations and patterns on the mini feed', () => {
  test('clusters the mini feed into 23 rail and 20 Mover stations', () => {
    assert.equal(MINI.stations.filter((station) => station.mode === 'rail').length, 23);
    assert.equal(MINI.stations.filter((station) => station.mode === 'mover').length, 20);
    assert.deepEqual(['808', '832', '841'].map((stopId) => MINI.stationOfStop.get(stopId)), Array(3).fill('mover:bayfront-park'));
  });

  test('every pattern derives its line by stop pattern, with stop distances that never decrease', () => {
    const lines = Object.fromEntries(MINI.patterns.map((pattern) => [pattern.shapeId, `${pattern.lineId}/${pattern.variant}`]));
    assert.deepEqual(lines, {
      '123745': 'MM_OMNI/full',
      '123746': 'MM_BRICKELL/full',
      '123750': 'MM_INNER/full',
      '123751': 'MM_INNER/full',
      '211235': 'ORANGE/airport_shuttle',
      '211236': 'ORANGE/full',
      '211239': 'GREEN/full',
      '211246': 'GREEN/full',
      '211250': 'ORANGE/airport_shuttle',
      '211263': 'GREEN/full',
    });
    assert.ok(MINI.patterns.every((p) => p.distancesM.every((d, i) => i === 0 || d >= (p.distancesM[i - 1] ?? Infinity))));
  });

  test('a pattern touching both branches is a build error', () => {
    const overrides = withLines('stop_times.txt', ['6283699,22:44:00,22:44:00,9501,1,,0,0,,1', '6283699,22:44:00,22:44:00,9499,1,,0,0,,1']);
    const error = expectErr(network(overrides));
    assert.equal(error.step, 'lines');
    assert.match(error.message, /shape 211250: route 31009 pattern touches both branches — GREEN \(rail:brownsville\) and ORANGE/);
  });

  test('a stop more than 100 m from its shape is a build error naming the stop', () => {
    // Santa Clara's two platforms moved 150 m east (+0.0015° of longitude), off the published
    // track; they stay ~5 m apart, so they are still one station and only the projection fails.
    const overrides = withLines(
      'stops.txt',
      ['9504,SCLRAILS,SANTA CLARA STATION RAIL SOUTHBOUND,,25.795807,-80.215228,,,,,,2', '9504,SCLRAILS,SANTA CLARA STATION RAIL SOUTHBOUND,,25.795807,-80.213729,,,,,,2'],
      ['9505,SCLRAILN,SANTA CLARA STATION RAIL NORTHBOUND,,25.795809,-80.215174,,,,,,2', '9505,SCLRAILN,SANTA CLARA STATION RAIL NORTHBOUND,,25.795809,-80.213675,,,,,,2'],
    );
    const error = expectErr(network(overrides));
    assert.equal(error.step, 'shapes');
    assert.match(error.message, /route 31009 shape 211236: stop 3 is 1[45]\d\.\d m from the shape \(max 100 m\) \(stop_id 9504\)/);
  });
});

describe('buildNetwork: block links (next_trip_idx)', () => {
  test('Inner Loop halves get next_trip_idx: A → B at Government Center, B → A again at Bayfront Park', () => {
    const [first, second, third] = F.innerLoopHalfTrips.map(trip);
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    assert.deepEqual([first.nextTripIdx, second.nextTripIdx, third.nextTripIdx], [second.idx, third.idx, null]);
    assert.deepEqual([first.destinationKey, second.originKey], ['mover:government-center', 'mover:government-center']);
    // B ends at stop 841 and the next A starts at stop 832: different stop_ids, one station.
    assert.deepEqual([second.destinationKey, third.originKey], ['mover:bayfront-park', 'mover:bayfront-park']);
  });

  test('no rail trip and no lone Mover trip gets a next_trip_idx in the mini feed', () => {
    const linked = MINI.trips.filter((candidate) => candidate.nextTripIdx !== null).map((candidate) => candidate.tripId);
    assert.deepEqual(linked.sort(), [F.innerLoopHalfTrips[0], F.innerLoopHalfTrips[1]].sort());
    assert.ok(MINI.trips.filter((candidate) => candidate.routeId === F.railRoute).every((candidate) => candidate.nextTripIdx === null));
  });

  test('rail trips never get next_trip_idx, even when the block runs on from the same station', () => {
    const rail = [blockTrip(0, F.railRoute, 100, 200, 'rail:palmetto', 'rail:dadeland-south'), blockTrip(1, F.railRoute, 260, 400, 'rail:dadeland-south', 'rail:palmetto')];
    assert.deepEqual(expectOk(linkBlocks(rail)), [null, null]);
    const mover = rail.map((member) => ({ ...member, routeId: F.innerLoopRoute }));
    assert.deepEqual(expectOk(linkBlocks(mover)), [1, null]);
  });

  test(`a stand over ${MAX_THROUGH_GAP_S} s or a different station ends the ride`, () => {
    assert.equal(MAX_THROUGH_GAP_S, 600);
    assert.deepEqual(
      [linksAfter(MAX_THROUGH_GAP_S, 'mover:b'), linksAfter(MAX_THROUGH_GAP_S + 1, 'mover:b'), linksAfter(0, 'mover:c')],
      [[1, null], [null, null], [null, null]],
    );
  });

  test('two trips of one block overlapping in time are a build error', () => {
    const overrides = withLines('stop_times.txt', ['4832382,10:07:30,10:07:30,813,1,,0,0,,1', '4832382,10:07:00,10:07:00,813,1,,0,0,,1']);
    const error = expectErr(network(overrides));
    assert.equal(error.step, 'blocks');
    assert.match(error.message, /block 14457\/11\/1403245: trip 4832382 starts \(36420 s\) before trip 4832840 ends \(36450 s\)/);
  });
});

describe('buildNetwork: destinations and single-track notes', () => {
  test('single-track note on headsign "EHT - CUL SINGLE TRACK AFTER 8PM"', () => {
    const late = trip(F.singleTrackTrips['AFTER 8PM']);
    assert.equal(late.headsign, 'EHT - CUL SINGLE TRACK AFTER 8PM');
    assert.equal(late.note, 'Single-track service after 8 PM');
    assert.deepEqual([patternLine(late.tripId), late.destinationKey], ['GREEN/full', 'rail:dadeland-south']);
  });

  test('single-track note on headsign "EHT - CUL SINGLE TRACK AFTER 8 PM"', () => {
    const late = trip(F.singleTrackTrips['AFTER 8 PM']);
    assert.equal(late.headsign, 'EHT - CUL SINGLE TRACK AFTER 8 PM');
    assert.equal(late.note, 'Single-track service after 8 PM');
    assert.deepEqual([patternLine(late.tripId), late.destinationKey], ['GREEN/full', 'rail:palmetto']);
  });

  test('trips with other headsigns carry no single-track note; other spellings still read cleanly', () => {
    const singleTrack = new Set<string>(Object.values(F.singleTrackTrips));
    assert.ok(MINI.trips.filter((candidate) => !singleTrack.has(candidate.tripId)).every((candidate) => candidate.note === null));
    assert.deepEqual(
      ['SINGLE TRACK AFTER 9:30 p.m.', 'EHT-CUL SINGLE-TRACK', 'GREEN LINE DADELAND SOUTH'].map(tripNote),
      ['Single-track service after 9:30 PM', 'Single-track service', null],
    );
  });

  test('destination = last station, not the headsign', () => {
    for (const candidate of MINI.trips) {
      const pattern = MINI.patterns[candidate.patternIdx];
      assert.equal(candidate.destinationKey, pattern?.stationKeys[pattern.stationKeys.length - 1]);
    }
    const cases = [F.singleTrackTrips['AFTER 8PM'], F.shuttleTrips[0], F.omniTrip, F.innerLoopHalfTrips[1]].map(trip);
    assert.deepEqual(
      cases.map((candidate) => [candidate.headsign, candidate.destinationKey]),
      [
        ['EHT - CUL SINGLE TRACK AFTER 8PM', 'rail:dadeland-south'],
        ['EARLINGTON HEIGHTS', 'rail:earlington-hts'],
        ['DOWNTOWN', 'mover:government-center'],
        ['INNER LOOP', 'mover:bayfront-park'],
      ],
    );
  });
});

describe('buildNetwork: transfers', () => {
  test('same-station transfer = 60 s, one per station (Government Center rail N+S is one station)', () => {
    const own = MINI.transfers.filter((transfer) => transfer.fromKey === transfer.toKey);
    assert.deepEqual(own.map((transfer) => transfer.fromKey), MINI.stations.map((station) => station.key));
    assert.ok(own.every((transfer) => transfer.seconds === SAME_STATION_TRANSFER_S && transfer.seconds === 60));
    assert.deepEqual([MINI.stationOfStop.get('9512'), MINI.stationOfStop.get('9513')], ['rail:government-ctr', 'rail:government-ctr']);
  });

  test('rail↔mover only within 400 m: exactly the pairs that close, and never rail↔rail or mover↔mover', () => {
    const rail = MINI.stations.filter((station) => station.mode === 'rail');
    const movers = MINI.stations.filter((station) => station.mode === 'mover');
    const pairs = rail.flatMap((r) => movers.map((m) => ({ pair: `${r.key} ${m.key}`, metres: haversineMeters(r, m) })));
    const close = pairs.filter(({ metres }) => metres <= MAX_RAIL_MOVER_TRANSFER_M).map(({ pair }) => pair);
    const crossing = MINI.transfers.filter((t) => t.fromKey !== t.toKey && t.fromKey.startsWith('rail:')).map((t) => `${t.fromKey} ${t.toKey}`);
    assert.deepEqual(crossing.sort(), close.sort());
    assert.ok(close.length >= 4 && pairs.some(({ metres }) => metres > 400 && metres < 500), 'the 400 m cut is exercised from both sides');
    assert.ok(MINI.transfers.every((t) => t.fromKey === t.toKey || t.fromKey.split(':')[0] !== t.toKey.split(':')[0]));
  });

  test('transfer table is symmetric', () => {
    assert.equal(isSymmetric(MINI.transfers), true);
    for (const transfer of MINI.transfers) {
      const reverse = MINI.transfers.find((t) => t.fromKey === transfer.toKey && t.toKey === transfer.fromKey);
      assert.deepEqual([reverse?.seconds, reverse?.distanceM], [transfer.seconds, transfer.distanceM]);
    }
  });

  test('a rail↔mover change costs 60 s plus the walk (haversine × 1.3 at 1.3 m/s)', () => {
    const govCtr = MINI.transfers.find((t) => t.fromKey === 'rail:government-ctr' && t.toKey === 'mover:government-center');
    assert.ok(govCtr !== undefined && govCtr.distanceM > 10 && govCtr.distanceM < 30, 'the two Government Centers are ~20 m apart');
    const [r, m] = ['rail:government-ctr', 'mover:government-center'].map((key) => MINI.stations.find((s) => s.key === key));
    assert.ok(r !== undefined && m !== undefined);
    assert.equal(govCtr.seconds, 60 + Math.ceil((haversineMeters(r, m) * WALK_DETOUR_FACTOR) / WALK_SPEED_M_PER_S));
  });
});
