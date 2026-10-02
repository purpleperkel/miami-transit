import type { SQLiteDatabase } from 'expo-sqlite';
import { router } from 'expo-router';
import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import { type ReactNode, useEffect } from 'react';
import { View } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import manifest from '../../../../assets/db/manifest.json';
import { SCHEDULE_DB_NAME, ScheduleDbProvider, type ScheduleDbState, useScheduleDb } from '../../../data/schedule-db-provider';
import type { SavedTrip } from '../../../data/saved-trips-repo';
import { UserDbProvider } from '../../../data/user-db-provider';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { nearestPlatform } from '../../../domain/hurry/platform';
import { hurryVerdict } from '../../../domain/hurry/verdict';
import type { SecretStore } from '../../../live/keys';
import type { QuotaStore } from '../../../live/quota';
import { LiveRuntime } from '../../../live/runtime';
import { hurryInline, hurryShort } from '../../hurry/copy';
import { type TripVerdict, tripVerdict } from '../../hurry/trip-verdict';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { WED_0800 } from '../../stations/__tests__/station-fixtures';
import { closeTripDbs, memoryUserRepos, realScheduleRepo, savedTrip } from '../../trips/__tests__/trip-db';
import { type TripCardModel, tripCards } from '../../trips/trip-card';
import { NowAccessory, NowAccessoryView } from '../NowAccessory';
import { nearTripText, nowStripText, stripTarget } from '../now-strip';
import { REGULAR_LINE_MAX_CHARS } from '../now-text';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: MockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAskLocation, watchPositionAsync: mockWatchPosition }));

/**
 * Ruling R2 / plan M7c.3, as mfix8 changed it: the REAL Now strip — NowAccessory, mounted in the tab bar's
 * BottomAccessory — in each placement iOS gives it, under the REAL ScheduleDbProvider reading the REAL
 * committed assets/db/schedule.db (expo-sqlite is stood in for by Node's own SQLite on that file, or never
 * opens, or fails), the REAL UserDbProvider over an in-memory user DB holding the test's saved trips (the
 * app's own migrations and repos), expo-location granting a fix (or refusing) and Jamie's paces in an
 * in-memory kv store. It is pinned to 08:00 on Wednesday 2026-09-30. Saved trips drive the strip
 * (decision.miami_transit_bar_uses_saved_trips): it judges a saved trip whose origin the rider is near, never a
 * station on its own.
 */

type DbMode = 'opening' | 'ready' | 'failed';
type Placement = 'regular' | 'inline';
type NodeDatabase = { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown }; close(): void };

/** About 135 m west of Government Center's Metrorail platforms (its Mover stop is 142 m); ACROSS_TOWN is some 9 km south. */
const NEAR_GOVERNMENT_CENTER = { latitude: 25.776, longitude: -80.1975 };
const ACROSS_TOWN = { latitude: 25.69, longitude: -80.19603 };
const PLACEMENTS: readonly Placement[] = ['regular', 'inline'];
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
/** Government Center to Brickell on Metrorail: from the station NEAR_GOVERNMENT_CENTER is nearest to. */
const TO_BRICKELL: SavedTrip = savedTrip('brickell', 'rail:government-ctr', 'rail:brickell');

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
  closeTripDbs();
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

type Shown = { readonly lines: readonly string[]; readonly label: string; readonly tree: ReactTestRenderer };

/** The real accessory in `placement`, its lines and label, under the DB in `mode`, with `trips` saved, and `live`. */
async function renderAccessory(mode: DbMode, placement: Placement, trips: readonly SavedTrip[] = [], live: LiveContextValue = NO_LIVE): Promise<Shown> {
  mockDbMode = mode;
  const repos = memoryUserRepos();
  expect(trips.every((trip) => repos.ok && repos.value.trips.create(trip).ok)).toBe(true);
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <UserDbProvider open={() => repos}>
          <LiveValueProvider value={live}>
            <BottomAccessoryPlacementContext.Provider value={placement}>
              <NowAccessory clock={() => WED_0800} />
            </BottomAccessoryPlacementContext.Provider>
          </LiveValueProvider>
        </UserDbProvider>
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await settle();
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  const texts = button?.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string') ?? [];
  expect(button).toBeDefined();
  expect(texts.length >= 1 && texts.length <= (placement === 'inline' ? 1 : 2)).toBe(true);
  return { lines: texts.map((node) => node.props.children as string), label: button?.props.accessibilityLabel as string, tree };
}

