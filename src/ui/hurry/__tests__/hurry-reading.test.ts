import type { StationListing } from '../../../data/schedule-queries';
import type { TimeWindow } from '../../../domain/gtfs/service-day';
import type { Platform } from '../../../domain/hurry/platform';
import type { LiveBatch, LivePrediction } from '../../../domain/live/types';
import type { Departure } from '../../../domain/schedule/departures';
import { haversineMeters } from '../../../lib/geo';
import { ok } from '../../../lib/result';
import { hurryCopy } from '../copy';
import { clockFor, HURRY_RANGE_M, type HurryReading, hurryReading, type HurrySource, soonestBoard, stationTimetable } from '../hurry-reading';

/**
 * Plan M7c.3, the wiring's pure half, over a small two-platform rail station: Government Center's
 * southbound platform 9512 and northbound 9513, 100 m apart along a meridian. Now is 08:00 on a service
 * day whose base is BASE; walks are judged at Jamie's default paces.
 */

const BASE = 1_790_740_800;
const NOW = BASE + 8 * 3600;
const PACE = { walkMps: 1.35, jogMps: 2.7 };
const SOUTH: Platform = { stationKey: 'rail:government-ctr', stopId: '9512', directionIds: [0], latitude: 25.7740, longitude: -80.1957 };
const NORTH: Platform = { stationKey: 'rail:government-ctr', stopId: '9513', directionIds: [1], latitude: 25.7749, longitude: -80.1957 };
const STATION: StationListing = { stationKey: 'rail:government-ctr', name: 'Government Center', mode: 'rail', coordinate: { latitude: 25.77445, longitude: -80.1957 } };
/** 300 m south of the southbound platform (about 400 m from the northbound one). */
const RIDER = { latitude: 25.7713, longitude: -80.1957 };

function departure(tripId: string, directionId: 0 | 1, inS: number): Departure {
  const made: Departure = {
    serviceDate: 20260930,
    epoch: NOW + inS,
    depS: 8 * 3600 + inS,
    tripIdx: Number(tripId.slice(1)),
    tripId,
    stopId: directionId === 0 ? '9512' : '9513',
    lineId: 'GREEN',
    directionId,
    destStationKey: directionId === 0 ? 'rail:dadeland-south' : 'rail:palmetto',
    destName: directionId === 0 ? 'Dadeland South' : 'Palmetto',
    note: null,
  };
  expect(made.epoch - made.depS).toBe(BASE);
  expect(made.tripIdx).toBeGreaterThan(0);
  return made;
}

/** The repo's part the reading uses, over these departures. */
function source(departures: readonly Departure[]): HurrySource {
  const fake: HurrySource = {
    stations: () => [STATION],
    platforms: () => [SOUTH, NORTH],
    serviceDays: () => ({ kind: 'active', days: [{ date: 20260930, baseEpoch: BASE }] }),
    departures: (_key: string, window: TimeWindow) => ok({ kind: 'departures', serviceDates: [20260930], departures: departures.filter((d) => d.epoch >= window.fromEpoch && d.epoch <= window.toEpoch) }),
  };
  expect(fake.platforms()).toHaveLength(2);
  expect(fake.stations()[0]?.stationKey).toBe(SOUTH.stationKey);
  return fake;
}

/** The reading at NOW for the rider at `coordinate`, with `batch` as the station's live predictions. */
function read(departures: readonly Departure[], coordinate = RIDER, batch: LiveBatch<LivePrediction> | null = null): HurryReading {
  const timetable = stationTimetable(source(departures), STATION.stationKey, NOW);
  expect(timetable.kind).toBe('timetable');
  const reading = hurryReading({ db: { kind: 'ready' }, position: { coordinate, note: null }, timetable, batch, nowS: NOW, pace: PACE });
  expect(reading.kind).not.toBe('locating');
  return reading;
}

/** The boards of a reading that has them. */
function boardsOf(reading: HurryReading) {
  expect(reading.kind).toBe('boards');
  const boards = reading.kind === 'boards' ? reading.boards : [];
  expect(boards.length).toBeGreaterThan(0);
  return boards;
}

