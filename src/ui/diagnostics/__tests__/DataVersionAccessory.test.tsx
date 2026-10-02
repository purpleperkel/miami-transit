import type { SQLiteDatabase } from 'expo-sqlite';
import { router } from 'expo-router';
import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import { type ReactNode, useEffect } from 'react';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import manifest from '../../../../assets/db/manifest.json';
import { ScheduleDbProvider, SCHEDULE_DB_NAME } from '../../../data/schedule-db-provider';
import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { FakeServer, runtimeNetwork, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import type { SecretStore } from '../../../live/keys';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import type { QuotaStore } from '../../../live/quota';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { DataVersionAccessory } from '../DataVersionAccessory';

/**
 * R3b, the interim accessory Jamie sees under every tab: the REAL DataVersionAccessory, rendered in
 * each placement iOS gives it (expo-router's BottomAccessoryPlacementContext), under the REAL
 * ScheduleDbProvider (only expo-sqlite, the native database, is faked: it never opens, fails, or opens
 * a copy whose meta matches this bundle) and a REAL LiveRuntime's published state (in-memory
 * Keychain and quota stores, a fake server answering with the recorded vehicle feed). Keys are fake.
 */

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockOpenDb }));

type DbMode = 'opening' | 'ready' | 'failed';
type Placement = 'regular' | 'inline';
type LiveScenario = 'no-key' | 'live' | 'stale' | 'offline';

const PLACEMENTS: readonly Placement[] = ['regular', 'inline'];
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
/** The recorded vehicle feed's newest vehicle timestamp (epoch s), from live-feeds.fixture.ts. */
const NEWEST_VEHICLE_S = 1_790_872_192;
const TL_KEY = 'fake-transitland-key-for-accessory-test';
/** The calendar bounds the fake copy answers (the shape ScheduleRepo.open reads). */
const BOUNDS = { first_date: 20231113, first_base: 1_699_851_600, last_date: 20261231, last_base: 1_798_693_200, span_s: 90_240 };

let mockDbMode: DbMode = 'ready';
/** The one open copy: like expo-sqlite's context, the same handle on every render. */
let mockDb: SQLiteDatabase | null = null;
const runtimes: LiveRuntime[] = [];

/** test-time mock of native module: expo-sqlite's provider, which never opens, fails, or opens the copy. */
function MockSQLiteProvider({ children, onError }: { readonly children?: ReactNode; readonly onError?: (error: Error) => void }) {
  expect(['opening', 'ready', 'failed']).toContain(mockDbMode);
  expect(typeof onError).toBe('function');
  useEffect(() => {
    if (mockDbMode === 'failed') {
      onError?.(new Error('disk full'));
    }
  }, [onError]);
  return mockDbMode === 'ready' ? <>{children}</> : null;
}

