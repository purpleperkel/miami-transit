import type { SQLiteDatabase } from 'expo-sqlite';
import { router } from 'expo-router';
import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import manifest from '../../../../assets/db/manifest.json';
import { SCHEDULE_DB_NAME, ScheduleDbProvider, type ScheduleDbState, useScheduleDb } from '../../../data/schedule-db-provider';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { nearestPlatform } from '../../../domain/hurry/platform';
import { hurryVerdict } from '../../../domain/hurry/verdict';
import type { SecretStore } from '../../../live/keys';
import type { QuotaStore } from '../../../live/quota';
import { LiveRuntime } from '../../../live/runtime';
import { type HurryReading, hurryReading, stationTimetable } from '../../hurry/hurry-reading';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { WED_0800 } from '../../stations/__tests__/station-fixtures';
import { NowAccessory, NowAccessoryView } from '../NowAccessory';
import { nowAccessoryText } from '../now-text';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAskLocation, watchPositionAsync: mockWatchPosition }));

/**
 * Ruling R2 / plan M7c.3: the REAL Now strip — NowAccessory, mounted in the tab bar's BottomAccessory —
 * in each placement iOS gives it, under the REAL ScheduleDbProvider reading the REAL committed
 * assets/db/schedule.db (expo-sqlite is stood in for by Node's own SQLite on that file, or never opens, or
 * fails), with expo-location granting a fix (or refusing) and Jamie's paces in an in-memory kv store.
 * It is pinned to 08:00 on Wednesday 2026-09-30.
 */

type DbMode = 'opening' | 'ready' | 'failed';
type Placement = 'regular' | 'inline';
type NodeDatabase = { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown }; close(): void };

/** About 135 m west of Government Center's Metrorail platforms (its Mover stop is 142 m); ACROSS_TOWN is some 9 km south. */
const NEAR_GOVERNMENT_CENTER = { latitude: 25.776, longitude: -80.1975 };
const ACROSS_TOWN = { latitude: 25.69, longitude: -80.19603 };
const PLACEMENTS: readonly Placement[] = ['regular', 'inline'];
const NO_LIVE: LiveContextValue = { state: null, runtime: null };

let mockDbMode: DbMode = 'ready';
let mockFix: { latitude: number; longitude: number } | null = NEAR_GOVERNMENT_CENTER;
let mockCopy: SQLiteDatabase | null = null;
let mockNodeDb: NodeDatabase | null = null;

/** test-time mock of native module: expo-sqlite's provider, which never opens, fails, or has opened the copy. */
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