describe('hurry or chill at a station (M7c.3)', () => {
  it('gives one verdict per direction, each walked to its own platform', () => {
    const boards = boardsOf(read([departure('T1', 0, 600), departure('T2', 1, 300), departure('T3', 1, 1200)]));
    expect(boards.map((b) => [b.directionId, b.title, b.verdict.kind])).toEqual([[0, 'To Dadeland South', 'CHILL'], [1, 'To Palmetto', 'JOG']]);
    expect(boards[0]?.walkMeters).toBeCloseTo(haversineMeters(RIDER, SOUTH), 6);
    expect(boards[1]?.walkMeters).toBeCloseTo(haversineMeters(RIDER, NORTH), 6);
  });

  it('never lets the other direction\'s train decide whether a jog is worth it', () => {
    // A southbound train 100 s after the northbound one is no reason to skip the northbound jog.
    const boards = boardsOf(read([departure('T2', 1, 300), departure('T4', 0, 400), departure('T5', 1, 1500)]));
    expect(boards.find((b) => b.directionId === 1)?.verdict.kind).toBe('JOG');
    expect(soonestBoard(boards).directionId).toBe(1);
  });

  it('says No more trains tonight when nothing leaves either way', () => {
    const boards = boardsOf(read([]));
    expect(boards.map((b) => [b.directionId, b.title, b.verdict.kind, b.freshness.kind])).toEqual([[null, null, 'NO_SERVICE', 'scheduled']]);
    expect(hurryCopy(boards[0]!.verdict, { now: NOW, clock: clockFor([BASE]) })).toBe('No more trains tonight');
  });

  it('a stale live prediction lowers the confidence and ages the badge', () => {
    const live: LivePrediction = { tripId: 'T2', routeId: '31009', lineId: 'GREEN', stopId: '9513', stationKey: STATION.stationKey, epoch: NOW + 330, scheduledEpoch: NOW + 300, delayS: 30, realtime: true, canceled: false, headsign: 'Palmetto' };
    const batch: LiveBatch<LivePrediction> = { provider: 'transitland', items: [live], feedTimestamp: null, dropped: {}, fetchedAt: NOW - 200, bytes: 1_000 };
    const north = boardsOf(read([departure('T2', 1, 300), departure('T3', 1, 1200)], RIDER, batch)).find((b) => b.directionId === 1);
    expect([north?.verdict.departure?.epoch, north?.verdict.live, north?.verdict.confidence]).toEqual([NOW + 330, true, 'low']);
    expect(north?.freshness).toEqual({ kind: 'stale', ageS: 200 });
    const fresh = boardsOf(read([departure('T2', 1, 300), departure('T3', 1, 1200)], RIDER, { ...batch, fetchedAt: NOW - 60 })).find((b) => b.directionId === 1);
    expect([fresh?.verdict.confidence, fresh?.freshness]).toEqual(['normal', { kind: 'live' }]);
  });
});

describe('hurry or chill without a verdict (M7c.3)', () => {
  it('beyond the hurry range there is no train to hurry for', () => {
    const across = { latitude: RIDER.latitude - 0.03, longitude: RIDER.longitude };
    const reading = read([departure('T1', 0, 600)], across);
    expect(reading).toMatchObject({ kind: 'far', stationName: 'Government Center' });
    expect(reading.kind === 'far' && reading.walkMeters > HURRY_RANGE_M).toBe(true);
  });

  it('waits for a fix, or says why there is none', () => {
    const timetable = stationTimetable(source([]), STATION.stationKey, NOW);
    const ready = { db: { kind: 'ready' }, timetable, batch: null, nowS: NOW, pace: PACE } as const;
    expect(hurryReading({ ...ready, position: { coordinate: null, note: null } })).toEqual({ kind: 'locating' });
    expect(hurryReading({ ...ready, position: { coordinate: null, note: 'Location is off' } })).toEqual({ kind: 'no-location', note: 'Location is off' });
  });

  it('follows the schedule DB while it opens or fails, and says when the timetable has run out', () => {
    const position = { coordinate: RIDER, note: null };
    expect(hurryReading({ db: { kind: 'opening' }, position, timetable: null, batch: null, nowS: NOW, pace: PACE })).toEqual({ kind: 'opening' });
    expect(hurryReading({ db: { kind: 'failed', message: 'disk full' }, position, timetable: null, batch: null, nowS: NOW, pace: PACE })).toEqual({ kind: 'failed', message: 'disk full' });
    const expired: HurrySource = { ...source([]), departures: () => ok({ kind: 'expired', lastDate: 20261122 }) };
    const timetable = stationTimetable(expired, STATION.stationKey, NOW);
    expect(hurryReading({ db: { kind: 'ready' }, position, timetable, batch: null, nowS: NOW, pace: PACE })).toMatchObject({ kind: 'gap', gap: { kind: 'expired' } });
  });
});

describe('the clock hurry or chill names trains by (M7c.3)', () => {
  it('counts from the latest service day that has begun', () => {
    const clock = clockFor([BASE + 86_400, BASE]);
    expect([clock(NOW + 14 * 60), clock(BASE + 86_400 + 60)]).toEqual(['8:14', '12:01']);
    expect(clock(BASE - 60)).toBe('11:59');
  });
});
