import { providerConfig } from '../../../domain/live/constants';
import { type DepartureRow as MergedRow, mergeDepartures } from '../../../domain/live/merge-departures';
import { formatClockFromServiceSec } from '../../format';
import { DEPARTED_AFTER_S, directionBoard, liveFreshness, predictionsForDirection, serviceSecond } from '../direction-board';
import { BASE_EPOCH, BOARD, NOW_S, SOUTHBOUND, batch, departure, prediction } from './board-fixtures';

/** M6.3 direction board: which predictions a direction keeps, what is still to leave, and how fresh it is. */

const A_0828 = departure('trip-a', 8, 28);
const B_0834 = departure('trip-b', 8, 34, 'GREEN');
const C_0846 = departure('trip-c', 8, 46);

describe('direction board: the predictions a direction keeps', () => {
  it('keeps its own trips and unknown trains at its platform, and leaves other directions their trips', () => {
    const own = prediction('trip-a', { epoch: A_0828.epoch + 120 });
    const wholeTripCanceled = prediction('trip-b', { stopId: null, canceled: true, realtime: false });
    const added = prediction('extra-1', { lineId: null, epoch: NOW_S + 600 });
    const otherDirection = prediction('trip-sb', { lineId: 'GREEN', stopId: SOUTHBOUND, epoch: NOW_S + 300 });
    const knownElsewhere = prediction('trip-z', { epoch: NOW_S + 400 });
    const ownTripOtherPlatform = prediction('trip-c', { stopId: SOUTHBOUND, epoch: NOW_S + 900 });
    const kept = predictionsForDirection([A_0828, B_0834, C_0846], [own, wholeTripCanceled, added, otherDirection, knownElsewhere, ownTripOtherPlatform]);
    expect(kept).toEqual([own, wholeTripCanceled, added]);
    expect(mergeDepartures([A_0828, B_0834, C_0846], kept, BOARD).unused).toBe(0);
  });

  it('a direction with no departures keeps no predictions', () => {
    expect(predictionsForDirection([], [prediction('extra-1', { lineId: null, epoch: NOW_S + 60 })])).toEqual([]);
    expect(predictionsForDirection([A_0828], [])).toEqual([]);
  });
});

describe('direction board: rows', () => {
  it('a late train found through the lookback stays on the board at its predicted time; departed rows leave', () => {
    const early = departure('trip-early', 8, 10);
    const late = departure('trip-late', 8, 12);
    const board = directionBoard({ departures: [early, late, A_0828], predictions: batch([prediction('trip-late', { epoch: NOW_S + 180 })]), window: BOARD, nowS: NOW_S, maxRows: 5 });
    expect(board.rows.map(({ row }) => row.tripId)).toEqual(['trip-late', 'trip-a']);
    expect(board.rows[0]?.row).toMatchObject({ live: true, epoch: NOW_S + 180, delayS: NOW_S + 180 - late.epoch });
  });

  it('a row reads Now until it is 30 s past its time, then leaves', () => {
    const due = departure('trip-due', 8, 20);
    const shown = directionBoard({ departures: [due], predictions: null, window: BOARD, nowS: NOW_S + DEPARTED_AFTER_S - 1, maxRows: 3 });
    const gone = directionBoard({ departures: [due], predictions: null, window: BOARD, nowS: NOW_S + DEPARTED_AFTER_S, maxRows: 3 });
    expect([shown.rows.length, gone.rows.length]).toEqual([1, 0]);
    expect(gone.sources).toEqual([]);
  });

  it('maxRows must be a positive whole number', () => {
    expect(() => directionBoard({ departures: [A_0828], predictions: null, window: BOARD, nowS: NOW_S, maxRows: 0 })).toThrow('positive whole number');
    expect(() => directionBoard({ departures: [A_0828], predictions: null, window: BOARD, nowS: NOW_S, maxRows: 2.5 })).toThrow('positive whole number');
  });
});

describe('direction board: clock times', () => {
  it('a delayed row moves its service second with the delay', () => {
    const merged = mergeDepartures([A_0828], [prediction('trip-a', { delayS: 300 })], BOARD);
    expect(merged.rows).toHaveLength(1);
    expect(serviceSecond(merged.rows[0] as MergedRow, [A_0828])).toBe(A_0828.depS + 300);
  });

  it('a live-only row reads its clock from the timetable service day, wrapping past midnight', () => {
    const lateNight = departure('trip-night', 23, 50);
    const added = prediction('extra-1', { lineId: null, epoch: BASE_EPOCH + 86400 + 2 * 3600 + 5 * 60 });
    const merged = mergeDepartures([lateNight], [added], { fromEpoch: lateNight.epoch, toEpoch: lateNight.epoch + 4 * 3600 });
    const row = merged.rows.find((candidate) => candidate.departure === null);
    expect(row).toBeDefined();
    expect(serviceSecond(row as MergedRow, [A_0828, lateNight])).toBe(86400 + 2 * 3600 + 5 * 60);
    expect(formatClockFromServiceSec(serviceSecond(row as MergedRow, [A_0828, lateNight]))).toBe('2:05 AM');
  });
});

describe('direction board: freshness', () => {
  it('live predictions turn stale past their provider fresh threshold', () => {
    const freshS = providerConfig('transitland').freshS;
    expect(liveFreshness(batch([], freshS), NOW_S)).toEqual({ kind: 'live' });
    expect(liveFreshness(batch([], freshS + 1), NOW_S)).toEqual({ kind: 'stale', ageS: freshS + 1 });
  });

  it('the header names live first, then scheduled, and the rows mix only when both are shown', () => {
    const mixed = directionBoard({ departures: [A_0828, B_0834], predictions: batch([prediction('trip-b', { lineId: 'GREEN', epoch: B_0834.epoch + 60 })]), window: BOARD, nowS: NOW_S, maxRows: 4 });
    expect([mixed.mixed, mixed.sources]).toEqual([true, [{ kind: 'live' }, { kind: 'scheduled' }]]);
    const capped = directionBoard({ departures: [A_0828, B_0834], predictions: batch([prediction('trip-b', { lineId: 'GREEN', epoch: B_0834.epoch + 60 })]), window: BOARD, nowS: NOW_S, maxRows: 1 });
    expect([capped.mixed, capped.sources]).toEqual([false, [{ kind: 'scheduled' }]]);
  });
});
