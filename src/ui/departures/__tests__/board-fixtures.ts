import { windowFrom } from '../../../domain/gtfs/service-day';
import type { LiveBatch, LivePrediction } from '../../../domain/live/types';
import type { Departure } from '../../../domain/schedule/departures';

/**
 * A departure board for the M6.3 tests: Wednesday 2026-10-01 at Government Center northbound
 * (platform stop 9513), EDT = UTC−4, the same synthetic shape as m4a's merge-departures test.
 */

export const SERVICE_DATE = 20261001;
/** The service day's base: local midnight, 04:00 UTC. */
export const BASE_EPOCH = Date.UTC(2026, 9, 1, 4, 0, 0) / 1000;
/** Now: 08:20 EDT. */
export const NOW_S = BASE_EPOCH + 8 * 3600 + 20 * 60;
/** The board's window: from 15 min back (a late train still matches its timetable slot) to an hour ahead. */
export const BOARD = windowFrom(NOW_S - 15 * 60, 75 * 60);
export const NORTHBOUND = '9513';
export const SOUTHBOUND = '9512';

/** A Government Center departure at hh:mm EDT on the northbound platform (Orange to the Airport unless told otherwise). */
export function departure(tripId: string, hh: number, mm: number, lineId = 'ORANGE', stopId = NORTHBOUND): Departure {
  const depS = hh * 3600 + mm * 60;
  const made: Departure = {
    serviceDate: SERVICE_DATE,
    epoch: BASE_EPOCH + depS,
    depS,
    tripIdx: depS,
    tripId,
    stopId,
    lineId,
    directionId: stopId === NORTHBOUND ? 1 : 0,
    destStationKey: lineId === 'ORANGE' ? 'rail:miami-international-airport' : 'rail:palmetto',
    destName: lineId === 'ORANGE' ? 'Airport' : 'Palmetto',
    note: null,
  };
  expect(made.epoch).toBe(Date.UTC(2026, 9, 1, hh + 4, mm, 0) / 1000);
  expect(made.epoch - BASE_EPOCH).toBe(depS);
  return made;
}

/** A realtime prediction for `tripId` at the northbound platform, with `fields` overriding. */
export function prediction(tripId: string | null, fields: Partial<LivePrediction>): LivePrediction {
  const made: LivePrediction = {
    tripId,
    routeId: '31009',
    lineId: 'ORANGE',
    stopId: NORTHBOUND,
    stationKey: 'rail:government-ctr',
    epoch: null,
    scheduledEpoch: null,
    delayS: null,
    realtime: true,
    canceled: false,
    headsign: null,
    ...fields,
  };
  expect(made.routeId).toBe('31009');
  expect(made.realtime || made.canceled || made.epoch === null).toBe(true);
  return made;
}

/** A Transitland predictions batch fetched `ageS` seconds before NOW_S. */
export function batch(items: readonly LivePrediction[], ageS = 20): LiveBatch<LivePrediction> {
  const made: LiveBatch<LivePrediction> = { provider: 'transitland', fetchedAt: NOW_S - ageS, bytes: 2048, feedTimestamp: null, dropped: {}, items };
  expect(made.fetchedAt).toBeLessThanOrEqual(NOW_S);
  expect(made.items).toHaveLength(items.length);
  return made;
}
