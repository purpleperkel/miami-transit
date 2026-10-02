import { windowFrom } from '../../../domain/gtfs/service-day';
import type { LiveBatch, LivePrediction } from '../../../domain/live/types';
import type { Departure } from '../../../domain/schedule/departures';
import type { Ride } from '../../../domain/schedule/rides';
import { closeTripDbs, realScheduleRepo, WED_0130, WED_0800 } from '../../trips/__tests__/trip-db';
import { type TripVerdict, tripVerdict, type TripVerdictInput } from '../trip-verdict';

/**
 * mfix8, the pure half of the Now bar's verdict, over the REAL committed schedule DB at 08:00 on Wednesday
 * 2026-09-30: Jamie's trip Brickell City Centre → Bayfront Park, the rider at P (301 m from its platforms). A live
 * prediction moves a ride only when it is for THAT ride's own GTFS trip; at night the verdict is NO_SERVICE; a
 * pair no direct ride joins has no verdict at all.
 */

const P = { latitude: 25.769, longitude: -80.194 };
const BCC = 'mover:brickell-city-centre';
const BAYFRONT = 'mover:bayfront-park';
const PACE = { walkMps: 1.35, jogMps: 2.7 };

afterAll(() => closeTripDbs());

/** The trip's verdict with `batch` (and anything else changed). */
function judge(batch: LiveBatch<LivePrediction> | null, extra: Partial<TripVerdictInput> = {}): TripVerdict | null {
  const judged = tripVerdict(realScheduleRepo(), { from: BCC, to: BAYFRONT, position: P, nowS: WED_0800, pace: PACE, batch, ...extra });
  expect(judged === null || judged.ctx.now === (extra.nowS ?? WED_0800)).toBe(true);
  expect(judged === null || judged.walkMeters > 0).toBe(true);
  return judged;
}

/** A Transitland batch of `items`, fetched `ageS` seconds before 08:00. */
function batch(items: readonly LivePrediction[], ageS = 0): LiveBatch<LivePrediction> {
  expect(ageS).toBeGreaterThanOrEqual(0);
  expect(items.every((item) => item.tripId !== null)).toBe(true);
  return { items, feedTimestamp: WED_0800 - ageS, dropped: {}, provider: 'transitland', fetchedAt: WED_0800 - ageS, bytes: 1 };
}

/** A realtime prediction for departure `d`, `delayS` late (or a cancellation). */
function predicted(d: Departure, delayS: number, canceled = false): LivePrediction {
  expect(d.tripId.length).toBeGreaterThan(0);
  expect(Number.isSafeInteger(delayS)).toBe(true);
  return { tripId: d.tripId, routeId: d.lineId, lineId: null, stopId: d.stopId, stationKey: BCC, epoch: d.epoch + delayS, scheduledEpoch: d.epoch, delayS, realtime: true, canceled, headsign: null };
}

/** The trip's first ride from 08:00, its own departure at Brickell City Centre, and a departure there of another trip, the other way. */
function firstRideAndAnother(): { readonly ride: Ride; readonly own: Departure; readonly other: Departure } {
  const repo = realScheduleRepo();
  const rides = repo.tripRides(BCC, BAYFRONT, windowFrom(WED_0800, 3 * 3600));
  const ride = rides.ok && rides.value.kind === 'rides' ? rides.value.rides[0] : undefined;
  const read = repo.departures(BCC, windowFrom(WED_0800, 3 * 3600));
  const departures = read.ok && read.value.kind === 'departures' ? read.value.departures : [];
  const own = departures.find((d) => d.tripIdx === ride?.boardTripIdx && d.stopId === ride?.boardStopId);
  const other = departures.find((d) => d.stopId !== ride?.boardStopId && d.epoch >= WED_0800);
  expect([ride, own, other].every((found) => found !== undefined)).toBe(true);
  expect(other?.tripId).not.toBe(own?.tripId);
  return { ride: ride as Ride, own: own as Departure, other: other as Departure };
}

describe('the trip verdict and the live times it takes (mfix8)', () => {
  it('a live time for the trip\'s own ride moves its verdict; another trip\'s never does', () => {
    const { ride, own, other } = firstRideAndAnother();
    const scheduled = judge(null);
    expect([scheduled?.verdict.departure?.epoch, scheduled?.verdict.live]).toEqual([ride.depEpoch, false]);
    // The ride itself, 150 s late: the verdict is about its live time.
    const late = judge(batch([predicted(own, 150)]));
    expect([late?.verdict.departure?.epoch, late?.verdict.departure?.live, late?.verdict.departure?.stale]).toEqual([ride.depEpoch + 150, true, false]);
    // The other direction's train, 10 min late, at another platform of the station: nothing moves. Nor does a train
    // the timetable does not know, live at the ride's own platform a minute from now — nobody knows where it goes.
    expect(judge(batch([predicted(other, 600)]))?.verdict).toEqual(scheduled?.verdict);
    const unknown = { ...predicted(own, 0), tripId: 'added-train', epoch: WED_0800 + 60, scheduledEpoch: null, delayS: null };
    expect(judge(batch([unknown]))?.verdict).toEqual(scheduled?.verdict);
    // A live time 4 min old is past Transitland's 180 s fresh limit: still used, but stale.
    expect(judge(batch([predicted(own, 150)], 240))?.verdict.departure?.stale).toBe(true);
  });

  it('a canceled ride drops out of the trip verdict', () => {
    const { ride, own } = firstRideAndAnother();
    const canceled = judge(batch([predicted(own, 0, true)]));
    expect(canceled?.verdict.departure?.epoch).not.toBe(ride.depEpoch);
    expect((canceled?.verdict.departure?.epoch ?? 0) > ride.depEpoch).toBe(true);
  });

  it('at night the trip verdict is no service, and a pair needing a transfer has none', () => {
    expect(judge(null, { nowS: WED_0130 })?.verdict.kind).toBe('NO_SERVICE');
    // Dadeland South → Bayfront Park needs a change of train (m7b's Trips tab fixture): nothing to judge.
    expect(judge(null, { from: 'rail:dadeland-south' })).toBeNull();
  });
});
