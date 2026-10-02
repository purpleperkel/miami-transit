import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { UserDbProvider } from '../../../data/user-db-provider';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { hurryShort } from '../../hurry/copy';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { closeTripDbs, memoryUserRepos, nodeBackedDatabase } from '../../trips/__tests__/trip-db';
import { TripsTab } from '../../trips/TripsTab';
import { ItineraryDetail } from '../ItineraryDetail';
import { CHIP_ROUTED_START_M, type RouteOption, routeOptions } from '../route-options';
import { RouteOptionsList } from '../RouteOptionsList';
import { ASKED_AT_S, FIXTURE_CLOCK, FIXTURE_NAMES, FIXTURE_NETWORK, fixtureItineraries, START } from './route-fixtures';

// test-time mock of native module
jest.mock('expo-crypto', () => ({ randomUUID: mockRandomUUID }));
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: () => Promise.resolve({ granted: false, status: 'denied', canAskAgain: false }) }));

/**
 * mfix8 on m10a's REAL Transitous answer (Government Center → Brickell, asked at 2:00 PM on 2026-10-02):
 *   (B) the hurry chip walks the walk Transitous ROUTED to the first ride while the rider is still where the plan
 *       starts (within CHIP_ROUTED_START_M), and the straight line from the rider once they have moved on;
 *   (A) a one-ride option saves as a trip — the REAL ItineraryDetail and the REAL Trips tab over one in-memory user
 *       DB (the app's migrations and repos), the Trips tab reading the REAL committed schedule DB — and an option
 *       of several rides says why it cannot be one.
 */

const PACE = { walkMps: 1.35, jogMps: 2.7 };
const UUID = '6f1c2a4e-8b3d-4e5f-9a7b-0c1d2e3f4a5b';
let mockCopy: SQLiteDatabase | null = null;

/** test-time mock of native module: expo-crypto's UUID (the saved trip's id). */
function mockRandomUUID(): string {
  expect(UUID).toMatch(/^[0-9a-f-]{36}$/);
  expect(typeof UUID).toBe('string');
  return UUID;
}

/** test-time mock of native module: expo-sqlite's provider, with the schedule copy already open. */
function mockSQLiteProvider({ children }: { readonly children?: ReactNode }) {
  expect(children).toBeDefined();
  expect(SCHEDULE_DB_NAME.length).toBeGreaterThan(0);
  return <>{children}</>;
}

