import { fetch as expoFetch } from 'expo/fetch';
import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { PlanScreen } from '../PlanScreen';
import { recordRecentPlace } from '../recent-places';
import { ASKED_AT_S, END } from './route-fixtures';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(), watchPositionAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * mfix5: "Route from here" plans from the station, but the first leg's hurry chip asks whether the RIDER
 * makes it — so it walks from where the app's one location module (use-user-location.ts) last fixed
 * them, and from the station only when there is no fix. The REAL sheet, under the REAL ScheduleDbProvider
 * reading the committed assets/db/schedule.db (expo-sqlite stood in for by node:sqlite on that file, as in
 * StationsScreen.test.tsx), asks for Government Center Mover → Brickell at 2:00 PM; Transitous answers
 * with the committed fixture, whose first option boards that very Mover at 2:06.
 */

type NodeStatement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type NodeDatabase = { prepare(sql: string): NodeStatement; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options: { readonly readOnly: boolean }) => NodeDatabase };

/** The Government Center Metromover station (schedule.db), where "Route from here" starts. */
const STATION = 'mover:government-center';
const STATION_AT: LatLon = { latitude: 25.775864, longitude: -80.196093 };
/** The rider, 400 m north of it (about Freedom Tower). */
const RIDER_AT: LatLon = { latitude: STATION_AT.latitude + 400 / 111_195, longitude: STATION_AT.longitude };

const trees: ReactTestRenderer[] = [];
/** The remove() of every expo-location watch the sheet started: each must be called once the sheet closes. */
const watchRemovals: jest.Mock[] = [];
let mockCopy: SQLiteDatabase | null = null;
let mockNodeDb: NodeDatabase | null = null;