/** test-time mock of native module: the open copy — the committed schedule DB, read through node:sqlite. */
function mockScheduleCopy(): SQLiteDatabase {
  if (mockCopy === null) {
    const { DatabaseSync } = jest.requireActual<{ DatabaseSync: new (path: string, o: object) => NodeDatabase }>('node:sqlite');
    const db = new DatabaseSync(`${process.cwd()}/assets/db/schedule.db`, { readOnly: true });
    mockNodeDb = db;
    mockCopy = {
      databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`,
      getAllSync: (sql: string, p?: unknown) => db.prepare(sql).all(...mockNodeParams(p)),
      getFirstSync: (sql: string, p?: unknown) => db.prepare(sql).get(...mockNodeParams(p)) ?? null,
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

/** test-time mock of native module: expo-location's permission answer — a grant while there is a fix to give. */
function mockAskLocation(): Promise<{ granted: boolean; status: string }> {
  const granted = mockFix !== null;
  expect(typeof granted).toBe('boolean');
  expect(mockFix === null || Number.isFinite(mockFix.latitude)).toBe(true);
  return Promise.resolve({ granted, status: granted ? 'granted' : 'denied' });
}

/** test-time mock of native module: expo-location's watch, which reports the fix at once. */
function mockWatchPosition(options: { readonly accuracy: number }, onFix: (fix: { coords: { latitude: number; longitude: number } }) => void) {
  expect(options.accuracy).toBe(3);
  expect(mockFix).not.toBeNull();
  onFix({ coords: mockFix as { latitude: number; longitude: number } });
  return Promise.resolve({ remove: () => undefined });
}

afterAll(() => {
  mockNodeDb?.close();
});

afterEach(async () => {
  mockDbMode = 'ready';
  mockFix = NEAR_GOVERNMENT_CENTER;
  await unmountAll();
});

/** Lets the location answer, the watch and the schedule DB's open finish. */
async function settle(): Promise<void> {
  const before = mockDbMode;
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(mockDbMode).toBe(before);
  expect(['opening', 'ready', 'failed']).toContain(before);
}

/** Captures the schedule DB state the accessory reads (the same provider). */
function DbProbe({ onState }: { readonly onState: (state: ScheduleDbState) => void }) {
  const state = useScheduleDb();
  expect(typeof onState).toBe('function');
  expect(state.kind).toBeDefined();
  onState(state);
  return <View testID="db-probe" />;
}

/** The real accessory in `placement`, its text and label, under the DB in `mode` and `live`. */
async function renderAccessory(mode: DbMode, placement: Placement, live: LiveContextValue = NO_LIVE): Promise<{ text: string; label: string; tree: ReactTestRenderer }> {
  mockDbMode = mode;
  const tree = await renderPrimitive(
    <ScheduleDbProvider>
      <LiveValueProvider value={live}>
        <BottomAccessoryPlacementContext.Provider value={placement}>
          <NowAccessory clock={() => WED_0800} />
        </BottomAccessoryPlacementContext.Provider>
      </LiveValueProvider>
    </ScheduleDbProvider>,
  );
  await settle();
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  const texts = button?.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string') ?? [];
  expect(button).toBeDefined();
  expect(texts).toHaveLength(1);
  return { text: texts[0]?.props.children as string, label: button?.props.accessibilityLabel as string, tree };
}

describe('the Now strip (R2): no feed hash', () => {
  it('accessory text never shows a feed hash', async () => {
    const seen: string[] = [];
    for (const placement of PLACEMENTS) {
      for (const fix of [NEAR_GOVERNMENT_CENTER, ACROSS_TOWN, null]) {
        mockFix = fix;
        for (const mode of ['opening', 'failed', 'ready'] as const) {
          const { text, label } = await renderAccessory(mode, placement);
          seen.push(text, label);
        }
      }
    }
    expect(seen).toHaveLength(2 * 3 * 3 * 2);
    // Every state was said: the verdict (the station named), too far, location off, opening and failed.
    expect(seen.some((said) => said.includes('Nearest station: Government Center'))).toBe(true);
    expect(['No stop nearby', 'Location off', 'Opening…', 'No schedule'].every((said) => seen.includes(said))).toBe(true);
    expect(seen.filter((said) => /Data [0-9a-f]{6,}/.test(said))).toEqual([]);
    expect(seen.filter((said) => said.includes(manifest.feedSha256.slice(0, 6)))).toEqual([]);
  });
});

describe('the Now strip (M7c.3): the nearest station\'s verdict', () => {
  it('says hurry or chill for the nearest station in both placements', async () => {
    const captured: { db: ScheduleDbState } = { db: { kind: 'opening' } };
    await renderPrimitive(<ScheduleDbProvider><DbProbe onState={(state) => void (captured.db = state)} /></ScheduleDbProvider>);
    await settle();
    expect(captured.db.kind).toBe('ready');
    const repo = captured.db.kind === 'ready' ? captured.db.repo : null;
    expect(repo === null ? null : nearestPlatform(NEAR_GOVERNMENT_CENTER, repo.platforms(), null)?.platform.stopId).toBe('9512');
    const timetable = repo === null ? null : stationTimetable(repo, 'rail:government-ctr', WED_0800 - (WED_0800 % 60));
    const reading = hurryReading({ db: { kind: 'ready' }, position: { coordinate: NEAR_GOVERNMENT_CENTER, note: null }, timetable, batch: null, nowS: WED_0800, pace: { walkMps: 1.35, jogMps: 2.7 } });
    expect(reading.kind).toBe('boards');
    for (const placement of PLACEMENTS) {
      const shown = await renderAccessory('ready', placement);
      expect({ text: shown.text, label: shown.label }).toEqual(nowAccessoryText(reading, placement));
    }
    expect((await renderAccessory('ready', 'regular')).text).toMatch(/^(Chill|Jog|Not worth it|Missed) · .+ · Government Center$/);
  });
});

/** A live runtime that is never started: what the accessory asks of it is which station to watch. */
function idleRuntime(): LiveRuntime {
  const keychain = new Map<string, string>();
  const quota = new Map<string, number>();
  const secretStore: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const quotaStore: QuotaStore = { get: (key) => quota.get(key) ?? null, set: (key, count) => void quota.set(key, count) };
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: () => undefined, fetch: new FakeServer({}).fetch, keychain: secretStore, quotaStore, nowS: () => WED_0800 });
  expect(runtime.isStarted()).toBe(false);
  expect(keychain.size + quota.size).toBe(0);
  return runtime;
}

describe('the Now strip (M7c.3): the realtime cost rule', () => {
  it('watches the nearest station only, and none from across town', async () => {
    const runtime = idleRuntime();
    const watch = jest.spyOn(runtime, 'watchStations');
    await renderAccessory('ready', 'regular', { state: null, runtime });
    expect(watch.mock.calls).toEqual([[['rail:government-ctr']]]);
    await unmountAll();
    expect(watch.mock.calls[watch.mock.calls.length - 1]).toEqual([[]]);
    watch.mockClear();
    mockFix = ACROSS_TOWN;
    const far = await renderAccessory('ready', 'regular', { state: null, runtime });
    expect(far.text).toMatch(/^Nearest station \d+(\.\d)? km away$/);
    expect(watch).not.toHaveBeenCalled();
  });
});

/** A reading at Brickell whose one board is the engine's JOG for trains at 300 s and 1200 s, 400 m away. */
function jogAtBrickell(): HurryReading {
  const departures = [300, 1200].map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: 'Dadeland South' }));
  const verdict = hurryVerdict({ now: 0, walkMeters: 400, departures });
  expect(verdict.kind).toBe('JOG');
  expect(verdict.spareS).toBeCloseTo(77.4, 1);
  const board = { directionId: 0, title: 'To Dadeland South', walkMeters: 400, verdict, freshness: { kind: 'scheduled' } as const };
  return { kind: 'boards', stationKey: 'rail:brickell', stationName: 'Brickell', boards: [board], ctx: { now: 0, clock: () => '2:14' } };
}

describe('the Now strip (M7c.3): inline and full', () => {
  it('Now strip inline shows the hurry verdict', async () => {
    const inline = nowAccessoryText(jogAtBrickell(), 'inline');
    expect(inline.text).toBe('Jog · 1 min');
    const tree = await renderPrimitive(<NowAccessoryView placement="inline" said={inline} stationKey="rail:brickell" />);
    const texts = tree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string');
    expect(texts.map((node) => node.props.children)).toEqual(['Jog · 1 min']);
    expect(hostsByTestID(tree.root, 'now-accessory-settings')).toHaveLength(0);
  });

  it('the full strip says the whole verdict, the station, and the sentence to VoiceOver', () => {
    const regular = nowAccessoryText(jogAtBrickell(), 'regular');
    expect(regular.text).toBe('Jog · makes the 2:14 with 1 min spare · Brickell');
    expect(regular.label).toBe('Jog to make the 2:14 train with 1 minute to spare, going by scheduled times. Nearest station: Brickell, to Dadeland South. Opens the station.');
  });

  it('without a verdict it says why, in words', () => {
    expect(nowAccessoryText({ kind: 'no-location', note: 'Location is off' }, 'inline').text).toBe('Location off');
    expect(nowAccessoryText({ kind: 'locating' }, 'regular').text).toBe('Finding the nearest station…');
    expect(nowAccessoryText({ kind: 'far', stationKey: 'rail:palmetto', stationName: 'Palmetto', walkMeters: 12_400 }, 'regular').text).toBe('Nearest station 12 km away');
    expect(nowAccessoryText({ kind: 'gap', stationKey: 'rail:palmetto', stationName: 'Palmetto', gap: { kind: 'expired', lastDate: 20261122 } }, 'inline').text).toBe('No timetable');
  });
});

describe('the Now strip (M7c.3): where a tap goes', () => {
  it('tapping a verdict opens its station; without one, Data & Settings', async () => {
    const navigate = jest.spyOn(router, 'navigate').mockImplementation(() => undefined);
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const withVerdict = await renderPrimitive(<NowAccessoryView placement="regular" said={nowAccessoryText(jogAtBrickell(), 'regular')} stationKey="rail:brickell" />);
    const without = await renderPrimitive(<NowAccessoryView placement="inline" said={nowAccessoryText({ kind: 'locating' }, 'inline')} stationKey={null} />);
    await act(async () => {
      hostsByTestID(withVerdict.root, 'now-accessory')[0]?.props.onClick();
      hostsByTestID(withVerdict.root, 'now-accessory-settings')[0]?.props.onClick();
      hostsByTestID(without.root, 'now-accessory')[0]?.props.onClick();
    });
    expect(navigate.mock.calls).toEqual([[{ pathname: '/station/[stationKey]', params: { stationKey: 'rail:brickell' } }]]);
    expect(push.mock.calls).toEqual([['/data'], ['/data']]);
    navigate.mockRestore();
    push.mockRestore();
  });
});
