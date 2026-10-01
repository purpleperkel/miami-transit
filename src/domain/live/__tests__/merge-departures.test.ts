import { windowFrom } from '../../gtfs/service-day';
import type { Departure } from '../../schedule/departures';
import { DEPARTURES_9513 } from '../__fixtures__/transitland-departures.fixture';
import { predictionsFromDepartures } from '../from-transitland-departures';
import { type DepartureRow, mergeDepartures } from '../merge-departures';
import type { LivePrediction } from '../types';
import { testNetwork } from './test-network';

/**
 * M4.7: §4 merge rule 6 — predictions override scheduled times, cancellations are struck through,
 * an unmatched prediction becomes its own row. Times: Wednesday 2026-10-01 at Government Center
 * northbound (stop 9513), EDT = UTC−4, built with Date.UTC.
 */

const SERVICE_DATE = 20261001;
const BASE_EPOCH = Date.UTC(2026, 9, 1, 4, 0, 0) / 1000;
const BOARD = windowFrom(BASE_EPOCH + 8 * 3600 + 20 * 60, 3600);

/** A Government Center NB departure at hh:mm EDT. */
function departure(tripId: string, hh: number, mm: number, lineId = 'ORANGE'): Departure {
  const depS = hh * 3600 + mm * 60;
  const made: Departure = {
    serviceDate: SERVICE_DATE, epoch: BASE_EPOCH + depS, depS, tripIdx: depS, tripId, stopId: '9513', lineId, directionId: 1,
    destStationKey: lineId === 'ORANGE' ? 'rail:miami-international-airport' : 'rail:palmetto', destName: lineId === 'ORANGE' ? 'Airport' : 'Palmetto', note: null,
  };
  expect(made.epoch - BASE_EPOCH).toBe(depS);
  expect(made.epoch).toBe(Date.UTC(2026, 9, 1, hh + 4, mm, 0) / 1000);
  return made;
}

/** A prediction for `tripId` at stop 9513 (or trip-wide with `stopId: null`). */
function prediction(tripId: string | null, fields: Partial<LivePrediction>): LivePrediction {
  const made: LivePrediction = {
    tripId, routeId: '31009', lineId: 'ORANGE', stopId: '9513', stationKey: 'rail:government-ctr',
    epoch: null, scheduledEpoch: null, delayS: null, realtime: true, canceled: false, headsign: null, ...fields,
  };
  expect(made.realtime || made.canceled || made.epoch === null).toBe(true);
  expect(made.routeId).toBe('31009');
  return made;
}

function board(rows: readonly DepartureRow[]): string[] {
  const lines = rows.map((r) => `${r.tripId ?? '?'} ${new Date(r.epoch * 1000).toISOString().slice(11, 19)} ${r.live ? 'live' : 'sched'}${r.canceled ? ' STRUCK' : ''}`);
  expect(rows.every((r, i) => i === 0 || (rows[i - 1]?.epoch ?? 0) <= r.epoch)).toBe(true);
  expect(lines).toHaveLength(rows.length);
  return lines;
}

const A_0828 = departure('trip-a', 8, 28);
const B_0834 = departure('trip-b', 8, 34, 'GREEN');

