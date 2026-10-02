import { fetch as expoFetch } from 'expo/fetch';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import { type WalkCache, walkFor, type WalkStop } from '../../../domain/walk/walk-cache';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { hurryShort } from '../../hurry/copy';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { closeTripDbs, nodeBackedDatabase } from '../../trips/__tests__/trip-db';
import { DoubledWalks } from '../../walk/__tests__/fixture-walks';
import { RoutedWalkProvider } from '../../walk/RoutedWalkProvider';
import { PLAN_TICK_MS, PlanScreen } from '../PlanScreen';
import { recordRecentPlace } from '../recent-places';
import { CHIP_ROUTED_START_M, firstRideStops, type OptionContext, routeOptions } from '../route-options';
import { ASKED_AT_S, END, FIXTURE_CLOCK, FIXTURE_NETWORK, fixtureItineraries, START } from './route-fixtures';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockGrant, getCurrentPositionAsync: mockCurrent, watchPositionAsync: mockWatch }));

/**
 * mfix9 D on m10a's committed /plan fixture (Government Center → Brickell at 2:00 PM): off the itinerary's start, the
 * route chip walks the street-routed walk to its first ride's boarding stop (OptionContext.walk, the plan screen's
 * useWalkTo) instead of mfix5's straight line x 1.3; within CHIP_ROUTED_START_M of the start, mfix8's routed walk
 * legs still set it. Street walks here are synthetic: twice the straight line (DoubledWalks), injected as fetchWalk.
 */

const PACE = { walkMps: 1.35, jogMps: 2.7 };
const PER_DEGREE_M = haversineMeters(START, { latitude: START.latitude + 1, longitude: START.longitude });
let mockFix: LatLon | null = null;
const mockWatchers: ((fix: { coords: LatLon; timestamp: number }) => void)[] = [];
let mockCopy: SQLiteDatabase | null = null;

