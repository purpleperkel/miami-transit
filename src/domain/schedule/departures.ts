import { invariant } from '../../lib/invariant';
import { isTimeWindow, type ServiceDay, type TimeWindow } from '../gtfs/service-day';

/**
 * Plan §4 "On-device engine — Departures" (M3.3): a station's scheduled departures in a window.
 * Pure: the schedule repo fetches each running service day's stop visits at the station, this
 * module assembles them.
 *
 *  - A departure's instant is `base_epoch + dep_s` of ITS service day, so a Friday trip timed
 *    24:14 departs at Saturday 00:14 and is listed when Saturday's early hours are asked for.
 *  - A train whose trip ENDS at the station is not a departure from it: a Green Line train
 *    terminating at Dadeland South never appears as "to Dadeland South" there.
 */

/** One trip's scheduled stop at the station, as the schedule DB stores it (times in service-day seconds). */
export type StopVisit = {
  readonly tripIdx: number;
  readonly tripId: string;
  /** 0-based position of this stop in the trip. */
  readonly seq: number;
  /** The trip's final position (its pattern's stop count - 1). */
  readonly lastSeq: number;
  readonly depS: number;
  readonly stopId: string;
  readonly lineId: string;
  readonly directionId: number;
  readonly destStationKey: string;
  readonly destName: string;
  readonly note: string | null;
};

/** The visits fetched for one running service day. */
export type ServiceDayVisits = { readonly day: ServiceDay; readonly visits: readonly StopVisit[] };

export type Departure = {
  /** The service day (YYYYMMDD) the trip belongs to — the day BEFORE the clock date for a 24:xx trip. */
  readonly serviceDate: number;
  /** Absolute epoch second: the service day's base_epoch + depS. */
  readonly epoch: number;
  readonly depS: number;
  readonly tripIdx: number;
  readonly tripId: string;
  readonly stopId: string;
  readonly lineId: string;
  readonly directionId: number;
  readonly destStationKey: string;
  readonly destName: string;
  readonly note: string | null;
};

/** A trip's stop is a departure unless the trip ends there (terminating trains are arrivals only). */
export function isDeparture(visit: StopVisit): boolean {
  invariant(Number.isInteger(visit.seq) && visit.seq >= 0, `stop position ${visit.seq} is a 0-based index`);
  invariant(visit.seq <= visit.lastSeq, `trip ${visit.tripId} stops at position ${visit.seq} of ${visit.lastSeq}`);
  return visit.seq < visit.lastSeq;
}

/** Every departure inside `window` across the running service days, earliest first (ties by trip). */
export function assembleDepartures(window: TimeWindow, days: readonly ServiceDayVisits[]): Departure[] {
  invariant(isTimeWindow(window), 'assembleDepartures needs a valid window');
  invariant(days.every((d, i) => i === 0 || days[i - 1]!.day.date < d.day.date), 'service days come in date order, each once');
  const departures: Departure[] = [];
  for (const { day, visits } of days) {
    for (const visit of visits) {
      const epoch = day.baseEpoch + visit.depS;
      if (isDeparture(visit) && epoch >= window.fromEpoch && epoch <= window.toEpoch) {
        departures.push(toDeparture(day, visit));
      }
    }
  }
  departures.sort((a, b) => a.epoch - b.epoch || a.serviceDate - b.serviceDate || a.tripIdx - b.tripIdx);
  invariant(departures.every((d, i) => i === 0 || departures[i - 1]!.epoch <= d.epoch), 'departures are in time order');
  return departures;
}

function toDeparture(day: ServiceDay, visit: StopVisit): Departure {
  invariant(Number.isSafeInteger(day.baseEpoch), `service day ${day.date} has a whole base epoch`);
  invariant(Number.isInteger(visit.depS) && visit.depS >= 0, `trip ${visit.tripId} departs at a service-day second`);
  const { tripIdx, tripId, depS, stopId, lineId, directionId, destStationKey, destName, note } = visit;
  return {
    serviceDate: day.date,
    epoch: day.baseEpoch + depS,
    depS,
    tripIdx,
    tripId,
    stopId,
    lineId,
    directionId,
    destStationKey,
    destName,
    note,
  };
}