describe('departures merge (M4.7): §4 rule 6, overrides', () => {
  it('rule 6: same-trip override — a realtime prediction replaces the scheduled time and can reorder the board', () => {
    const late = prediction('trip-a', { epoch: A_0828.epoch + 437 });
    const merged = mergeDepartures([A_0828, B_0834], [late], BOARD);
    expect(board(merged.rows)).toEqual(['trip-b 12:34:00 sched', 'trip-a 12:35:17 live']);
    expect(merged.rows[1]).toMatchObject({ scheduledEpoch: A_0828.epoch, delayS: 437, destName: 'Airport', departure: A_0828, prediction: late });
    expect(merged.unused).toBe(0);
  });

  it('rule 6: same-trip override — a delay-only prediction (GTFS-rt) shifts the scheduled time', () => {
    const merged = mergeDepartures([A_0828], [prediction('trip-a', { delayS: 45 })], BOARD);
    expect(board(merged.rows)).toEqual(['trip-a 12:28:45 live']);
    expect(merged.rows[0]?.delayS).toBe(45);
  });

  it('rule 6: same-trip override only at the same stop, and never from a scheduled-only row', () => {
    const otherPlatform = prediction('trip-a', { stopId: '9512', epoch: A_0828.epoch + 600 });
    const staticRow = prediction('trip-b', { realtime: false, scheduledEpoch: B_0834.epoch });
    const merged = mergeDepartures([A_0828, B_0834], [otherPlatform, staticRow], BOARD);
    expect(board(merged.rows)).toEqual(['trip-a 12:28:00 sched', 'trip-b 12:34:00 sched', 'trip-a 12:38:00 live']);
    expect(merged.unused).toBe(0);
  });
});

describe('departures merge (M4.7): §4 rule 6, cancellations and unmatched predictions', () => {
  it('rule 6: a canceled trip is struck through at its scheduled time, never removed (stop-level or trip-wide)', () => {
    const merged = mergeDepartures([A_0828, B_0834], [prediction('trip-a', { canceled: true, realtime: false }), prediction('trip-b', { stopId: null, stationKey: null, canceled: true })], BOARD);
    expect(board(merged.rows)).toEqual(['trip-a 12:28:00 live STRUCK', 'trip-b 12:34:00 live STRUCK']);
    expect(merged.rows.every((r) => r.canceled && r.departure !== null)).toBe(true);
  });

  it('rule 6: an unmatched prediction becomes its own row (an added train), with its headsign as destination', () => {
    const added = prediction('trip-added', { epoch: A_0828.epoch + 120, headsign: 'ORANGE LINE AIRPORT STATION' });
    const merged = mergeDepartures([A_0828], [added], BOARD);
    expect(board(merged.rows)).toEqual(['trip-a 12:28:00 sched', 'trip-added 12:30:00 live']);
    expect(merged.rows[1]).toMatchObject({ key: 'live:trip-added:9513', destName: 'ORANGE LINE AIRPORT STATION', departure: null, lineId: 'ORANGE' });
  });

  it('rule 6: unmatched predictions without live news, without a time, or outside the window make no row and are counted', () => {
    const merged = mergeDepartures([A_0828], [
      prediction('trip-static', { realtime: false, scheduledEpoch: A_0828.epoch + 300 }),
      prediction('trip-delay-only', { delayS: 60 }),
      prediction('trip-canceled-elsewhere', { stopId: null, stationKey: null, canceled: true }),
      prediction('trip-tomorrow', { epoch: A_0828.epoch + 86_400 }),
    ], BOARD);
    expect(board(merged.rows)).toEqual(['trip-a 12:28:00 sched']);
    expect(merged.unused).toBe(4);
  });

  it('rule 6 end to end: the Transitland fixture over the timetable — override, scheduled-only, struck', () => {
    const live = predictionsFromDepartures(DEPARTURES_9513, testNetwork());
    expect(live.ok).toBe(true);
    const timetable = [departure('fixture-rail-0828', 8, 28), departure('fixture-rail-0834', 8, 34, 'GREEN'), departure('fixture-rail-0846', 8, 46), departure('fixture-rail-0858', 8, 58, 'GREEN'), departure('fixture-rail-0920', 9, 20)];
    const merged = mergeDepartures(timetable, live.ok ? live.value.items : [], BOARD);
    expect(board(merged.rows)).toEqual([
      'fixture-rail-0828 12:31:47 live',
      'fixture-rail-0834 12:35:02 live',
      'fixture-rail-0846 12:46:00 sched',
      'fixture-rail-0858 12:58:00 sched',
      'fixture-rail-0920 13:20:00 live STRUCK',
    ]);
    expect(merged.unused).toBe(0);
  });
});
