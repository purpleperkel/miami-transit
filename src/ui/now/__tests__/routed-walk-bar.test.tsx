import type { SQLiteDatabase } from 'expo-sqlite';
import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { UserDbProvider } from '../../../data/user-db-provider';
import { windowFrom } from '../../../domain/gtfs/service-day';
import type { LatLon } from '../../../lib/geo';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { closeTripDbs, memoryUserRepos, nodeBackedDatabase, realScheduleRepo, savedTrip } from '../../trips/__tests__/trip-db';
import { failingWalks, fixtureWalks, THIRD_STREET } from '../../walk/__tests__/fixture-walks';
import { RoutedWalkProvider, type WalkFetch } from '../../walk/RoutedWalkProvider';
import { NowAccessory } from '../NowAccessory';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockGrant, watchPositionAsync: mockWatch }));

/**
 * mfix9 D + E + F on the REAL Now bar (mfix8's near-trip verdict): Jamie's 09:12 bug — "chill" for Fifth Street, a walk
 * Google put at 11 min — in PUBLIC data. The rider stands at GTFS stop 815 (Third Street) with the saved trip Fifth
 * Street → Bayfront Park, at T = 05:26:50 on Wednesday 2026-09-30: 430 s before the first ride from platform 805
 * (05:34:00), so 400 s of slack once boarding is allowed for. The straight line (342 m) x m7c's 1.3 is a 5.5 min
 * walk: CHILL. The committed capture walks 710.6 m along the streets (9 min), and the 05:39 train follows within
 * m7c's 6 min: not worth hurrying. fetchWalk is INJECTED (fixture-walks.ts); the bar's walk is the provider's.
 */

const FIFTH = 'mover:fifth-street';
const BAYFRONT = 'mover:bayfront-park';
const T = Date.parse('2026-09-30T05:26:50-04:00') / 1000;
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
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
  expect(THIRD_STREET).toEqual({ latitude: 25.772024, longitude: -80.193508 });
  expect(AppState.currentState).toBe('active');
  return Promise.resolve({ granted: true, status: 'granted' });
}

/** test-time mock of native module: the one watch fixes the rider at Third Street at once. */
function mockWatch(_options: unknown, onFix: (fix: { coords: LatLon }) => void): Promise<{ remove: () => void }> {
  expect(typeof onFix).toBe('function');
  onFix({ coords: THIRD_STREET });
  expect(mockCopy).not.toBeNull();
  return Promise.resolve({ remove: () => undefined });
}

beforeEach(() => {
  Object.assign(AppState, { currentState: 'active' });
});
afterEach(async () => {
  await unmountAll();
});
afterAll(() => closeTripDbs());

/** The REAL bar in `placement` for the saved trip Fifth Street → Bayfront Park at T; under the walk provider when given a fetchWalk. */
async function bar(placement: 'regular' | 'inline', fetchWalk: WalkFetch | null): Promise<{ readonly lines: string[]; readonly label: string }> {
  const repos = memoryUserRepos();
  expect(repos.ok && repos.value.trips.create(savedTrip('fifth', FIFTH, BAYFRONT, { createdEpoch: 1_790_000_100 })).ok).toBe(true);
  const now = (
    <BottomAccessoryPlacementContext.Provider value={placement}>
      <NowAccessory clock={() => T} />
    </BottomAccessoryPlacementContext.Provider>
  );
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <UserDbProvider open={() => repos}>
          <LiveValueProvider value={NO_LIVE}>{fetchWalk === null ? now : <RoutedWalkProvider fetchWalk={fetchWalk}>{now}</RoutedWalkProvider>}</LiveValueProvider>
        </UserDbProvider>
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  const button = hostsByTestID(tree.root, 'now-accessory')[0] as ReactTestInstance;
  const texts = button.findAll((node) => (node.type as unknown) === 'Text');
  expect(texts.length).toBeGreaterThan(0);
  return { lines: texts.map((node) => String(node.props.children)), label: String(button.props.accessibilityLabel) };
}

describe('premise: Wednesday\'s first Fifth Street → Bayfront Park ride', () => {
  it('T is 430 s before the 05:34 ride from platform 805', () => {
    const rides = realScheduleRepo().tripRides(FIFTH, BAYFRONT, windowFrom(Date.parse('2026-09-30T04:00:00-04:00') / 1000, 4 * 3600));
    const from805 = rides.ok && rides.value.kind === 'rides' ? rides.value.rides.filter((ride) => ride.boardStopId === '805').map((ride) => ride.depEpoch) : [];
    expect(Math.min(...from805)).toBe(T + 430);
    expect(from805.filter((epoch) => epoch > T + 430 && epoch <= T + 430 + 360)).toHaveLength(1);
  });
});

describe('the Now bar walks along the streets (mfix9)', () => {
  it('the bar walks the routed fixture distance instead of the estimate', async () => {
    expect((await bar('regular', null)).lines).toEqual(['Bayfront Park', 'Chill · 1 min spare · ~6 min walk']);
    await unmountAll();
    const walks = fixtureWalks();
    expect((await bar('regular', walks.fetchWalk)).lines).toEqual(['Bayfront Park', 'Not worth it · ~9 min walk']);
    expect(walks.asked).toHaveLength(1);
    await unmountAll();
    expect((await bar('inline', fixtureWalks().fetchWalk)).lines).toEqual(['Not worth it']);
  });

  it('only an estimated walk is labelled estimated', async () => {
    const estimated = (await bar('regular', null)).label;
    await unmountAll();
    const routed = (await bar('regular', fixtureWalks().fetchWalk)).label;
    await unmountAll();
    const failed = failingWalks({ kind: 'http', status: 503, message: 'api.transitous.org answered HTTP 503' });
    const unanswered = (await bar('regular', failed.fetchWalk)).label;
    expect([estimated, routed, unanswered].map((label) => /\bestimated\b/i.test(label))).toEqual([true, false, true]);
    expect([estimated, routed, unanswered].map((label) => /walk along streets/i.test(label))).toEqual([false, true, false]);
    expect([estimated, routed]).toEqual([expect.stringContaining('an estimated 6-minute walk'), expect.stringContaining('a 9-minute walk along streets')]);
    expect(failed.asked).toHaveLength(1);
  });
});
