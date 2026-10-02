import * as Location from 'expo-location';
import { ExpoRoot } from 'expo-router';
import { inMemoryContext } from 'expo-router/build/testing-library/context-stubs';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import MapScreen from '@/app/(tabs)/index';
import TabsLayout from '@/app/(tabs)/_layout';
import RootLayout from '@/app/_layout';

import { SCHEDULE_DB_NAME } from '../../../data/schedule-db-provider';
import { hostsByTestID } from '../../primitives/__tests__/render-primitive';

// test-time mock of native module
jest.mock('react-native/Libraries/Utilities/NativePlatformConstantsIOS', () => ({ __esModule: true, default: { getConstants: mockIos26Constants } }));
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(), watchPositionAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy, openDatabaseSync: mockOpenUserDb }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn(() => new Promise(() => undefined)) }));
// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: jest.requireActual<typeof import('../../map/__tests__/map-view-mock')>('../../map/__tests__/map-view-mock').MapViewMock, Polyline: 'Polyline', Marker: 'Marker' }));
// test-time mock of native module
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn() }));

/**
 * mfix6: the REAL app — the root layout, the (tabs) layout and the Map tab, routed by expo-router's own
 * ExpoRoot at "/" — opens ONE location watch and asks for permission ONCE. On iOS 26 react-native-screens
 * mounts the tab bar's accessory twice ('regular' and 'inline'), so before the shared owner the two Now
 * strips' hurry hook and home context opened 4 watches, and the map asked a 5th time for its blue dot.
 * The platform reports iOS 26 (else jest's Platform.Version is undefined and no accessory mounts at all),
 * the schedule DB is the committed one through node:sqlite, the user DB fails to open, and the live
 * runtime idles in the background, so only the location wiring is counted.
 */

type NodeStatement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type NodeDatabase = { prepare(sql: string): NodeStatement; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options: { readonly readOnly: boolean }) => NodeDatabase };
type OnFix = Parameters<typeof Location.watchPositionAsync>[1];

/** Where the granted watch fixes the rider: Government Center (Metrorail). */
const RIDER_AT = { latitude: 25.774, longitude: -80.1957 };
const ACCESSORY = 'now-accessory';

const trees: ReactTestRenderer[] = [];
/** The remove() of every watch expo-location handed out. */
const removals: jest.Mock[] = [];
let mockCopy: SQLiteDatabase | null = null;
let mockNodeDb: NodeDatabase | null = null;

/** test-time mock of native module: the platform constants of an iPhone on iOS 26. */
function mockIos26Constants() {
  const constants = { forceTouchAvailable: false, interfaceIdiom: 'phone', isTesting: true, osVersion: '26.0', reactNativeVersion: { major: 1000, minor: 0, patch: 0, prerelease: undefined }, systemName: 'iOS' };
  expect(Number.parseInt(constants.osVersion, 10)).toBe(26);
  expect(constants.interfaceIdiom).toBe('phone');
  return constants;
}

/** test-time mock of native module: expo-sqlite's provider, which has opened the schedule copy. */
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

/** test-time mock of native module: user.db cannot be opened here (expo-sqlite's open failure), so no saved trip takes the strip. */
function mockOpenUserDb(): never {
  const failure = Object.assign(new Error('user.db is not available under jest'), { code: 'E_SQLITE_OPEN_DATABASE' });
  expect(failure.code).toBe('E_SQLITE_OPEN_DATABASE');
  expect(failure).toBeInstanceOf(Error);
  throw failure;
}

/**
 * expo-router's warning that a layout declares a screen the route context lacks: the context holds the three
 * routes these cases render, so the root Stack's other screens and the trips/stations tabs are named but absent.
 * Only that warning is held back; every other warning still reaches the console.
 */
const ABSENT_ROUTE = /^\[Layout children\]: Too many screens defined\. Route ".+" is extraneous\.$/;

beforeAll(() => {
  // RN's jest AppState mock has currentState = jest.fn(), which use-live-polling refuses; backgrounded, the live runtime idles.
  Object.assign(AppState, { currentState: 'background' });
  const warn = console.warn.bind(console);
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => (typeof args[0] === 'string' && ABSENT_ROUTE.test(args[0]) ? undefined : warn(...args)));
  expect(AppState.currentState).toBe('background');
  expect(jest.isMockFunction(console.warn)).toBe(true);
});

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  removals.splice(0, removals.length);
  jest.clearAllMocks();
  expect(trees).toHaveLength(0);
  expect(removals).toHaveLength(0);
});

afterAll(() => {
  mockNodeDb?.close();
});

/** expo-location answers the permission ask with `answer`; a watch fixes the rider at once and hands out a counted remove(). */
function locationAnswers(answer: Location.LocationPermissionResponse | undefined): void {
  jest.mocked(Location.requestForegroundPermissionsAsync).mockImplementation(() => Promise.resolve(answer as Location.LocationPermissionResponse));
  jest.mocked(Location.watchPositionAsync).mockImplementation((_options, onFix) => watchFixing(onFix));
  expect(jest.mocked(Location.watchPositionAsync)).not.toHaveBeenCalled();
  expect(jest.mocked(Location.requestForegroundPermissionsAsync)).not.toHaveBeenCalled();
}

