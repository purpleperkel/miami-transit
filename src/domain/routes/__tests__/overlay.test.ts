import { haversineMeters } from '../../../lib/geo';
import { HURRY_DEFAULTS } from '../../hurry/verdict';
import type { LivePrediction } from '../../live/types';
import fixture from '../__fixtures__/transitous-plan.json';
import { firstLegVerdict, overlayLive } from '../overlay';
import { type Itinerary, type Leg, parseItineraries } from '../transitous';

/**
 * Plan M10a.2 A on the REAL fixture's ids: m4a's predictions carry plain GTFS ids, Transitous prefixes
 * them (`20261002_14:06_us-fl-miami-dade_4829294`, `us-fl-miami-dade_813`), and the overlay matches on
 * (trip_id, boarding stop_id). The verdict cases run m7c's engine with its defaults (detour 1.3, walk
 * 1.35 m/s, jog 2.7 m/s, 30 s to board).
 */

/** The fixture's itineraries, parsed (the parser is M10a.1's, tested on its own). */
function itineraries(): readonly Itinerary[] {
  const parsed = parseItineraries(fixture as unknown);
  expect(parsed.ok).toBe(true);
  const value = parsed.ok ? parsed.value : [];
  expect(value.length).toBeGreaterThanOrEqual(3);
  return value;
}

/** The first leg of `mode` + `route` in the fixture, with the indices of every itinerary riding its trip. */
function legOf(its: readonly Itinerary[], mode: string, route: string): { leg: Leg; riders: number[] } {
  const leg = its.flatMap((it) => it.legs).find((l) => l.mode === mode && l.routeShortName === route);
  expect(leg?.tripId).toEqual(expect.any(String));
  const riders = its.flatMap((it, i) => (it.legs.some((l) => l.tripId === leg?.tripId) ? [i] : []));
  expect(riders.length).toBeGreaterThan(0);
  return { leg: leg as Leg, riders };
}

/** m4a's realtime prediction (plain GTFS ids) for a leg's trip at `stopId` (Transitous-prefixed), departing `epoch`. */
function prediction(leg: Leg, stopId: string, epoch: number, over: Partial<LivePrediction> = {}): LivePrediction {
  const tripId = (leg.tripId ?? '').replace(/^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/, '');
  const stop = stopId.replace(/^[A-Za-z0-9-]+_/, '');
  expect(tripId).toMatch(/^\d+$/);
  expect(stop).toMatch(/^\d+$/);
  return { tripId, routeId: '31009', lineId: null, stopId: stop, stationKey: null, epoch, scheduledEpoch: epoch - 150, delayS: 150, realtime: true, canceled: false, headsign: leg.headsign, ...over };
}

describe('live overlay, matched legs (M10a.2)', () => {
  it('matched leg -> live departure, marked live', () => {
    const its = itineraries();
    const before = JSON.stringify(its);
    const rail = legOf(its, 'REGIONAL_RAIL', '2600');
    const mover = legOf(its, 'TRAM', 'MMO');
    const railLive = rail.leg.from.epoch + 150;
    const moverLive = mover.leg.from.epoch + 90;
    const out = overlayLive(its, [prediction(rail.leg, rail.leg.from.stopId ?? '', railLive), prediction(mover.leg, mover.leg.from.stopId ?? '', moverLive)]);
    expect(JSON.stringify(its)).toBe(before);
    // The rail trip is shared by several itineraries: it goes live in every one of them.
    expect(rail.riders.length).toBeGreaterThanOrEqual(2);
    for (const i of rail.riders) {
      const leg = out[i]?.legs.find((l) => l.tripId === rail.leg.tripId);
      expect(leg).toEqual({ ...rail.leg, from: { ...rail.leg.from, epoch: railLive }, live: true });
    }
    const movedMover = out[mover.riders[0] as number]?.legs.find((l) => l.tripId === mover.leg.tripId);
    expect(movedMover?.from.epoch).toBe(moverLive);
    expect(movedMover?.live).toBe(true);
    expect(movedMover?.to).toEqual(mover.leg.to);
  });
});

describe('live overlay, unmatched legs (M10a.2)', () => {
  it('unmatched leg -> unchanged', () => {
    const its = itineraries();
    const rail = legOf(its, 'REGIONAL_RAIL', '2600').leg;
    const at = rail.from.epoch + 150;
    const boarding = rail.from.stopId ?? '';
    const ignored: readonly LivePrediction[][] = [
      [prediction(rail, boarding, at, { tripId: '999999999' })],
      [prediction(rail, boarding, at, { realtime: false, epoch: null, delayS: null })],
      [prediction(rail, boarding, at, { canceled: true })],
      [prediction(rail, rail.to.stopId ?? '', rail.to.epoch + 150)],
    ];
    for (const predictions of ignored) {
      expect(overlayLive(its, predictions)).toEqual(its);
    }
    // With the rail leg live, every other leg is the very same leg.
    const out = overlayLive(its, [prediction(rail, boarding, at)]);
    const others = out.flatMap((it, i) => it.legs.filter((l) => l.tripId !== rail.tripId).map((l, j) => [l, its[i]?.legs.filter((m) => m.tripId !== rail.tripId)[j]]));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every(([got, want]) => got === want)).toBe(true);
  });
});

describe('first-leg verdict (M10a.2)', () => {
  it('first-leg verdict near the stop -> CHILL', () => {
    const it = itineraries()[0] as Itinerary;
    const board = it.legs.find((l) => l.tripId !== null) as Leg;
    // 40 m north of the boarding stop, ten minutes before the train.
    const position = { latitude: board.from.latitude + 40 / 111_195, longitude: board.from.longitude };
    const verdict = firstLegVerdict(it, position, board.from.epoch - 600);
    expect(verdict?.kind).toBe('CHILL');
    expect(verdict?.departure?.epoch).toBe(board.from.epoch);
    expect(verdict?.walkS).toBeCloseTo((haversineMeters(position, board.from) * HURRY_DEFAULTS.detour) / HURRY_DEFAULTS.walkMps, 6);
  });

  it('first-leg verdict, only jogging makes it -> JOG', () => {
    const it = itineraries()[0] as Itinerary;
    const board = it.legs.find((l) => l.tripId !== null) as Leg;
    const position = { latitude: board.from.latitude + 300 / 111_195, longitude: board.from.longitude };
    const meters = haversineMeters(position, board.from) * HURRY_DEFAULTS.detour;
    const slack = (meters / HURRY_DEFAULTS.walkMps + meters / HURRY_DEFAULTS.jogMps) / 2;
    // A walk misses, a jog makes it, and no train follows in this leg: m7c says JOG.
    const verdict = firstLegVerdict(it, position, board.from.epoch - HURRY_DEFAULTS.boardBufferS - slack);
    expect(verdict?.kind).toBe('JOG');
    expect(verdict?.spareS).toBeCloseTo(slack - meters / HURRY_DEFAULTS.jogMps, 6);
    expect(verdict?.live).toBe(false);
  });

  it('a walk-only itinerary has no first-leg verdict', () => {
    const walk = itineraries()[0]?.legs[0] as Leg;
    expect(walk.mode).toBe('WALK');
    expect(firstLegVerdict({ startEpoch: walk.from.epoch, endEpoch: walk.to.epoch, durationS: walk.durationS, transfers: 0, legs: [walk] }, walk.from, walk.from.epoch)).toBeNull();
  });
});
