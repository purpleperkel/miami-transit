import type { SQLiteBindParams, SQLiteDatabase } from 'expo-sqlite';
import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider, useScheduleDb } from '../../../data/schedule-db-provider';
import type { ScheduleRepo } from '../../../data/schedule-repo';
import { windowFrom } from '../../../domain/gtfs/service-day';
import type { LiveBatch, LivePrediction } from '../../../domain/live/types';
import type { Departure } from '../../../domain/schedule/departures';
import type { LatLon } from '../../../lib/geo';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import type { CapabilityStatus } from '../../../live/poller';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import type { HomeContext } from '../../now/homeContext';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { closeTripDbs, nodeBackedDatabase, realScheduleRepo, savedTrip, WED_0800 } from '../../trips/__tests__/trip-db';
import { type TripCardModel, tripCards } from '../../trips/trip-card';
import { tripMinuteWindow, tripTimetable, type TripVerdict, tripVerdict } from '../trip-verdict';
import { useNearTripVerdict } from '../useHurryVerdict';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAskLocation, watchPositionAsync: mockWatchPosition }));

/**
 * mfix8 fix round (F4): the Now bar's near-trip verdict reads the schedule — the trip's rides and their boarding
 * departures — once a MINUTE, as the station sheet's stationTimetable does, while the instant, the rider's position
 * and the live batch move the verdict on every 5 s home tick. The REAL hook (useNearTripVerdict) under the REAL
 * UserLocationProvider (expo-location's watch stood in, so the test can move the rider), ScheduleDbProvider (the
 * committed assets/db/schedule.db through node:sqlite, every SQL statement it runs COUNTED at the native boundary)
 * and LiveValueProvider (a live state whose predictions the test sets): Jamie's trip Brickell City Centre → Bayfront
 * Park, the rider at P, from 08:00 on Wednesday 2026-09-30. Every tick's verdict is the pure tripVerdict's at that
 * second, so reading once a minute changes nothing the rider sees.
 */

const P: LatLon = { latitude: 25.769, longitude: -80.194 };
/** 100 m due north of P: nearer Brickell City Centre's platforms. */
const NORTH_OF_P: LatLon = { latitude: P.latitude + 100 / 111_195, longitude: P.longitude };
const BCC = 'mover:brickell-city-centre';
const BAYFRONT = 'mover:bayfront-park';
const PACE = { walkMps: 1.35, jogMps: 2.7 };
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
const IDLE: CapabilityStatus = { provider: 'none', failing: false, consecutiveFailures: 0, lastError: null };
const NO_BYTES = { responses: 0, bytes: 0, lastBytes: null, lastAt: null };

let mockCopy: SQLiteDatabase | null = null;
/** Every SQL statement the schedule copy has run. */
let mockStatements = 0;
/** Reports a new fix through the provider's one watch (set once the watch starts). */
let mockMoveRider: ((fix: LatLon) => void) | null = null;

/** test-time mock of native module: expo-sqlite's provider, with the schedule copy already open. */
function mockSQLiteProvider({ children }: { readonly children?: ReactNode }) {
  expect(children).toBeDefined();
  expect(SCHEDULE_DB_NAME.length).toBeGreaterThan(0);
  return <>{children}</>;
}