/** The engine's verdict for TO_BRICKELL from `position` at 08:00 Wednesday: its own rides, walked from the rider. */
function verdictToBrickell(position: { latitude: number; longitude: number }): TripVerdict {
  const judged = tripVerdict(realScheduleRepo(), { from: TO_BRICKELL.fromStationKey, to: TO_BRICKELL.toStationKey, position, nowS: WED_0800, pace: { walkMps: 1.35, jogMps: 2.7 }, batch: null });
  expect(judged).not.toBeNull();
  expect(judged?.ctx.now).toBe(WED_0800);
  return judged as TripVerdict;
}

describe('the Now strip (R2): no feed hash', () => {
  it('accessory text never shows a feed hash', async () => {
    const seen: string[] = [];
    for (const placement of PLACEMENTS) {
      for (const fix of [NEAR_GOVERNMENT_CENTER, ACROSS_TOWN, null]) {
        mockFix = fix;
        for (const mode of ['opening', 'failed', 'ready'] as const) {
          const { lines, label } = await renderAccessory(mode, placement, [TO_BRICKELL]);
          seen.push(...lines, label);
        }
      }
    }
    // 2 placements × 3 fixes × 3 schedule states, each saying its lines and its label: 36 while every state said
    // one line (before mfix8), and 3 more now — in the three 'ready' states above the tab bar the saved trip shows,
    // as two lines (its destination over its verdict near Government Center, or over its countdown otherwise).
    expect(seen).toHaveLength(2 * 3 * 3 * 2 + 3);
    // Every state was said: the saved trip judged (its destination first, then the trip in words), and where to
    // (no trip near, no fix, the schedule opening or failed).
    expect(seen.some((said) => said.includes('Trip to Brickell from Government Center'))).toBe(true);
    expect(['Brickell', 'Where to?', 'Where to? Opens route options.'].every((said) => seen.includes(said))).toBe(true);
    expect(seen.filter((said) => /Data [0-9a-f]{6,}/.test(said))).toEqual([]);
    expect(seen.filter((said) => said.includes(manifest.feedSha256.slice(0, 6)))).toEqual([]);
  });
});

