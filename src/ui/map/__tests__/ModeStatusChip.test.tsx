import { fetch as expoFetch } from 'expo/fetch';
import type { SQLiteDatabase } from 'expo-sqlite';
import { NavigationContainer } from 'expo-router/react-navigation';
import { transit_realtime } from 'gtfs-realtime-bindings';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import MapScreen from '../../../app/(tabs)/index';
import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { FakeServer, runtimeNetwork, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import type { SecretStore } from '../../../live/keys';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import type { QuotaStore } from '../../../live/quota';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { MODE_STATUS_PERIOD_MS } from '../use-mode-status';
import { MapViewMock } from './map-view-mock';

/**
 * mfix4 on the Map tab as the phone mounts it: the REAL Map route (MapScreen — TransitMap, its chrome,
 * the status pill) inside a real NavigationContainer and SafeAreaProvider, under the REAL
 * ScheduleDbProvider reading the REAL committed assets/db/schedule.db (expo-sqlite, the native database,
 * is stood in for by Node's own SQLite on that same file), beside a REAL LiveRuntime's published state —
 * its vehicle feed the recorded fixture re-timed to the test's instant, from a fake server. The clock is
 * jest's (fake timers), so the map is left open across a trip's end. Keys are fake.
 */

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: jest.requireActual<typeof import('./map-view-mock')>('./map-view-mock').MapViewMock, Polyline: 'Polyline', Marker: 'Marker' }));
// test-time mock of native module
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => Promise.resolve({ granted: false, status: 'denied', canAskAgain: false }),
  getCurrentPositionAsync: () => Promise.reject(new Error('location is off in this test')),
  Accuracy: { Balanced: 3 },
}));

type NodeStatement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type NodeDatabase = { prepare(sql: string): NodeStatement; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options: { readonly readOnly: boolean }) => NodeDatabase };
type FeedEntity = { readonly vehicle?: { readonly timestamp?: number; readonly trip?: { readonly routeId?: string } } };
type FeedObject = { readonly header: { readonly timestamp: number }; readonly entity: readonly FeedEntity[] };

/** New York instants (epoch s), each written with its offset. */
const THU_1200 = Date.parse('2026-10-01T12:00:00-04:00') / 1000;
const THU_2205 = Date.parse('2026-10-01T22:05:00-04:00') / 1000;
const THU_2303 = Date.parse('2026-10-01T23:03:00-04:00') / 1000;
const FRI_0200 = Date.parse('2026-10-02T02:00:00-04:00') / 1000;
const MON_1123_1200 = Date.parse('2026-11-23T12:00:00-05:00') / 1000;
const TUE_1124_0200 = Date.parse('2026-11-24T02:00:00-05:00') / 1000;
/** The Mover's routes in the county feed (Omni + Brickell, Inner Loop). */
const MOVER_ROUTES: readonly string[] = ['14456', '14457'];
const TL_KEY = 'fake-transitland-key-for-mode-status-test';
const PHONE = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 59, left: 0, right: 0, bottom: 34 } };
const NO_LIVE: LiveContextValue = { state: null, runtime: null };

const runtimes: LiveRuntime[] = [];
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

afterAll(() => {
  mockNodeDb?.close();
});

afterEach(async () => {
  await unmountAll();
  const stopped = runtimes.splice(0, runtimes.length);
  stopped.forEach((runtime) => runtime.stop());
  jest.useRealTimers();
  expect(stopped.every((runtime) => !runtime.isStarted())).toBe(true);
  expect(runtimes).toHaveLength(0);
});

/** The recorded vehicle feed re-timed to `atS` (header and every fix shifted alike); `withMover` false drops the Mover's cars. */
function vehicleFeedAt(atS: number, withMover: boolean): Uint8Array {
  const plain = transit_realtime.FeedMessage.toObject(transit_realtime.FeedMessage.decode(LIVE_VEHICLES_FIXTURE_BYTES), { longs: Number }) as FeedObject;
  const shift = atS - plain.header.timestamp;
  const entity = plain.entity
    .filter((e) => withMover || !MOVER_ROUTES.includes(e.vehicle?.trip?.routeId ?? ''))
    .map((e) => (e.vehicle?.timestamp === undefined ? e : { ...e, vehicle: { ...e.vehicle, timestamp: e.vehicle.timestamp + shift } }));
  expect(entity.some((e) => MOVER_ROUTES.includes(e.vehicle?.trip?.routeId ?? ''))).toBe(withMover);
  const encoded = transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject({ ...plain, header: { ...plain.header, timestamp: atS }, entity })).finish();
  // A copy with an ArrayBuffer of its own: protobufjs hands back a Node Buffer cut from a shared pool, and
  // a response body is read through its whole underlying buffer.
  const bytes = new Uint8Array(encoded);
  expect(bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length).toBe(true);
  return bytes;
}