/** test-time mock of native module: the open copy — the committed schedule DB through node:sqlite — counting each statement it runs. */
function mockScheduleCopy(): SQLiteDatabase {
  if (mockCopy === null) {
    const db = nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true);
    mockCopy = {
      ...db,
      databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`,
      getAllSync: (sql: string, params: SQLiteBindParams) => mockCounted(() => db.getAllSync(sql, params)),
      getFirstSync: (sql: string, params: SQLiteBindParams) => mockCounted(() => db.getFirstSync(sql, params)),
    } as SQLiteDatabase;
  }
  expect(mockCopy.databasePath).toContain(SCHEDULE_DB_NAME);
  expect(typeof mockCopy.getAllSync).toBe('function');
  return mockCopy;
}

/** test-time mock of native module: one SQL statement on the schedule copy, counted. */
function mockCounted<T>(run: () => T): T {
  const before = mockStatements;
  mockStatements += 1;
  expect(mockStatements).toBe(before + 1);
  expect(typeof run).toBe('function');
  return run();
}

/** test-time mock of native module: expo-location's permission answer — a grant. */
function mockAskLocation(): Promise<{ granted: boolean; status: string }> {
  expect(mockMoveRider).toBeNull();
  expect(Number.isFinite(P.latitude)).toBe(true);
  return Promise.resolve({ granted: true, status: 'granted' });
}

/** test-time mock of native module: expo-location's watch — the rider at P at once, and later wherever the test moves them. */
function mockWatchPosition(_options: unknown, onFix: (fix: { coords: LatLon }) => void) {
  expect(typeof onFix).toBe('function');
  mockMoveRider = (fix) => onFix({ coords: fix });
  onFix({ coords: P });
  expect(mockMoveRider).not.toBeNull();
  return Promise.resolve({ remove: () => undefined });
}

afterEach(async () => {
  await unmountAll();
  mockMoveRider = null;
});
afterAll(() => closeTripDbs());

/** What the probe last saw: the hook's verdict and the provider's schedule repo. */
type Seen = { verdict: TripVerdict | null; repo: ScheduleRepo | null };

/** Calls the REAL hook for `context` and reports what it returned (and the repo the hook read). */
function NearTripProbe({ context, onSeen }: { readonly context: HomeContext; readonly onSeen: (seen: Seen) => void }) {
  const db = useScheduleDb();
  const verdict = useNearTripVerdict(context);
  expect(context.kind).toBe('nearTrip');
  expect(verdict === null || verdict.ctx.now === (context.kind === 'nearTrip' ? context.nowS : null)).toBe(true);
  onSeen({ verdict, repo: db.kind === 'ready' ? db.repo : null });
  return <View testID="near-trip-probe" />;
}

/** Jamie's saved trip's card, as the home context hands it over. */
function bayfrontCard(): TripCardModel {
  const [card] = tripCards(realScheduleRepo(), [savedTrip('bayfront', BCC, BAYFRONT)], { nowS: WED_0800, walkMps: PACE.walkMps, bufferS: 120, position: P });
  expect(card?.status.kind).toBe('leave');
  expect(card?.trip.fromStationKey).toBe(BCC);
  return card as TripCardModel;
}

/** The app around the probe, the home context at `nowS`, with `live`. */
function app(card: TripCardModel, nowS: number, live: LiveContextValue, seen: Seen): ReactElement {
  expect(Number.isSafeInteger(nowS)).toBe(true);
  expect(card.trip.id).toBe('bayfront');
  return (
    <UserLocationProvider><ScheduleDbProvider><LiveValueProvider value={live}>
      <NearTripProbe context={{ kind: 'nearTrip', card, nowS }} onSeen={(latest) => void Object.assign(seen, latest)} />
    </LiveValueProvider></ScheduleDbProvider></UserLocationProvider>
  );
}

/** Lets the location answer and the watch's first fix arrive. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(mockMoveRider).not.toBeNull();
  expect(mockCopy).not.toBeNull();
}

/** Re-renders at `nowS` (a home tick) and says how many SQL statements the schedule ran meanwhile. */
async function tick(tree: ReactTestRenderer, element: ReactElement): Promise<number> {
  const before = mockStatements;
  await act(async () => tree.update(element));
  expect(mockStatements).toBeGreaterThanOrEqual(before);
  expect(tree.root).toBeDefined();
  return mockStatements - before;
}

/** The verdict as the rider sees it: kind, the train judged, walk and spare (the clock is a function, compared by use). */
function shown(judged: TripVerdict | null): unknown {
  expect(judged).not.toBeNull();
  const departure = judged?.verdict.departure ?? null;
  expect(judged?.ctx.clock(WED_0800)).toBe('8:00');
  return { verdict: judged?.verdict, walkMeters: judged?.walkMeters, now: judged?.ctx.now, clock: departure === null ? null : judged?.ctx.clock(departure.epoch) };
}

/** The pure verdict at `nowS` from `position` with `batch`: what every tick must show. */
function pure(nowS: number, position: LatLon, batch: LiveBatch<LivePrediction> | null): unknown {
  expect(Number.isSafeInteger(nowS)).toBe(true);
  expect(position.latitude).toBeGreaterThan(25);
  return shown(tripVerdict(realScheduleRepo(), { from: BCC, to: BAYFRONT, position, nowS, pace: PACE, batch }));
}

describe('the Now bar reads its near trip once a minute (mfix8 fix round, F4)', () => {
  it('the near trip verdict reads the schedule once a minute and judges every tick', async () => {
    const card = bayfrontCard();
    const seen: Seen = { verdict: null, repo: null };
    const tree = await renderPrimitive(app(card, WED_0800, NO_LIVE, seen));
    await settle();
    expect(shown(seen.verdict)).toEqual(pure(WED_0800, P, null));
    // Premise: the app's repo runs SQL each time it is asked for the trip (it keeps no cache), so a tick that
    // re-read the trip would show in the count.
    const asked = mockStatements;
    expect(seen.repo === null ? null : tripTimetable(seen.repo, BCC, BAYFRONT, tripMinuteWindow(WED_0800))).not.toBeNull();
    expect(mockStatements).toBeGreaterThan(asked);
    for (let s = 5; s < 60; s += 5) {
      expect(await tick(tree, app(card, WED_0800 + s, NO_LIVE, seen))).toBe(0);
      expect(shown(seen.verdict)).toEqual(pure(WED_0800 + s, P, null));
    }
    // 08:01: a new minute reads the trip again — once — and the ticks after it read nothing.
    expect(await tick(tree, app(card, WED_0800 + 60, NO_LIVE, seen))).toBeGreaterThan(0);
    expect(shown(seen.verdict)).toEqual(pure(WED_0800 + 60, P, null));
    expect(await tick(tree, app(card, WED_0800 + 65, NO_LIVE, seen))).toBe(0);
    expect(shown(seen.verdict)).toEqual(pure(WED_0800 + 65, P, null));
  });
});

/** Brickell City Centre's departure that is the trip's ride leaving at `offsetS` from 08:00. */
function rideDeparture(offsetS: number): Departure {
  const repo = realScheduleRepo();
  const window = windowFrom(WED_0800 - 600, 3600);
  const rides = repo.tripRides(BCC, BAYFRONT, window);
  const ride = rides.ok && rides.value.kind === 'rides' ? rides.value.rides.find((candidate) => candidate.depEpoch === WED_0800 + offsetS) : undefined;
  const read = repo.departures(BCC, window);
  const all = read.ok && read.value.kind === 'departures' ? read.value.departures : [];
  const own = all.find((d) => d.tripIdx === ride?.boardTripIdx && d.stopId === ride?.boardStopId && d.epoch === ride?.depEpoch);
  expect(own?.epoch).toBe(WED_0800 + offsetS);
  expect(own?.tripId.length).toBeGreaterThan(0);
  return own as Departure;
}

/** A live runtime that is never started (no poll runs): the state below is the one it offers. */
function idleRuntime(): LiveRuntime {
  const keys = new Map<string, string>();
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: () => undefined, fetch: new FakeServer({}).fetch, nowS: () => WED_0800,
    keychain: { getItemAsync: (k) => Promise.resolve(keys.get(k) ?? null), setItemAsync: (k, v) => Promise.resolve(void keys.set(k, v)), deleteItemAsync: (k) => Promise.resolve(void keys.delete(k)) },
    quotaStore: { get: () => null, set: () => undefined } });
  expect(runtime.isStarted()).toBe(false);
  expect(keys.size).toBe(0);
  return runtime;
}

/** A live state whose Brickell City Centre batch moves `d` `delayS` late, fetched at 08:00. */
function liveWith(d: Departure, delayS: number): { readonly live: LiveContextValue; readonly batch: LiveBatch<LivePrediction> } {
  const prediction: LivePrediction = { tripId: d.tripId, routeId: d.lineId, lineId: null, stopId: d.stopId, stationKey: BCC, epoch: d.epoch + delayS, scheduledEpoch: d.epoch, delayS, realtime: true, canceled: false, headsign: null };
  const batch: LiveBatch<LivePrediction> = { items: [prediction], feedTimestamp: WED_0800, dropped: {}, provider: 'transitland', fetchedAt: WED_0800, bytes: 1 };
  const state: LiveState = {
    vehicles: null,
    predictions: new Map([[BCC, batch]]),
    status: { vehicles: IDLE, predictions: IDLE },
    bytes: { swiftly: NO_BYTES, transitland: NO_BYTES },
    callsThisMonth: { swiftly: 0, transitland: 0 },
    hasKey: { swiftly: false, transitland: true },
    keyHints: { swiftly: null, transitland: '••••TEST' },
    swiftlyAgency: 'miami',
    keysError: null,
    internalError: null,
  };
  expect(state.predictions.get(BCC)?.items).toHaveLength(1);
  expect(prediction.epoch).toBe(d.epoch + delayS);
  return { live: { state, runtime: idleRuntime() }, batch };
}

describe('between minute reads the verdict still moves (mfix8 fix round, F4)', () => {
  it('a new fix or a new live batch moves the near trip verdict with no schedule read', async () => {
    const card = bayfrontCard();
    const seen: Seen = { verdict: null, repo: null };
    const tree = await renderPrimitive(app(card, WED_0800, NO_LIVE, seen));
    await settle();
    // 08:00:10 — the 08:03 ride is predicted 90 s late: the verdict takes its live time, reading no schedule.
    const { live, batch } = liveWith(rideDeparture(180), 90);
    expect(await tick(tree, app(card, WED_0800 + 10, live, seen))).toBe(0);
    expect(seen.verdict?.verdict.departure?.live).toBe(true);
    expect(shown(seen.verdict)).toEqual(pure(WED_0800 + 10, P, batch));
    expect(shown(seen.verdict)).not.toEqual(pure(WED_0800 + 10, P, null));
    // 08:00:15 — the rider has walked 100 m north: the walk is measured from the new fix, still reading nothing.
    const before = mockStatements;
    await act(async () => mockMoveRider?.(NORTH_OF_P));
    expect(await tick(tree, app(card, WED_0800 + 15, live, seen))).toBe(0);
    expect(mockStatements).toBe(before);
    expect(shown(seen.verdict)).toEqual(pure(WED_0800 + 15, NORTH_OF_P, batch));
    expect(seen.verdict?.walkMeters).not.toBeCloseTo((tripVerdict(realScheduleRepo(), { from: BCC, to: BAYFRONT, position: P, nowS: WED_0800 + 15, pace: PACE, batch })?.walkMeters ?? 0), 0);
  });
});
