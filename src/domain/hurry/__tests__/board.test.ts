import { mergeDepartures } from '../../live/merge-departures';
import type { LivePrediction } from '../../live/types';
import type { Departure } from '../../schedule/departures';
import { hurryDepartures } from '../board';
import { hurryVerdict } from '../verdict';

/**
 * Plan M7c.3: the departures hurry-or-chill weighs come from m4a's merged board — the timetable with the
 * station's live predictions merged in (merge rule 6) — at the platform the rider walks to. Rows the rider
 * cannot board never reach the verdict: canceled trains (the board keeps them, struck through), trains at
 * the station's other platforms, and trains already gone.
 */

const BASE = 1_790_755_200;
const NOW = BASE + 28_800;
const WINDOW = { fromEpoch: NOW - 300, toEpoch: NOW + 7_200 };

function departure(tripId: string, stopId: string, inS: number, directionId = 0): Departure {
  const made: Departure = {
    serviceDate: 20260930,
    epoch: NOW + inS,
    depS: 28_800 + inS,
    tripIdx: Number(tripId.replace(/\D/g, '')),
    tripId,
    stopId,
    lineId: 'GREEN',
    directionId,
    destStationKey: 'rail:dadeland-south',
    destName: 'Dadeland South',
    note: null,
  };
  expect(made.epoch - made.depS).toBe(BASE);
  expect(made.tripIdx).toBeGreaterThan(0);
  return made;
}

function prediction(tripId: string, stopId: string, fields: Partial<LivePrediction>): LivePrediction {
  const made: LivePrediction = {
    tripId,
    routeId: '31009',
    lineId: 'GREEN',
    stopId,
    stationKey: 'rail:government-ctr',
    epoch: null,
    scheduledEpoch: null,
    delayS: null,
    realtime: true,
    canceled: false,
    headsign: 'Dadeland South',
    ...fields,
  };
  expect(made.tripId).toBe(tripId);
  // A cancellation says no time: the train is not coming.
  expect(made.canceled && made.epoch !== null).toBe(false);
  return made;
}

describe('the departures hurry-or-chill weighs (M7c.3)', () => {
  it('never offers a canceled departure', () => {
    const scheduled = [departure('T1', '9512', 120), departure('T2', '9512', 420), departure('T3', '9512', 900)];
    const rows = mergeDepartures(scheduled, [prediction('T1', '9512', { canceled: true, realtime: false })], WINDOW).rows;
    // Merge rule 6 keeps the canceled train on the board, struck through…
    expect(rows.map((row) => [row.tripId, row.canceled])).toEqual([['T1', true], ['T2', false], ['T3', false]]);
    const offered = hurryDepartures(rows, { stopIds: ['9512'], now: NOW, liveStale: false });
    // …but the verdict is never about it: the next train is T2.
    expect(offered.map((d) => d.epoch)).toEqual([NOW + 420, NOW + 900]);
    expect(hurryVerdict({ now: NOW, walkMeters: 400, departures: offered }).departure?.epoch).toBe(NOW + 420);
  });

  it('keeps only the rider\'s platforms and trains still to leave, earliest first', () => {
    const scheduled = [departure('T4', '9512', -60), departure('T5', '9513', 200, 1), departure('T6', '9512', 300), departure('T7', '9512', 600)];
    const rows = mergeDepartures(scheduled, [prediction('T7', '9512', { epoch: NOW + 240 })], WINDOW).rows;
    const offered = hurryDepartures(rows, { stopIds: ['9512'], now: NOW, liveStale: false });
    // T7 runs early (live, 240 s) and now leads; T4 has gone; T5 boards at the other platform.
    expect(offered.map((d) => [d.epoch, d.live])).toEqual([[NOW + 240, true], [NOW + 300, false]]);
    expect(offered[0]).toMatchObject({ lineId: 'GREEN', headsign: 'Dadeland South', stale: false, key: '20260930:T7:9512' });
  });

  it('marks live departures stale when the live data is past its fresh limit, never scheduled ones', () => {
    const scheduled = [departure('T8', '9512', 300), departure('T9', '9512', 600)];
    const rows = mergeDepartures(scheduled, [prediction('T8', '9512', { epoch: NOW + 330 })], WINDOW).rows;
    const stale = hurryDepartures(rows, { stopIds: ['9512'], now: NOW, liveStale: true });
    expect(stale.map((d) => [d.live, d.stale])).toEqual([[true, true], [false, false]]);
    expect(hurryVerdict({ now: NOW, walkMeters: 400, departures: stale }).confidence).toBe('low');
  });
});