/** Lets the Keychain read, the fetch and the runtime's bookkeeping finish (real timers). */
async function settle(): Promise<void> {
  const before = runtimes.length;
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(runtimes.length).toBe(before);
  expect(before).toBeGreaterThan(0);
}

type Live = { readonly value: LiveContextValue; readonly runtime: LiveRuntime; readonly server: FakeServer };

/** A real runtime with a Transitland key, started and polled once at `atS`; its latest state, and the server it called. */
async function liveAt(atS: number, withMover: boolean): Promise<Live> {
  const keychain = new Map<string, string>([['live.key.transitland', TL_KEY]]);
  const quota = new Map<string, number>();
  const states: LiveState[] = [];
  const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: vehicleFeedAt(atS, withMover) } });
  const secretStore: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const quotaStore: QuotaStore = { get: (key) => quota.get(key) ?? null, set: (key, count) => void quota.set(key, count) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch: server.fetch, keychain: secretStore, quotaStore, nowS: () => atS });
  runtimes.push(runtime);
  runtime.start();
  await settle();
  runtime.resume();
  await settle();
  const state = states[states.length - 1];
  expect(state?.vehicles?.items.some((vehicle) => vehicle.mode === 'rail')).toBe(true);
  expect(server.requests).toHaveLength(1);
  return { value: { state: state as LiveState, runtime }, runtime, server };
}