/** test-time mock of native module: expo-sqlite's provider, which has opened the copy. */
function MockSQLiteProvider({ children }: { readonly children?: ReactNode }) {
  expect(children).toBeDefined();
  expect(mockScheduleCopy().databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  return <>{children}</>;
}

/** test-time mock of native module: the open copy — the committed schedule DB, read through node:sqlite. */
function mockScheduleCopy(): SQLiteDatabase {
  if (mockCopy === null) {
    const { DatabaseSync } = jest.requireActual<NodeSqlite>('node:sqlite');
    const db = new DatabaseSync(`${process.cwd()}/assets/db/schedule.db`, { readOnly: true });
    mockNodeDb = db;
    mockCopy = {
      databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`,
      getAllSync: (sql: string, params?: unknown) => db.prepare(sql).all(...mockNodeParams(params)),
      getFirstSync: (sql: string, params?: unknown) => db.prepare(sql).get(...mockNodeParams(params)) ?? null,
    } as unknown as SQLiteDatabase;
  }
  expect(mockCopy).not.toBeNull();
  expect(mockNodeDb).not.toBeNull();
  return mockCopy;
}

/** test-time mock of native module: expo-sqlite's bind params as node:sqlite takes them (a list spreads; `:name` keys pass whole). */
function mockNodeParams(params: unknown): unknown[] {
  expect(params === undefined || typeof params === 'object').toBe(true);
  const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
  expect(Array.isArray(list)).toBe(true);
  return list;
}

beforeEach(() => {
  jest.useFakeTimers({ now: ASKED_AT_S * 1000 });
  jest.mocked(expoFetch).mockImplementation(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture) }) as unknown as Awaited<ReturnType<typeof expoFetch>>);
});

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  // A closed sheet stops following the rider: every watch it started is removed, once.
  expect(watchRemovals.splice(0).map((remove) => remove.mock.calls.length)).toEqual(expect.not.arrayContaining([0]));
  jest.useRealTimers();
  jest.clearAllMocks();
  expect(trees).toHaveLength(0);
});

afterAll(() => {
  mockNodeDb?.close();
});

type OnFix = Parameters<typeof Location.watchPositionAsync>[1];

/** expo-location grants and its watch fixes the rider at `at`; or, with null, location is refused. */
function locate(at: LatLon | null): void {
  const answer = { granted: at !== null, status: at === null ? 'denied' : 'granted', canAskAgain: false, expires: 'never' } as Location.LocationPermissionResponse;
  jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue(answer);
  if (at !== null) {
    jest.mocked(Location.watchPositionAsync).mockImplementation((_options, onFix) => watchFixing(at, onFix));
  }
  expect(jest.mocked(Location.watchPositionAsync)).not.toHaveBeenCalled();
  expect(answer.granted).toBe(at !== null);
}

/** A started expo-location watch: one fix at `at` at once, and a remove() kept for the close check. */
async function watchFixing(at: LatLon, onFix: OnFix): Promise<{ remove: jest.Mock }> {
  expect(typeof onFix).toBe('function');
  onFix({ coords: { ...at, altitude: null, accuracy: 10, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  const remove = jest.fn();
  watchRemovals.push(remove);
  expect(watchRemovals).toContain(remove);
  return { remove };
}

/** Lets the copy open, the location answer, the debounce and the one request run out, a second at a time. */
async function settle(seconds: number): Promise<void> {
  expect(seconds).toBeGreaterThan(0);
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
  }
  expect(trees).toHaveLength(1);
}

/** Mounts the REAL sheet from the station under the REAL ScheduleDbProvider. */
async function mountSheet(): Promise<ReactTestRenderer> {
  expect(trees).toHaveLength(0);
  const sheet = (
    <UserLocationProvider>
      <ScheduleDbProvider>
        <PlanScreen fromStation={STATION} />
      </ScheduleDbProvider>
    </UserLocationProvider>
  );
  await act(async () => void trees.push(create(sheet)));
  expect(trees).toHaveLength(1);
  return trees[0] as ReactTestRenderer;
}

/** The REAL sheet from the station, planning to Brickell (a recent place), with its options in. */
async function routeFromHere(): Promise<ReactTestRenderer> {
  expect(recordRecentPlace(END).ok).toBe(true);
  const tree = await mountSheet();
  await settle(1);
  expect(hostsByTestID(tree.root, 'plan-from')[0]?.props.children).toBe('Government Center');
  await press(tree, 'plan-recent-0');
  await settle(2);
  expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(expoFetch).mock.calls[0]?.[0]).toContain(`fromPlace=${STATION_AT.latitude},${STATION_AT.longitude}&`);
  return tree;
}

/** The first option's hurry chip: its words, and the sentence VoiceOver reads. */
function firstChip(tree: ReactTestRenderer): { readonly text: unknown; readonly sentence: unknown } {
  const chip = hostsByTestID(tree.root, 'route-option-0-hurry')[0];
  expect(chip).toBeDefined();
  expect(hostsByTestID(tree.root, 'route-option-0-times').length).toBeGreaterThan(0);
  return { text: hostsByTestID(tree.root, 'route-option-0-hurry-text')[0]?.props.children, sentence: chip?.props.accessibilityLabel };
}

describe('the Route from here sheet and its hurry chips (mfix5)', () => {
  it('Route from here hurry chip walks from the user position', async () => {
    locate(RIDER_AT);
    expect(haversineMeters(RIDER_AT, STATION_AT)).toBeCloseTo(400, 0);
    const tree = await routeFromHere();
    // 400 m away (520 m with m7c's 1.3 detour) at 2:00:03, with 327 s until the 2:06 Mover less 30 s to
    // board: a walk (385 s) misses it, a jog (193 s) makes it with 134 s to spare.
    expect(jest.mocked(Location.watchPositionAsync)).toHaveBeenCalledTimes(1);
    expect(firstChip(tree)).toEqual({ text: 'Jog · 2 min', sentence: 'Jog to make the 2:06 train with 2 minutes to spare, going by scheduled times.' });
  });

  it('Route from here hurry chip walks from the plan start without a user position', async () => {
    locate(null);
    const tree = await routeFromHere();
    // No fix: the chip walks from the station itself, where the 2:06 Mover leaves — 327 s to spare, Chill.
    expect(jest.mocked(Location.watchPositionAsync)).not.toHaveBeenCalled();
    expect(firstChip(tree)).toEqual({ text: 'Chill · 5 min', sentence: 'Chill, a walk makes the 2:06 train with 5 minutes to spare, going by scheduled times.' });
  });
});