/** A started expo-location watch: one fix at RIDER_AT at once, and its remove() kept for the unmount check. */
async function watchFixing(onFix: OnFix): Promise<{ remove: jest.Mock }> {
  expect(typeof onFix).toBe('function');
  onFix({ coords: { ...RIDER_AT, altitude: null, accuracy: 10, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  const remove = jest.fn();
  removals.push(remove);
  expect(removals).toContain(remove);
  return { remove };
}

/** The REAL app: the root layout, the tab layout and the Map tab, routed by expo-router at "/". */
function realApp() {
  const routes = inMemoryContext({ _layout: RootLayout, '(tabs)/_layout': TabsLayout, '(tabs)/index': MapScreen });
  expect(routes.keys()).toHaveLength(3);
  expect(typeof RootLayout).toBe('function');
  return <ExpoRoot context={routes} location="/" />;
}

/** Mounts the real app and lets the providers, the ask and the watch settle (zero-timeouts inside act). */
async function mountRealApp(): Promise<ReactTestRenderer> {
  expect(trees).toHaveLength(0);
  await act(async () => void trees.push(create(realApp())));
  await settle();
  expect(trees).toHaveLength(1);
  return trees[0] as ReactTestRenderer;
}

async function settle(): Promise<void> {
  expect(trees.length).toBeLessThanOrEqual(1);
  for (let i = 0; i < 6; i += 1) {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  expect(trees.length).toBeLessThanOrEqual(1);
}

/** The map's MapView hosts (map-view-mock renders a 'MapView' host carrying its props). */
function mapViews(tree: ReactTestRenderer): ReactTestInstance[] {
  const maps = tree.root.findAllByType('MapView' as never);
  expect(Array.isArray(maps)).toBe(true);
  expect(maps.every((map) => typeof map.props.showsUserLocation === 'boolean')).toBe(true);
  return maps;
}

/** The sum, over every watch handed out, of its remove() calls. */
function removeCalls(): number {
  const total = removals.reduce((sum, remove) => sum + remove.mock.calls.length, 0);
  expect(Number.isInteger(total)).toBe(true);
  expect(total).toBeGreaterThanOrEqual(0);
  return total;
}

const GRANTED = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' } as Location.LocationPermissionResponse;

describe('the real app and its one location watch (mfix6)', () => {
  it('the real tab layout mounts the now strip in both accessory placements', async () => {
    locationAnswers(GRANTED);
    const tree = await mountRealApp();
    expect(hostsByTestID(tree.root, ACCESSORY)).toHaveLength(2);
    expect(mapViews(tree)).toHaveLength(1);
  });

  it('the real app opens exactly one location watch', async () => {
    locationAnswers(GRANTED);
    const tree = await mountRealApp();
    expect(hostsByTestID(tree.root, ACCESSORY)).toHaveLength(2);
    expect(jest.mocked(Location.watchPositionAsync)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(Location.watchPositionAsync).mock.calls[0]?.[0]).toEqual({ accuracy: Location.Accuracy.Balanced, distanceInterval: 50 });
  });

  it('the real app asks for location permission once', async () => {
    locationAnswers(GRANTED);
    const tree = await mountRealApp();
    expect(jest.mocked(Location.requestForegroundPermissionsAsync)).toHaveBeenCalledTimes(1);
    // The map did not ask for itself, yet its blue dot shows: it read the one answer.
    expect(mapViews(tree).map((map) => map.props.showsUserLocation)).toEqual([true]);
  });

  it('unmounting the real app removes its one location watch', async () => {
    locationAnswers(GRANTED);
    const tree = await mountRealApp();
    expect(removals).toHaveLength(1);
    expect(removeCalls()).toBe(0);
    await act(async () => trees.splice(0, trees.length).forEach((mounted) => mounted.unmount()));
    expect(trees).toHaveLength(0);
    await settle();
    expect(removeCalls()).toBe(1);
    expect(jest.mocked(Location.watchPositionAsync)).toHaveBeenCalledTimes(1);
    expect(tree.toJSON()).toBeNull();
  });
});

/** Without a grant the real app opens no watch, draws no dot and still renders both strips and the map. */
async function expectNoWatchFor(answer: Location.LocationPermissionResponse | undefined): Promise<void> {
  locationAnswers(answer);
  const tree = await mountRealApp();
  expect(jest.mocked(Location.requestForegroundPermissionsAsync)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(Location.watchPositionAsync)).not.toHaveBeenCalled();
  expect(mapViews(tree).map((map) => map.props.showsUserLocation)).toEqual([false]);
  expect(hostsByTestID(tree.root, ACCESSORY)).toHaveLength(2);
}

describe('the real app without a location grant (mfix6)', () => {
  it('an undefined permission answer opens no watch, shows no dot and does not throw', async () => {
    await expectNoWatchFor(undefined);
    expect(removals).toHaveLength(0);
  });

  it('a denied permission answer opens no watch, shows no dot and does not throw', async () => {
    await expectNoWatchFor({ granted: false, status: 'denied', canAskAgain: false, expires: 'never' } as Location.LocationPermissionResponse);
    expect(removals).toHaveLength(0);
  });
});