describe('the Now strip (mfix8): a saved trip from the nearest station', () => {
  it('judges the saved trip that starts at the nearest station, in both placements', async () => {
    const captured: { db: ScheduleDbState } = { db: { kind: 'opening' } };
    await renderPrimitive(<ScheduleDbProvider><DbProbe onState={(state) => void (captured.db = state)} /></ScheduleDbProvider>);
    await settle();
    expect(captured.db.kind).toBe('ready');
    const repo = captured.db.kind === 'ready' ? captured.db.repo : null;
    expect(repo === null ? null : nearestPlatform(NEAR_GOVERNMENT_CENTER, repo.platforms(), null)?.platform.stationKey).toBe(TO_BRICKELL.fromStationKey);
    const { verdict, ctx } = verdictToBrickell(NEAR_GOVERNMENT_CENTER);
    const walk = `~${Math.ceil(verdict.walkS / 60)} min walk`;
    const status = [`${hurryShort(verdict, ctx)} · ${walk}`, `${hurryInline(verdict, ctx)} · ${walk}`].find((line) => [...line].length <= REGULAR_LINE_MAX_CHARS);
    expect((await renderAccessory('ready', 'regular', [TO_BRICKELL])).lines).toEqual(['Brickell', status]);
    expect((await renderAccessory('ready', 'inline', [TO_BRICKELL])).lines).toEqual([hurryInline(verdict, ctx)]);
    // The station alone, with no saved trip from it, is never judged.
    expect((await renderAccessory('ready', 'regular')).lines).toEqual(['Where to?']);
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

describe('the Now strip (M7c.3, mfix8): the realtime cost rule', () => {
  it('watches only the near saved trip\'s origin, and nothing from across town', async () => {
    const runtime = idleRuntime();
    const watch = jest.spyOn(runtime, 'watchStations');
    // The saved trip leaves from the nearest station, so its predictions are watched — and nothing else.
    await renderAccessory('ready', 'regular', [TO_BRICKELL], { state: null, runtime });
    expect(watch.mock.calls).toEqual([[['rail:government-ctr']]]);
    await unmountAll();
    expect(watch.mock.calls[watch.mock.calls.length - 1]).toEqual([[]]);
    watch.mockClear();
    mockFix = ACROSS_TOWN;
    const far = await renderAccessory('ready', 'regular', [TO_BRICKELL], { state: null, runtime });
    // Across town (~9 km south) the trip is not near, so nothing is judged: the bar shows m7b's countdown for it —
    // its destination over when to leave, the long walk to Government Center included — and watches nothing.
    expect(far.lines).toEqual(['Brickell', 'Leave in 7 min']);
    expect(far.label).not.toMatch(/going by (live|scheduled) times|estimated/);
    expect(watch).not.toHaveBeenCalled();
  });
});

/** The real card of a saved trip Brickell → Dadeland South (its names, as the bar shows them). */
function brickellCard(): TripCardModel {
  const [card] = tripCards(realScheduleRepo(), [savedTrip('south', 'rail:brickell', 'rail:dadeland-south')], { nowS: WED_0800, walkMps: 1.35, bufferS: 120, position: null });
  expect(card?.toName).toBe('Dadeland South');
  expect(card?.fromName).toBe('Brickell');
  return card as TripCardModel;
}

/** A verdict for that trip: the engine's JOG for trains at 300 s and 1200 s, 400 m from the platform. */
function jogToDadeland(): TripVerdict {
  const departures = [300, 1200].map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: 'Dadeland South' }));
  const verdict = hurryVerdict({ now: 0, walkMeters: 400, departures });
  expect(verdict.kind).toBe('JOG');
  expect(verdict.spareS).toBeCloseTo(77.4, 1);
  return { verdict, ctx: { now: 0, clock: () => '2:14' }, walkMeters: 400 };
}

describe('the Now strip (M7c.3, mfix8): inline and full', () => {
  it('Now strip inline shows the hurry verdict', async () => {
    const inline = nearTripText(brickellCard(), jogToDadeland(), 'inline');
    expect(inline.lines).toEqual(['Jog']);
    const tree = await renderPrimitive(<NowAccessoryView placement="inline" said={inline} target={{ kind: 'trip', tripId: 'south' }} />);
    const texts = tree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string');
    expect(texts.map((node) => node.props.children)).toEqual(['Jog']);
    expect(hostsByTestID(tree.root, 'now-accessory-settings')).toHaveLength(0);
  });

  it('the full strip says the whole verdict, the station, and the sentence to VoiceOver', () => {
    const regular = nearTripText(brickellCard(), jogToDadeland(), 'regular');
    // 400 m × m7c's 1.3 detour at 1.35 m/s is 385 s: "~7 min walk", an estimate, and labelled one.
    expect(regular.lines).toEqual(['Dadeland South', 'Jog · 1 min spare · ~7 min walk']);
    expect(regular.label).toBe('Jog to make the 2:14 train with 1 minute to spare, going by scheduled times. Trip to Dadeland South from Brickell, an estimated 7-minute walk. Opens the trip.');
  });

  it('without a verdict it says where to, or why no train runs', () => {
    expect(nowStripText({ kind: 'unknown' }, null, 'regular')).toEqual({ lines: ['Where to?'], label: 'Where to? Opens route options.' });
    // At a station with no saved trip from it, the bar still never judges the station: it asks where to.
    expect(nowStripText({ kind: 'station', stationKey: 'rail:palmetto', stationName: 'Palmetto', distanceM: 40, autoPresent: false }, null, 'inline').lines).toEqual(['Where to?']);
    const night = nowStripText({ kind: 'noService', reopens: { mode: 'rail', at: { epoch: WED_0800 - 3 * 3600, serviceDate: 20260930, serviceSec: 5 * 3600 } } }, null, 'regular');
    expect(night.lines).toEqual(['No trains now', 'Metrorail opens 5:00 AM']);
    expect(night.label).toBe('No trains or Metromover cars run now. Metrorail opens 5:00 AM. Opens Data & Settings.');
  });
});

describe('the Now strip (M7c.3, mfix8): where a tap goes', () => {
  it('tapping a verdict opens its trip; without one, route options or Data & Settings', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const card = brickellCard();
    const near = await renderPrimitive(<NowAccessoryView placement="regular" said={nearTripText(card, jogToDadeland(), 'regular')} target={stripTarget({ kind: 'nearTrip', card, nowS: WED_0800 })} />);
    const whereTo = await renderPrimitive(<NowAccessoryView placement="inline" said={nowStripText({ kind: 'unknown' }, null, 'inline')} target={stripTarget({ kind: 'unknown' })} />);
    const night = await renderPrimitive(<NowAccessoryView placement="inline" said={nowStripText({ kind: 'noService', reopens: null }, null, 'inline')} target={stripTarget({ kind: 'noService', reopens: null })} />);
    await act(async () => {
      for (const [tree, id] of [[near, 'now-accessory'], [near, 'now-accessory-settings'], [whereTo, 'now-accessory'], [night, 'now-accessory']] as const) {
        hostsByTestID(tree.root, id)[0]?.props.onClick();
      }
    });
    expect(push.mock.calls).toEqual([[{ pathname: '/trip/[tripId]', params: { tripId: 'south' } }], ['/data'], ['/plan'], ['/data']]);
    expect([whereTo, night].map((tree) => hostsByTestID(tree.root, 'now-accessory-settings').length)).toEqual([0, 0]);
    push.mockRestore();
  });
});