/** test-time mock of native module: the open copy — the committed schedule DB, read through node:sqlite. */
function mockScheduleCopy(): SQLiteDatabase {
  mockCopy ??= { ...nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true), databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}` } as SQLiteDatabase;
  expect(mockCopy).not.toBeNull();
  expect(mockCopy.databasePath).toContain(SCHEDULE_DB_NAME);
  return mockCopy;
}

afterEach(async () => unmountAll());
afterAll(() => closeTripDbs());

/** The options with the rider at `rider`, at the fixture's query time, at Jamie's default paces. */
function optionsFrom(rider: LatLon): RouteOption[] {
  const options = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, { position: rider, nowS: ASKED_AT_S, pace: PACE });
  expect(options).toHaveLength(6);
  expect(options.every((option) => option.itinerary.legs.length > 0)).toBe(true);
  return options;
}

/** A rider `metres` due south of the plan's start. */
function southOfStart(metres: number): LatLon {
  const perDegree = haversineMeters(START, { latitude: START.latitude + 1, longitude: START.longitude });
  const rider = { latitude: START.latitude - metres / perDegree, longitude: START.longitude };
  expect(haversineMeters(START, rider)).toBeCloseTo(metres, 3);
  expect(perDegree).toBeGreaterThan(100_000);
  return rider;
}

/** The rides of an option (legs with a trip). */
function ridesOf(option: RouteOption): number {
  const rides = option.itinerary.legs.filter((leg) => leg.tripId !== null).length;
  expect(rides).toBeLessThanOrEqual(option.itinerary.legs.length);
  expect(option.id).toBeGreaterThanOrEqual(0);
  return rides;
}

describe('the route chip walks the routed walk (mfix8)', () => {
  it('the hurry chip walks the routed first walk leg', async () => {
    // Option 0 (the 2:06 Mover) walks 324 m of streets to Government Center: 240 s at 1.35 m/s, with no detour
    // factor — where the straight line × 1.3 says 164.7 s.
    expect(CHIP_ROUTED_START_M).toBe(50);
    for (const metres of [0, 40, 49]) {
      const first = optionsFrom(southOfStart(metres))[0];
      expect([first?.itinerary.legs[0]?.mode, first?.itinerary.legs[0]?.distanceM, first?.verdict?.walkS.toFixed(1), first?.verdict?.jogS.toFixed(1)]).toEqual(['WALK', 324, '240.0', '120.0']);
    }
    // Beyond 50 m the routed legs no longer start where the rider is: the straight line from the rider, × 1.3.
    for (const metres of [51, 300]) {
      const rider = southOfStart(metres);
      const first = optionsFrom(rider)[0];
      const stop = first?.itinerary.legs[1]?.from;
      expect(first?.verdict?.walkS).toBeCloseTo((haversineMeters(rider, { latitude: stop?.latitude ?? 0, longitude: stop?.longitude ?? 0 }) * 1.3) / 1.35, 6);
    }
    // The REAL list shows each chip in the labelled short copy.
    const options = optionsFrom(START);
    const tree = await renderPrimitive(<RouteOptionsList options={options} clock={FIXTURE_CLOCK} nowS={ASKED_AT_S} onSelect={() => undefined} />);
    const chips = options.map((_, row) => hostsByTestID(tree.root, `route-option-${row}-hurry-text`)[0]?.props.children);
    expect(chips).toEqual(options.map((option) => (option.verdict === null ? undefined : hurryShort(option.verdict, { now: ASKED_AT_S, clock: FIXTURE_CLOCK }))));
    expect(chips[0]).toBe('Chill · 1 min spare');
  });
});

/** The REAL itinerary detail for `option` beside the REAL Trips tab, over one in-memory user DB. */
async function detailBesideTrips(option: RouteOption): Promise<{ readonly tree: ReactTestRenderer; readonly repos: ReturnType<typeof memoryUserRepos> }> {
  const repos = memoryUserRepos();
  const tree = await renderPrimitive(
    <UserLocationProvider><ScheduleDbProvider><UserDbProvider open={() => repos}>
      <ItineraryDetail option={option} network={FIXTURE_NETWORK} names={FIXTURE_NAMES} clock={FIXTURE_CLOCK} />
      <TripsTab clock={() => ASKED_AT_S} />
    </UserDbProvider></ScheduleDbProvider></UserLocationProvider>,
  );
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(hostsByTestID(tree.root, 'itinerary-detail')).toHaveLength(1);
  expect(repos.ok).toBe(true);
  return { tree, repos };
}

/** The text of the one host node with `testID`. */
function textOf(tree: ReactTestRenderer, testID: string): unknown {
  const nodes: ReactTestInstance[] = hostsByTestID(tree.root, testID);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.props.numberOfLines === undefined || nodes[0]?.props.numberOfLines === 1).toBe(true);
  return nodes[0]?.props.children;
}

describe('saving a route option as a trip (mfix8)', () => {
  it('a single-ride itinerary saves as a trip', async () => {
    const mover = optionsFrom(START).find((option) => ridesOf(option) === 1 && option.itinerary.legs.some((leg) => leg.routeShortName === 'MMO'));
    const { tree, repos } = await detailBesideTrips(mover as RouteOption);
    expect(JSON.stringify(tree.toJSON())).toContain('"No trips yet"');
    await press(tree, 'itinerary-save-trip');
    // m7b's trip: the ride's boarding and alighting stations, walked from wherever the phone is, no reminders.
    expect(repos.ok ? repos.value.trips.list() : null).toEqual([
      { id: UUID, name: 'Government Center → Financial District', fromStationKey: 'mover:government-center', toStationKey: 'mover:financial-district', start: null, walkOverrideMin: null, reminder: null, createdEpoch: expect.any(Number) },
    ]);
    // It says so, offers no second save, and the Trips tab — the same user DB — lists it with its countdown.
    expect([textOf(tree, 'itinerary-save-trip-saved'), hostsByTestID(tree.root, 'itinerary-save-trip').length]).toEqual(['Saved in Trips', 0]);
    expect(hostsByTestID(tree.root, `trip-card-${UUID}`).length).toBeGreaterThan(0);
  });

  it('a multi-ride itinerary offers no save and says why', async () => {
    const twoRides = optionsFrom(START).find((option) => ridesOf(option) === 2);
    const { tree, repos } = await detailBesideTrips(twoRides as RouteOption);
    expect(hostsByTestID(tree.root, 'itinerary-save-trip')).toHaveLength(0);
    expect(textOf(tree, 'itinerary-save-trip-why')).toBe('Saved trips are one ride; this route has 2.');
    expect(repos.ok ? repos.value.trips.list() : null).toEqual([]);
  });
});
