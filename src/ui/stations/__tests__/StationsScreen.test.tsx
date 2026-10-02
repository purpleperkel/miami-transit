import { fetch as expoFetch } from 'expo/fetch';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { FakeServer, runtimeNetwork, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import type { FetchFn } from '../../../live/http';
import type { SecretStore } from '../../../live/keys';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import type { QuotaStore } from '../../../live/quota';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { hostsByTestID } from '../../primitives/__tests__/render-primitive';
import { StationsScreen } from '../StationsScreen';
import { WED_0800 } from './station-fixtures';

/**
 * R7, the REALTIME COST RULE, behaviourally: the REAL Stations tab — StationsScreen under the REAL
 * ScheduleDbProvider, reading the REAL committed assets/db/schedule.db (expo-sqlite, the native
 * database, is stood in for by Node's own SQLite on that same file) — beside a REAL, started
 * LiveRuntime holding a Transitland key, whose network calls go to a fake server. Rendering the list
 * and letting the runtime poll must ask for no live prediction: the expo/fetch door is never used,
 * no station is watched, and no departures URL is requested. Keys are fake.
 */

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

type NodeStatement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type NodeDatabase = { prepare(sql: string): NodeStatement; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options: { readonly readOnly: boolean }) => NodeDatabase };

const TL_KEY = 'fake-transitland-key-for-stations-test';
const runtimes: LiveRuntime[] = [];
const trees: ReactTestRenderer[] = [];
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

/** The fake server's fetch, telling `departures` about every departures (live prediction) request first. */
function watchedFetch(server: FakeServer, departures: jest.Mock): FetchFn {
  expect(server.requests).toEqual([]);
  expect(departures).not.toHaveBeenCalled();
  return (url, init) => {
    expect(url.startsWith('https://')).toBe(true);
    if (url.includes('/departures')) {
      departures(url);
    }
    expect(init.signal).toBeDefined();
    return server.fetch(url, init);
  };
}

afterAll(() => {
  mockNodeDb?.close();
});

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  runtimes.splice(0, runtimes.length).forEach((runtime) => runtime.stop());
  expect(trees).toHaveLength(0);
  expect(runtimes).toHaveLength(0);
});

/** Lets the Keychain read, the fetches and the effects finish. */
async function settle(): Promise<void> {
  const before = runtimes.length;
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(runtimes.length).toBe(before);
  expect(trees.length).toBeLessThanOrEqual(1);
}

/** A real runtime with a Transitland key, started and polling; its fetch reports every departures request to `departures`. */
async function startedRuntime(departures: jest.Mock): Promise<{ runtime: LiveRuntime; value: () => LiveContextValue }> {
  const keychain = new Map<string, string>([['live.key.transitland', TL_KEY]]);
  const quota = new Map<string, number>();
  const states: LiveState[] = [];
  const server = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
  const fetch = watchedFetch(server, departures);
  const secretStore: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const quotaStore: QuotaStore = { get: (key) => quota.get(key) ?? null, set: (key, count) => void quota.set(key, count) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secretStore, quotaStore, nowS: () => WED_0800 });
  runtimes.push(runtime);
  runtime.start();
  await settle();
  expect(states.length).toBeGreaterThan(0);
  expect(states[states.length - 1]?.hasKey.transitland).toBe(true);
  return { runtime, value: () => ({ state: states[states.length - 1] ?? null, runtime }) };
}

describe('the Stations list and the live layer (R7)', () => {
  it('Stations list makes no live prediction calls', async () => {
    const departures = jest.fn();
    const live = await startedRuntime(departures);
    const watch = jest.spyOn(live.runtime, 'watchStations');
    await act(async () => {
      expect(trees).toHaveLength(0);
      trees.push(
        create(
          <ScheduleDbProvider>
            <LiveValueProvider value={live.value()}>
              <StationsScreen clock={() => WED_0800} />
            </LiveValueProvider>
          </ScheduleDbProvider>,
        ),
      );
      expect(trees).toHaveLength(1);
    });
    await settle();
    const tree = trees[0] as ReactTestRenderer;
    // The real list rendered: all 44 stations, each with its next scheduled departures from the DB.
    expect(hostsByTestID(tree.root, /^station-row-(rail|mover):[a-z0-9-]+$/)).toHaveLength(44);
    expect(hostsByTestID(tree.root, /^station-row-next-rail:government-ctr-[01]$/)).toHaveLength(2);
    // The runtime polls on (vehicles), and still no prediction is asked for.
    await act(async () => live.runtime.tick());
    await settle();
    expect(expoFetch).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(departures).toHaveBeenCalledTimes(0);
  });
});
