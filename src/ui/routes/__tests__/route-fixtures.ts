import type { LineId } from '../../../domain/lines/line-catalog';
import type { LivePrediction } from '../../../domain/live/types';
import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import { type Itinerary, type Leg, parseItineraries } from '../../../domain/routes/transitous';
import { clockFor } from '../../hurry/hurry-reading';
import type { PlaceNames, RouteNetwork } from '../route-options';

/**
 * Shared by the route options tests (M10b): m10a's REAL Transitous fixture — Government Center → Brickell,
 * asked for 2026-10-02 18:00 UTC (2:00 PM in Miami) — and the schedule facts the sheet reads about it.
 * The trip lines and stop stations below were read from assets/db/schedule.db on 2026-10-02:
 *   trips 4829294–4829297 → MM_BRICKELL, 6283593 → ORANGE (the bus trip 6314018 is not in it)
 *   stops 813 → mover:government-center, 821 → mover:financial-district, 9512 → rail:government-ctr,
 *         9514 → rail:brickell (the bus stops 78 and 6823 are not in it)
 * and 2026-10-02's service-day base (local midnight) is 1790913600.
 */

/** 2026-10-02's service-day base epoch (schedule.db service_day). */
export const BASE_20261002 = 1_790_913_600;
/** The fixture's query time: 2026-10-02T18:00:00Z, 2:00 PM in Miami. */
export const ASKED_AT_S = BASE_20261002 + 14 * 3600;
/** The fixture's query start (its first walk leg's "START"). */
export const START = { latitude: 25.7745, longitude: -80.1953 };
/** The fixture's query end, Brickell ("END"). */
export const END = { name: 'Brickell', lat: 25.7584, lon: -80.1937 };

const TRIP_LINES: ReadonlyMap<string, LineId> = new Map([
  ['4829294', 'MM_BRICKELL'],
  ['4829295', 'MM_BRICKELL'],
  ['4829296', 'MM_BRICKELL'],
  ['4829297', 'MM_BRICKELL'],
  ['6283593', 'ORANGE'],
]);
const STOP_STATIONS: ReadonlyMap<string, string> = new Map([
  ['813', 'mover:government-center'],
  ['821', 'mover:financial-district'],
  ['9512', 'rail:government-ctr'],
  ['9514', 'rail:brickell'],
]);

/** The schedule facts for the fixture's trips and stops. */
export const FIXTURE_NETWORK: RouteNetwork = Object.freeze({
  lineOfTrip: (tripId: string) => TRIP_LINES.get(tripId) ?? null,
  stationOfStop: (stopId: string) => STOP_STATIONS.get(stopId) ?? null,
});

/** The names the sheet gives the fixture trip's ends and stations. */
export const FIXTURE_NAMES: PlaceNames = Object.freeze({
  origin: 'Your location',
  destination: 'Brickell',
  stations: new Map([
    ['mover:government-center', 'Government Center'],
    ['mover:financial-district', 'Financial District'],
    ['rail:government-ctr', 'Government Center'],
    ['rail:brickell', 'Brickell'],
  ]),
});

/** Miami clock times for the fixture's day, from its service-day base (as the sheet makes them). */
export const FIXTURE_CLOCK = clockFor([BASE_20261002]);

/** The fixture's itineraries, parsed by m10a's parser, in Transitous's order. */
export function fixtureItineraries(): readonly Itinerary[] {
  const parsed = parseItineraries(fixture as unknown);
  expect(parsed.ok).toBe(true);
  const itineraries = parsed.ok ? parsed.value : [];
  expect(itineraries).toHaveLength(6);
  return itineraries;
}

/** The fixture's first leg riding `routeShortName` ("MMO" the Mover, "2600" Metrorail, "26" the bus). */
export function fixtureLeg(routeShortName: string): Leg {
  const leg = fixtureItineraries()
    .flatMap((itinerary) => itinerary.legs)
    .find((candidate) => candidate.routeShortName === routeShortName);
  expect(leg).toBeDefined();
  expect(leg?.tripId).toEqual(expect.any(String));
  return leg as Leg;
}

/** m4a's realtime prediction (plain GTFS ids) for `leg`'s trip at its boarding stop, `lateS` late. */
export function livePrediction(leg: Leg, lateS: number): LivePrediction {
  const tripId = (leg.tripId ?? '').replace(/^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/, '');
  const stopId = (leg.from.stopId ?? '').replace(/^[A-Za-z0-9-]+_/, '');
  expect(tripId).toMatch(/^\d+$/);
  expect(stopId).toMatch(/^\d+$/);
  const epoch = leg.from.epoch + lateS;
  return { tripId, routeId: '31009', lineId: null, stopId, stationKey: null, epoch, scheduledEpoch: leg.from.epoch, delayS: lateS, realtime: true, canceled: false, headsign: leg.headsign };
}