/** jest's clock (and timers) at `atS`; promises and microtasks stay real, so React and the providers settle. */
function clockAt(atS: number): void {
  jest.useFakeTimers({ now: atS * 1000, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  expect(Math.floor(Date.now() / 1000)).toBe(atS);
  expect(Number.isSafeInteger(atS)).toBe(true);
}

/** The Map tab as the phone mounts it, with `live` offered by the live context. */
async function renderMap(live: LiveContextValue): Promise<ReactTestRenderer> {
  const tree = await renderPrimitive(
    <SafeAreaProvider initialMetrics={PHONE}>
      <NavigationContainer>
        <ScheduleDbProvider>
          <LiveValueProvider value={live}>
            <MapScreen />
          </LiveValueProvider>
        </ScheduleDbProvider>
      </NavigationContainer>
    </SafeAreaProvider>,
  );
  expect(tree.root.findAllByType(MapViewMock)).toHaveLength(1);
  expect(hostsByTestID(tree.root, 'transit-map')).toHaveLength(1);
  return tree;
}

/** The chip's lines as shown (none when there is no chip). */
function chipLines(tree: ReactTestRenderer): string[] {
  const lines = hostsByTestID(tree.root, /^mode-status-(rail|mover)$/).map((row) => [row.props.children].flat().join(''));
  expect(hostsByTestID(tree.root, 'mode-status-chip')).toHaveLength(lines.length === 0 ? 0 : 1);
  expect(lines.every((line) => line.length > 0)).toBe(true);
  return lines;
}

/** What VoiceOver reads for the chip: its one accessible element's label. */
function chipLabel(tree: ReactTestRenderer): string {
  const [chip] = hostsByTestID(tree.root, 'mode-status-chip');
  expect(chip).toBeDefined();
  const spoken = (chip as ReactTestInstance).findAll((node) => typeof node.type === 'string' && node.props.accessible === true);
  expect(spoken).toHaveLength(1);
  return String(spoken[0]?.props.accessibilityLabel);
}

/** Lets `ms` of the map's life pass on jest's clock, in screen-clock periods. */
async function leaveOpen(ms: number): Promise<void> {
  expect(ms % MODE_STATUS_PERIOD_MS).toBe(0);
  for (let elapsed = 0; elapsed < ms; elapsed += MODE_STATUS_PERIOD_MS) {
    await act(async () => {
      jest.advanceTimersByTime(MODE_STATUS_PERIOD_MS);
    });
  }
  expect(jest.getTimerCount()).toBeGreaterThan(0);
}

describe('the map says when a mode is closed (mfix4)', () => {
  it('thu 23:03 with no live mover the map says metromover closed and when it opens', async () => {
    // Jamie's report: the feed had 7 trains and 0 Mover cars; the Mover's last trips ended 22:12.
    const live = await liveAt(THU_2303, false);
    clockAt(THU_2303);
    expect(live.value.state?.vehicles?.items.some((vehicle) => vehicle.mode === 'mover')).toBe(false);
    const tree = await renderMap(live.value);
    expect(chipLines(tree)).toEqual(['Metromover closed · opens 5:30 AM']);
  });

  it('fri 02:00 the map says metrorail closed and when it opens', async () => {
    clockAt(FRI_0200);
    const tree = await renderMap(NO_LIVE);
    // Thursday's last train ran out at 01:04; Friday's first leaves at 5:00, its first Mover at 5:30.
    expect(chipLines(tree)).toEqual(['Metrorail closed · opens 5:00 AM', 'Metromover closed · opens 5:30 AM']);
    expect(chipLabel(tree)).toBe('Metrorail closed, opens 5:00 AM. Metromover closed, opens 5:30 AM');
  });
});

describe('the chip is quiet unless a mode is closed and empty (mfix4)', () => {
  it('the chip is hidden while both modes run', async () => {
    clockAt(THU_1200);
    const tree = await renderMap(NO_LIVE);
    expect(chipLines(tree)).toEqual([]);
    await leaveOpen(2 * MODE_STATUS_PERIOD_MS);
    expect(chipLines(tree)).toEqual([]);
  });

  it('the chip is hidden while the closed mode has live vehicles', async () => {
    const live = await liveAt(THU_2303, true);
    expect(live.value.state?.vehicles?.items.some((vehicle) => vehicle.mode === 'mover')).toBe(true);
    clockAt(THU_2303);
    const tree = await renderMap(live.value);
    expect(chipLines(tree)).toEqual([]);
  });

  it('the chip is hidden for a mode past its bundled timetable', async () => {
    // The bundled rail timetable ends Sun 2026-11-22: past it rail is a data gap (the pill says so), never "closed".
    clockAt(MON_1123_1200);
    const noon = await renderMap(NO_LIVE);
    expect(chipLines(noon)).toEqual([]);
    await unmountAll();
    clockAt(TUE_1124_0200);
    const night = await renderMap(NO_LIVE);
    expect(chipLines(night)).toEqual(['Metromover closed · opens 5:30 AM']);
  });
});

describe('the chip over time, and its cost (mfix4)', () => {
  it('the chip appears when the last mover trip ends without a remount', async () => {
    clockAt(THU_2205);
    const tree = await renderMap(NO_LIVE);
    const map = tree.root.findByType(MapViewMock).instance;
    // 22:05: the Mover's last trips are still out (they end 22:12).
    expect(chipLines(tree)).toEqual([]);
    await leaveOpen(10 * 60 * 1000);
    expect(chipLines(tree)).toEqual(['Metromover closed · opens 5:30 AM']);
    expect(tree.root.findByType(MapViewMock).instance).toBe(map);
  });

  it('showing the mode status makes no live calls', async () => {
    const live = await liveAt(THU_2303, false);
    // Every runtime door that can lead to a request: polling (start / resume / tick), watched stations, keys.
    const doors = ['start', 'resume', 'tick', 'watchStations', 'loadKeys', 'saveKey', 'clearKey', 'saveSwiftlyAgency'] as const;
    const calls = doors.map((door) => jest.spyOn(live.runtime, door));
    clockAt(THU_2303);
    const tree = await renderMap(live.value);
    await leaveOpen(4 * MODE_STATUS_PERIOD_MS);
    expect(chipLines(tree)).toEqual(['Metromover closed · opens 5:30 AM']);
    // The one request is the runtime's own poll before the map was mounted.
    expect(live.server.requests).toHaveLength(1);
    expect(calls.filter((spy) => spy.mock.calls.length > 0)).toEqual([]);
    expect(expoFetch).not.toHaveBeenCalled();
  });
});