/** test-time mock of native module: the open copy (one handle), answering its meta (this bundle's) and calendar bounds. */
function mockOpenDb(): SQLiteDatabase {
  mockDb = mockDb ?? mockCopy();
  expect(mockDb).not.toBeNull();
  expect(mockDb.databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  return mockDb;
}

/** test-time mock of native module: a copy whose meta is this bundle's. */
function mockCopy(): SQLiteDatabase {
  const meta = { builder_version: String(manifest.builderVersion), feed_sha256: manifest.feedSha256, schema_version: String(manifest.schemaVersion), time_zone: 'America/New_York' };
  const rows = Object.entries(meta).map(([key, value]) => ({ key, value }));
  const db = { databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`, getAllSync: () => rows, getFirstSync: () => BOUNDS };
  expect(rows).toHaveLength(4);
  expect(db.databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  return db as unknown as SQLiteDatabase;
}

afterEach(async () => {
  runtimes.splice(0, runtimes.length).forEach((runtime) => runtime.stop());
  mockDbMode = 'ready';
  await unmountAll();
});

/** Lets the Keychain read, the fetch and the runtime's bookkeeping finish. */
async function settle(): Promise<void> {
  const before = runtimes.length;
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(runtimes.length).toBe(before);
  expect(before).toBeGreaterThanOrEqual(0);
}

/** A real runtime, started and polled once, in `scenario`; its latest published state with it. */
async function liveValue(scenario: LiveScenario): Promise<LiveContextValue> {
  const keychain = new Map<string, string>(scenario === 'no-key' ? [] : [['live.key.transitland', TL_KEY]]);
  const quota = new Map<string, number>();
  const states: LiveState[] = [];
  const server = new FakeServer({ [TL_VEHICLES_URL]: scenario === 'offline' ? new Error('the phone is offline') : { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } });
  const secretStore: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const quotaStore: QuotaStore = { get: (key) => quota.get(key) ?? null, set: (key, count) => void quota.set(key, count) };
  const nowS = NEWEST_VEHICLE_S + (scenario === 'stale' ? 200 : 10);
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch: server.fetch, keychain: secretStore, quotaStore, nowS: () => nowS });
  runtimes.push(runtime);
  runtime.start();
  await settle();
  runtime.resume();
  await settle();
  const state = states[states.length - 1];
  expect(state).toBeDefined();
  expect(JSON.stringify(states)).not.toContain(TL_KEY);
  return { state: state as LiveState, runtime };
}

/** The accessory's rendered text and VoiceOver label, mounted in `placement` under the DB in `mode` and `live`. */
async function renderAccessory(mode: DbMode, live: LiveContextValue, placement: Placement): Promise<{ text: string; label: string; tree: ReactTestRenderer }> {
  mockDbMode = mode;
  const tree = await renderPrimitive(
    <ScheduleDbProvider>
      <LiveValueProvider value={live}>
        <BottomAccessoryPlacementContext.Provider value={placement}>
          <DataVersionAccessory />
        </BottomAccessoryPlacementContext.Provider>
      </LiveValueProvider>
    </ScheduleDbProvider>,
  );
  const texts = tree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string');
  const buttons = tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
  expect(texts).toHaveLength(1);
  expect(buttons).toHaveLength(1);
  return { text: texts[0]?.props.children as string, label: buttons[0]?.props.accessibilityLabel as string, tree };
}

describe('the bottom accessory (R3b): no feed hash', () => {
  it('accessory text never shows a feed hash', async () => {
    const lives: LiveContextValue[] = [NO_LIVE, await liveValue('no-key'), await liveValue('live'), await liveValue('stale'), await liveValue('offline')];
    const seen: string[] = [];
    for (const placement of PLACEMENTS) {
      seen.push(...Object.values(await renderAccessory('opening', NO_LIVE, placement)).filter((v): v is string => typeof v === 'string'));
      seen.push(...Object.values(await renderAccessory('failed', NO_LIVE, placement)).filter((v): v is string => typeof v === 'string'));
      for (const live of lives) {
        const { text, label } = await renderAccessory('ready', live, placement);
        seen.push(text, label);
      }
    }
    expect(seen).toHaveLength(2 * (2 + lives.length) * 2);
    expect(seen.filter((said) => /Data [0-9a-f]{6,}/.test(said))).toEqual([]);
    expect(seen.filter((said) => said.includes(manifest.feedSha256.slice(0, 6)))).toEqual([]);
  });
});

describe('the bottom accessory (R3b): what it says', () => {
  it('accessory says the schedule end in words', async () => {
    // The bundled schedule's first end is rail's Nov 22 (a feed refresh moves it: update this pin).
    expect(Math.min(manifest.serviceEnd.rail.date, manifest.serviceEnd.mover.date)).toBe(20261122);
    const live = await liveValue('live');
    const regular = await renderAccessory('ready', live, 'regular');
    const inline = await renderAccessory('ready', live, 'inline');
    expect([regular.text, inline.text]).toEqual(['Live · schedule to Nov 22', 'Live · to Nov 22']);
    expect(regular.label).toBe('Live. Bundled schedule: rail to Nov 22. Opens Data & Settings.');
    expect(inline.label).toBe(regular.label);
  });

  it('accessory says the live status in words', async () => {
    const said: string[] = [];
    for (const scenario of ['no-key', 'live', 'stale', 'offline'] as const) {
      said.push((await renderAccessory('ready', await liveValue(scenario), 'regular')).text);
    }
    said.push((await renderAccessory('ready', NO_LIVE, 'regular')).text);
    expect(said).toEqual([
      'No live data · schedule to Nov 22',
      'Live · schedule to Nov 22',
      'Live · 3 min old · schedule to Nov 22',
      'Offline · schedule to Nov 22',
      'Checking live · schedule to Nov 22',
    ]);
    expect((await renderAccessory('opening', NO_LIVE, 'regular')).text).toBe('Opening schedule · Settings');
    expect((await renderAccessory('failed', NO_LIVE, 'inline')).label).toBe('Schedule data unavailable: the schedule DB did not open: disk full. Opens Data & Settings.');
  });

  it('tapping the accessory opens data and settings', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const { tree } = await renderAccessory('ready', await liveValue('live'), 'inline');
    const button = tree.root.find((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');
    expect(typeof button.props.onClick).toBe('function');
    await act(async () => {
      button.props.onClick();
    });
    expect(push.mock.calls).toEqual([['/data']]);
    push.mockRestore();
  });
});