/** test-time mock of native module: expo-sqlite's provider, with the schedule copy already open. */
function mockSQLiteProvider({ children }: { readonly children?: ReactNode }) {
  expect(children).toBeDefined();
  expect(mockScheduleCopy().databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  return <>{children}</>;
}

/** test-time mock of native module: the open copy — the committed schedule DB, read through node:sqlite. */
function mockScheduleCopy(): SQLiteDatabase {
  mockCopy ??= { ...nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true), databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}` } as SQLiteDatabase;
  expect(mockCopy.databasePath).toContain(SCHEDULE_DB_NAME);
  expect(typeof mockCopy.getAllSync).toBe('function');
  return mockCopy;
}

/** test-time mock of native module: expo-location grants foreground location. */
function mockGrant(): Promise<{ granted: boolean; status: string }> {
  expect(mockFix).not.toBeNull();
  expect(AppState.currentState).toBe('active');
  return Promise.resolve({ granted: true, status: 'granted' });
}

/** test-time mock of native module: the sheet's one fix for a plan from the rider's location — at START, taken now. */
function mockCurrent(): Promise<{ coords: LatLon; timestamp: number }> {
  expect(mockWatchers.length).toBeLessThanOrEqual(1);
  expect(Date.now()).toBeGreaterThanOrEqual(ASKED_AT_S * 1000);
  return Promise.resolve({ coords: START, timestamp: Date.now() });
}

/** test-time mock of native module: the one watch, reporting the rider's fix at once (taken now) and every later move. */
function mockWatch(_options: unknown, onFix: (fix: { coords: LatLon; timestamp: number }) => void): Promise<{ remove: () => void }> {
  expect(mockWatchers).toHaveLength(0);
  mockWatchers.push(onFix);
  onFix({ coords: mockFix as LatLon, timestamp: Date.now() });
  expect(mockWatchers).toEqual([onFix]);
  return Promise.resolve({ remove: () => void mockWatchers.splice(mockWatchers.indexOf(onFix), 1) });
}

beforeEach(() => {
  Object.assign(AppState, { currentState: 'active' });
  jest.useFakeTimers({ now: ASKED_AT_S * 1000, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.mocked(expoFetch).mockClear().mockImplementation(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture) }) as unknown as Awaited<ReturnType<typeof expoFetch>>);
});
afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
});
afterAll(() => closeTripDbs());

/** `metres` due south of the fixture's START. */
function southOfStart(metres: number): LatLon {
  const rider = { latitude: START.latitude - metres / PER_DEGREE_M, longitude: START.longitude };
  expect(haversineMeters(START, rider)).toBeCloseTo(metres, 6);
  expect(metres > CHIP_ROUTED_START_M).toBe(true);
  return rider;
}

/** The chips' walk from `rider` over `cache` (what the provider's useWalkTo gives): walkFor to each first-ride stop. */
function walkFrom(rider: LatLon, cache: WalkCache | null): NonNullable<OptionContext['walk']> {
  const stops = new Map(firstRideStops(fixtureItineraries()).map((stop) => [stop.stopId, stop]));
  expect([...stops.keys()].sort()).toEqual(['813', '9512']);
  expect(cache === null || cache.paths.size === stops.size).toBe(true);
  return (stopId) => walkFor(cache, stops.get(stopId) as WalkStop, rider);
}

/** Every option's chip, in arrival order, for `context`. */
function chips(context: OptionContext): string[] {
  const shown = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, context).map((option) => (option.verdict === null ? '' : hurryShort(option.verdict, { now: context.nowS, clock: FIXTURE_CLOCK })));
  expect(shown.length).toBe(6);
  expect(shown.filter((chip) => chip.length > 0).length).toBeGreaterThanOrEqual(2);
  return shown;
}

/** The cache the provider holds once Transitous answered DoubledWalks from `rider` for the first rides' stops. */
function doubledCache(rider: LatLon, requestedAtS: number): WalkCache {
  const stops = firstRideStops(fixtureItineraries());
  expect(stops.length).toBe(2);
  expect(Number.isFinite(requestedAtS)).toBe(true);
  return { origin: rider, requestedAtS, paths: new Map(stops.map((stop) => [stop.stopId, { distanceM: 2 * haversineMeters(rider, stop), costS: 1 }])) };
}

describe('the route chip off the plan start (mfix9)', () => {
  it('a rider 300 m off the plan start gets the routed walk', () => {
    const rider = southOfStart(300);
    const routed = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, { position: rider, nowS: ASKED_AT_S, pace: PACE, walk: walkFrom(rider, doubledCache(rider, ASKED_AT_S)) });
    const boarding = routed.map((option) => option.itinerary.legs.find((leg) => leg.tripId !== null)?.from);
    // Each chip walks the street walk to its first ride's boarding stop (2x the straight line, no detour) at Jamie's pace.
    expect(routed.map((option) => option.verdict?.walkS)).toEqual(boarding.map((stop) => (stop === undefined ? undefined : (2 * haversineMeters(rider, stop)) / PACE.walkMps)));
    // Without a walk, or with only its estimate, the chip keeps mfix5's straight line x 1.3; the street walk reads otherwise.
    const straight = chips({ position: rider, nowS: ASKED_AT_S, pace: PACE });
    expect(chips({ position: rider, nowS: ASKED_AT_S, pace: PACE, walk: walkFrom(rider, null) })).toEqual(straight);
    expect(chips({ position: rider, nowS: ASKED_AT_S, pace: PACE, walk: walkFrom(rider, doubledCache(rider, ASKED_AT_S)) })).not.toEqual(straight);
  });

  it('at the plan start the routed walk legs still set the chip, whatever walk is handed in', () => {
    const atStart = chips({ position: START, nowS: ASKED_AT_S, pace: PACE });
    expect(chips({ position: START, nowS: ASKED_AT_S, pace: PACE, walk: walkFrom(START, doubledCache(START, ASKED_AT_S)) })).toEqual(atStart);
    // Option 0 boards the 2:06 Mover after the 324 m Transitous routed for its first walk leg.
    expect(atStart[0]).toBe('Chill · 1 min spare');
  });
});

/** The fake clock moved `seconds` times by 1 s, each in its own act (the repo's act() trap). */
async function step(seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
  }
  expect(Number.isSafeInteger(seconds) && seconds > 0).toBe(true);
  expect(Date.now()).toBe(until);
}

/** The rider moves to `at`: the one watch reports a fix taken now — after the sheet's own. */
async function moveRider(at: LatLon): Promise<void> {
  mockFix = at;
  expect(mockWatchers).toHaveLength(1);
  await act(async () => mockWatchers.forEach((onFix) => onFix({ coords: at, timestamp: Date.now() })));
  expect(mockFix).toBe(at);
}

/** The sheet's clock: it ticks every PLAN_TICK_MS from when it opened at ASKED_AT_S, so its chips count from the latest tick. */
function sheetNowS(): number {
  const ticks = Math.floor((Date.now() / 1000 - ASKED_AT_S) / (PLAN_TICK_MS / 1000));
  expect(ticks).toBeGreaterThanOrEqual(0);
  expect(PLAN_TICK_MS % 1000).toBe(0);
  return ASKED_AT_S + (ticks * PLAN_TICK_MS) / 1000;
}

/** Every chip the REAL sheet shows, in its rows' order. */
function shownChips(tree: Awaited<ReturnType<typeof renderPrimitive>>): string[] {
  const shown = hostsByTestID(tree.root, /^route-option-\d+-hurry-text$/).map((text) => String(text.props.children));
  expect(shown).toHaveLength(6);
  expect(hostsByTestID(tree.root, /^route-option-\d+$/)).toHaveLength(6);
  return shown;
}

/** The REAL sheet under the walk provider (fed `walks`), planning to Brickell (a recent place), its options in. */
async function planToBrickell(fromStation: string | null, walks: DoubledWalks): Promise<Awaited<ReturnType<typeof renderPrimitive>>> {
  expect(recordRecentPlace(END).ok).toBe(true);
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <RoutedWalkProvider fetchWalk={walks.fetchWalk}>
          <PlanScreen fromStation={fromStation} />
        </RoutedWalkProvider>
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await step(1);
  await press(tree, 'plan-recent-0');
  await step(4);
  expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(1);
  return tree;
}

describe('the plan screen asks for its chips\' street walks (mfix9; every plan, mfix8 F2)', () => {
  it('Route from here: the rider 400 m from the station walks the streets to each first ride', async () => {
    mockFix = { latitude: 25.775864 + 400 / 111_195, longitude: -80.196093 };
    const walks = new DoubledWalks();
    const tree = await planToBrickell('mover:government-center', walks);
    expect(walks.asked.map((asked) => [asked.one, asked.many.length])).toEqual([[mockFix, 2]]);
    expect(shownChips(tree)).toEqual(chips({ position: mockFix, nowS: sheetNowS(), pace: PACE, walk: walkFrom(mockFix, doubledCache(mockFix, ASKED_AT_S)) }));
  });

  it('a plan from the rider\'s own location walks the streets once the rider has walked off its start', async () => {
    mockFix = START;
    const walks = new DoubledWalks();
    const tree = await planToBrickell(null, walks);
    // At its start, the plan's first rides' two boarding stops are asked for from the rider; the chips walk the routed legs.
    expect(walks.asked.map((asked) => [asked.one, asked.many.length])).toEqual([[START, 2]]);
    expect(shownChips(tree)[0]).toBe('Chill · 1 min spare');
    // 320 m south: the walks were asked more than 300 m away, so until new ones come the chips say mfix5's estimate...
    const rider = southOfStart(320);
    await moveRider(rider);
    await step(1);
    const estimate = chips({ position: rider, nowS: sheetNowS(), pace: PACE });
    expect(shownChips(tree)).toEqual(estimate);
    // ...and once the 60 s gap since the first request ends, one more request from the rider brings the street walks.
    await step(61);
    expect(walks.asked.map((asked) => [asked.one, asked.many.length])).toEqual([[START, 2], [rider, 2]]);
    const routed = chips({ position: rider, nowS: sheetNowS(), pace: PACE, walk: walkFrom(rider, doubledCache(rider, ASKED_AT_S)) });
    expect(shownChips(tree)).toEqual(routed);
    expect(routed).not.toEqual(chips({ position: rider, nowS: sheetNowS(), pace: PACE }));
  });
});
