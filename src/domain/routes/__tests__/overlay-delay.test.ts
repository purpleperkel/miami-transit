import type { LivePrediction } from '../../live/types';
import fixture from '../__fixtures__/transitous-plan.json';
import { overlayLive } from '../overlay';
import { type Itinerary, type Leg, parseItineraries } from '../transitous';

/**
 * mfix5 on the committed fixture (Government Center → Brickell, 2026-10-02 2:00 PM): a late train's delay
 * follows the rider. The Orange train (trip 6283593, Government Center 2:12 → Brickell 2:14) is ridden by
 *   RAIL_ONLY  walk → Orange → walk 2:14–2:28                                   (no transfer)
 *   RAIL_BUS   walk → Orange → walk 2:14–2:16 → bus 26 2:17–2:19 → walk         (60 s of transfer slack)
 * and is predicted by a synthetic m4a-shaped realtime prediction (plain GTFS ids) at its BOARDING stop.
 */

type Fixture = { readonly its: readonly Itinerary[]; readonly railOnly: number; readonly railBus: number; readonly rail: Leg };

/** The parsed fixture and the two itineraries riding the Orange train, found by their legs' shape. */
function orangeFixture(): Fixture {
  const parsed = parseItineraries(fixture as unknown);
  expect(parsed.ok).toBe(true);
  const its = parsed.ok ? parsed.value : [];
  const shapes = its.map((it) => it.legs.map((l) => (l.tripId === null ? 'WALK' : `${l.mode} ${l.routeShortName}`)).join(' > '));
  const railOnly = shapes.indexOf('WALK > REGIONAL_RAIL 2600 > WALK');
  const railBus = shapes.indexOf('WALK > REGIONAL_RAIL 2600 > WALK > BUS 26 > WALK');
  expect([railOnly, railBus].every((i) => i >= 0)).toBe(true);
  const rail = its[railOnly]?.legs[1] as Leg;
  expect(its[railBus]?.legs[1]?.tripId).toBe(rail.tripId);
  expect((its[railBus]?.legs[3]?.from.epoch ?? 0) - (its[railBus]?.legs[2]?.to.epoch ?? 0)).toBe(60);
  return { its, railOnly, railBus, rail };
}

/** m4a's realtime prediction for `rail` at its boarding stop, `lateS` seconds late. */
function late(rail: Leg, lateS: number): LivePrediction {
  const tripId = (rail.tripId ?? '').replace(/^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/, '');
  const stopId = (rail.from.stopId ?? '').replace(/^[A-Za-z0-9-]+_/, '');
  expect(tripId).toBe('6283593');
  expect(stopId).toMatch(/^\d+$/);
  return { tripId, routeId: '31009', lineId: null, stopId, stationKey: null, epoch: rail.from.epoch + lateS, scheduledEpoch: rail.from.epoch, delayS: lateS, realtime: true, canceled: false, headsign: rail.headsign };
}

/** `got` is `want` with both ends moved `byS` seconds and the same duration. */
function expectMoved(got: Leg | undefined, want: Leg | undefined, byS: number): void {
  expect([got?.from.epoch, got?.to.epoch]).toEqual([(want?.from.epoch ?? NaN) + byS, (want?.to.epoch ?? NaN) + byS]);
  expect(got?.durationS).toBe((got?.to.epoch ?? NaN) - (got?.from.epoch ?? NaN));
}

describe('the live overlay moves a late ride whole (mfix5)', () => {
  it('a 120 s late first leg shifts its departure and arrival by 120 s', () => {
    const { its, railOnly, railBus, rail } = orangeFixture();
    const before = JSON.stringify(its);
    const out = overlayLive(its, [late(rail, 120)]);
    expect(JSON.stringify(its)).toBe(before);
    for (const i of [railOnly, railBus]) {
      // The Orange leg is each itinerary's first ride: 2:12 → 2:14 becomes 2:14 → 2:16, and it is live.
      expect(out[i]?.legs.findIndex((l) => l.tripId !== null)).toBe(1);
      expectMoved(out[i]?.legs[1], its[i]?.legs[1], 120);
      expect(out[i]?.legs[1]?.live).toBe(true);
    }
  });
});

describe('the live overlay carries the delay on (mfix5)', () => {
  it('a late leg carries its delay to later legs until a transfer absorbs it', () => {
    const { its, railOnly, railBus, rail } = orangeFixture();
    const out = overlayLive(its, [late(rail, 45)]);
    const [got, want] = [out[railBus], its[railBus]];
    // 45 s late: the walk to bus 26 starts and ends 45 s later; the bus (60 s of slack) still leaves on time.
    expectMoved(got?.legs[2], want?.legs[2], 45);
    expect(got?.legs[3]).toBe(want?.legs[3]);
    expect(got?.legs[4]).toBe(want?.legs[4]);
    expect(got?.legs[3]?.live).toBe(false);
    expect([got?.endEpoch, got?.connectionAtRisk]).toEqual([want?.endEpoch, undefined]);
    // Without a transfer, the delay reaches the door.
    expectMoved(out[railOnly]?.legs[2], its[railOnly]?.legs[2], 45);
  });

  it('a late leg that overruns the transfer slack keeps bus 26 on schedule and flags the connection', () => {
    const { its, railOnly, railBus, rail } = orangeFixture();
    const out = overlayLive(its, [late(rail, 120)]);
    const [got, want] = [out[railBus], its[railBus]];
    // 120 s late, the rider reaches bus 26's stop 60 s after it leaves: a bus does not wait for a late train.
    expectMoved(got?.legs[2], want?.legs[2], 120);
    expect([got?.legs[3], got?.legs[4]]).toEqual([want?.legs[3], want?.legs[4]]);
    expect([got?.legs[3]?.live, got?.legs[4]?.live]).toEqual([false, false]);
    expect(got?.connectionAtRisk).toEqual({ legIndex: 3, line: '26' });
    expect(got?.endEpoch).toBe(want?.endEpoch);
    expect(out[railOnly]?.connectionAtRisk).toBeUndefined();
  });
});

describe('the live overlay keeps the itinerary totals honest (mfix5)', () => {
  it('a late leg recomputes the itinerary arrival and duration', () => {
    const { its, railOnly, rail } = orangeFixture();
    const out = overlayLive(its, [late(rail, 120)]);
    const [got, want] = [out[railOnly] as Itinerary, its[railOnly] as Itinerary];
    // Walk 2:07, Orange 2:14 → 2:16 (was 2:12 → 2:14), walk to Brickell 2:30 (was 2:28): 23 min, not 21.
    expect(got.startEpoch).toBe(want.startEpoch);
    expect(got.endEpoch).toBe(want.endEpoch + 120);
    expect(got.endEpoch).toBe(got.legs[got.legs.length - 1]?.to.epoch);
    expect(got.durationS).toBe(want.durationS + 120);
    expect(got.durationS).toBe(got.endEpoch - got.startEpoch);
    // Itineraries not riding the train are the very same objects.
    expect(out.filter((it, i) => it === its[i])).toHaveLength(its.length - 2);
  });
});
