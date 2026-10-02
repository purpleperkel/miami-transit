import type { SQLiteDatabase } from 'expo-sqlite';
import { router } from 'expo-router';
import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';

import type { SavedTrip } from '../../../data/saved-trips-repo';
import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { UserDbProvider } from '../../../data/user-db-provider';
import { nearestPlatform } from '../../../domain/hurry/platform';
import { windowFrom } from '../../../domain/gtfs/service-day';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { LiveRuntime } from '../../../live/runtime';
import { type HurryVerdict, hurryVerdict } from '../../../domain/hurry/verdict';
import type { Ride } from '../../../domain/schedule/rides';
import { hurryInline, hurrySentence } from '../../hurry/copy';
import { HURRY_RANGE_M, hurryReading, soonestBoard, stationTimetable } from '../../hurry/hurry-reading';
import { type TripVerdict, tripVerdict } from '../../hurry/trip-verdict';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { closeTripDbs, memoryUserRepos, nodeBackedDatabase, realScheduleRepo, savedTrip, WED_0800 } from '../../trips/__tests__/trip-db';
import { PACE_RANGE_MPS } from '../../settings/walking-pace';
import { type TimedRide, type TripCardModel, sortByLeaveAt, tripCards } from '../../trips/trip-card';
import { heroOf, type Timed } from '../../trips/trip-copy';
import { NEAR_TRIP_M } from '../homeContext';
import { NowAccessory } from '../NowAccessory';
import { nearTripText, nowStripText, tripText } from '../now-strip';
import { REGULAR_LINE_MAX_CHARS } from '../now-text';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAskLocation, watchPositionAsync: mockWatchPosition }));

/**
 * mfix8 (decision.miami_transit_bar_uses_saved_trips; Jamie, 2026-10-02: "By biggest gripe is how it says 'not
 * worth it next in 10 min fifth street' without me even entering where I wanna go? ... I do usually take
 * brickell city center to bayfront park"): the REAL Now bar — NowAccessory — under the REAL UserLocationProvider,
 * ScheduleDbProvider (the committed assets/db/schedule.db through node:sqlite) and UserDbProvider (an in-memory
 * user DB, migrated by the app, its trips written through the real SavedTripsRepo), at 08:00 on Wednesday
 * 2026-09-30 unless said. The rider P stands 176 m from Fifth Street (the nearest station) and 301 m from
 * Brickell City Centre, where Jamie's trip to Bayfront Park starts.
 */

type Fix = LatLon | null;
const P: LatLon = { latitude: 25.769, longitude: -80.194 };
const BCC = 'mover:brickell-city-centre';
const BAYFRONT = 'mover:bayfront-park';
const PACE = { walkMps: 1.35, jogMps: 2.7 };
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
const VERDICT_WORDS = /\b(chill|jog|not worth it|missed|hurry)\b/i;

let mockFix: Fix = P;
let mockCopy: SQLiteDatabase | null = null;

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

/** test-time mock of native module: expo-location's permission answer — a grant while there is a fix to give. */
function mockAskLocation(): Promise<{ granted: boolean; status: string }> {
  expect(mockFix === null || Number.isFinite(mockFix.latitude)).toBe(true);
  expect(typeof mockFix).toBe('object');
  return Promise.resolve({ granted: mockFix !== null, status: mockFix !== null ? 'granted' : 'denied' });
}

/** test-time mock of native module: expo-location's watch, which reports the fix at once. */
function mockWatchPosition(_options: unknown, onFix: (fix: { coords: LatLon }) => void) {
  expect(mockFix).not.toBeNull();
  expect(typeof onFix).toBe('function');
  onFix({ coords: mockFix as LatLon });
  return Promise.resolve({ remove: () => undefined });
}

afterEach(async () => {
  jest.restoreAllMocks();
  mockFix = P;
  await unmountAll();
});
afterAll(() => closeTripDbs());

type Bar = { readonly lines: readonly string[]; readonly nodes: readonly ReactTestInstance[]; readonly label: string; readonly tap: () => void };

/** The REAL bar in `placement` with `trips` saved (in order), the rider at `fix`, at `nowS`. */
async function bar(placement: 'regular' | 'inline', trips: readonly SavedTrip[], fix: Fix, nowS: number = WED_0800, live: LiveContextValue = NO_LIVE): Promise<Bar> {
  mockFix = fix;
  const repos = memoryUserRepos();
  expect(trips.every((trip) => repos.ok && repos.value.trips.create(trip).ok)).toBe(true);
  const tree = await renderPrimitive(
    <UserLocationProvider><ScheduleDbProvider><UserDbProvider open={() => repos}><LiveValueProvider value={live}>
      <BottomAccessoryPlacementContext.Provider value={placement}><NowAccessory clock={() => nowS} /></BottomAccessoryPlacementContext.Provider>
    </LiveValueProvider></UserDbProvider></ScheduleDbProvider></UserLocationProvider>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  const button = hostsByTestID(tree.root, 'now-accessory')[0] as ReactTestInstance;
  const nodes = button.findAll((node) => (node.type as unknown) === 'Text');
  expect(nodes.length).toBeGreaterThan(0);
  return { lines: nodes.map((node) => String(node.props.children)), nodes, label: String(button.props.accessibilityLabel), tap: () => button.props.onClick() };
}

/** A saved trip; `createdEpoch` orders the saving. */
function trip(id: string, from: string, to: string, extra: Partial<SavedTrip> = {}): SavedTrip {
  expect(from).not.toBe(to);
  expect(id.length).toBeGreaterThan(0);
  return savedTrip(id, from, to, { createdEpoch: 1_790_000_000 + id.charCodeAt(0), ...extra });
}

/** The straight-line metres from `fix` to the nearest platform of `stationKey`. */
function metresToStation(fix: LatLon, stationKey: string): number {
  const found = nearestPlatform(fix, realScheduleRepo().platforms().filter((platform) => platform.stationKey === stationKey), null);
  expect(found).not.toBeNull();
  expect(found?.platform.stationKey).toBe(stationKey);
  return found?.walkMeters ?? Number.NaN;
}

describe('the Now bar with no saved trip near (mfix8)', () => {
  it('with no saved trip near the bar says where to and gives no verdict', async () => {
    for (const fix of [P, null] as Fix[]) {
      for (const placement of ['regular', 'inline'] as const) {
        const shown = await bar(placement, [], fix);
        expect(shown.lines).toEqual(['Where to?']);
        expect([shown.label, VERDICT_WORDS.test(shown.label)]).toEqual(['Where to? Opens route options.', false]);
        await unmountAll();
      }
    }
    // A saved trip whose origin is ~19 km off (no ride within reach of that walk, so no countdown) is not judged either.
    const far = await bar('regular', [trip('a', BCC, BAYFRONT)], { latitude: 25.6, longitude: -80.2 });
    expect([far.lines, VERDICT_WORDS.test(far.label)]).toEqual([['Where to?'], false]);
  });

  it('tapping where to opens route options', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const shown = await bar('regular', [], P);
    await act(async () => shown.tap());
    expect(push.mock.calls).toEqual([['/plan']]);
    expect(shown.label).toContain('Opens route options.');
  });
});

describe('the Now bar judges the near saved trip (mfix8)', () => {
  it('a near saved trip is judged from its origin with only rides that reach its destination', async () => {
    // 08:04: Brickell City Centre's soonest train either way is NOT a Bayfront Park ride — m7c's station reading
    // would judge it ("Missed · next 8:10"); the trip's verdict weighs only rides that reach Bayfront Park.
    const at = WED_0800 + 240;
    const repo = realScheduleRepo();
    const station = hurryReading({ db: { kind: 'ready' }, position: { coordinate: P, note: null }, timetable: stationTimetable(repo, BCC, at - (at % 60)), batch: null, nowS: at, pace: PACE });
    const judged = tripVerdict(repo, { from: BCC, to: BAYFRONT, position: P, nowS: at, pace: PACE, batch: null });
    const rides = repo.tripRides(BCC, BAYFRONT, windowFrom(at, 3 * 3600));
    const rideEpochs = rides.ok && rides.value.kind === 'rides' ? rides.value.rides.map((ride) => ride.depEpoch) : [];
    expect(station.kind === 'boards' ? rideEpochs.includes(soonestBoard(station.boards).verdict.departure?.epoch ?? -1) : null).toBe(false);
    expect(rideEpochs).toContain(judged?.verdict.departure?.epoch);
    const regular = await bar('regular', [trip('a', BCC, BAYFRONT)], P, at);
    expect(regular.lines).toEqual(['Bayfront Park', 'Not worth it · ~5 min walk']);
    expect(regular.label).toContain(`${hurrySentence(judged!.verdict, judged!.ctx)} Trip to Bayfront Park from Brickell City Centre`);
    expect(regular.label).not.toContain('Fifth Street');
    await unmountAll();
    expect((await bar('inline', [trip('a', BCC, BAYFRONT)], P, at)).lines).toEqual([hurryInline(judged!.verdict, judged!.ctx)]);
  });

  it('the near saved trip with the soonest leave-by takes the bar', async () => {
    // Fifth Street → College North is saved first and leaves from the nearest station; Brickell City Centre →
    // Bayfront Park, saved later, has the sooner leave-by — and the bar.
    const trips = [trip('b', 'mover:fifth-street', 'mover:college-north'), trip('a', BCC, BAYFRONT, { createdEpoch: 1_790_000_500 })];
    const cards = sortByLeaveAt(tripCards(realScheduleRepo(), trips, { nowS: WED_0800, walkMps: PACE.walkMps, bufferS: 120, position: P }));
    expect(cards.map((card) => card.trip.id)).toEqual(['a', 'b']);
    expect(metresToStation(P, 'mover:fifth-street')).toBeLessThan(metresToStation(P, BCC));
    const shown = await bar('regular', trips, P);
    expect(shown.lines[0]).toBe('Bayfront Park');
    expect([VERDICT_WORDS.test(shown.lines[1] ?? ''), shown.label.includes('College North')]).toEqual([true, false]);
  });

  it('an active trip countdown keeps priority over a near trip', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const far = trip('d', 'rail:dadeland-north', 'rail:dadeland-south', { walkOverrideMin: 4 });
    const card = tripCards(realScheduleRepo(), [far], { nowS: WED_0800, walkMps: PACE.walkMps, bufferS: 120, position: P })[0];
    expect(card?.status.kind).toBe('leave');
    const shown = await bar('regular', [far, trip('a', BCC, BAYFRONT)], P);
    expect(shown.lines).toEqual(['Dadeland South', card?.status.kind === 'leave' ? heroOf(card.status, WED_0800).text : null]);
    expect(shown.lines.some((line) => VERDICT_WORDS.test(line))).toBe(false);
    await act(async () => shown.tap());
    expect(push.mock.calls).toEqual([[{ pathname: '/trip/[tripId]', params: { tripId: 'd' } }]]);
  });
});

/** A rider `metres` from `from` along the line from `from` through `toward`. */
function along(from: LatLon, toward: LatLon, metres: number): LatLon {
  const scale = metres / haversineMeters(from, toward);
  expect(Number.isFinite(scale)).toBe(true);
  expect(metres).toBeGreaterThan(0);
  return { latitude: from.latitude + (toward.latitude - from.latitude) * scale, longitude: from.longitude + (toward.longitude - from.longitude) * scale };
}

describe('near, and what the bar watches (mfix8)', () => {
  it('a trip origin at the near limit is near and one metre beyond is not', async () => {
    expect(NEAR_TRIP_M).toBe(HURRY_RANGE_M);
    // R is EXACTLY NEAR_TRIP_M (the app's haversine) from Palmetto's southern platform 9486, and further than that
    // from the station's centre: near is inclusive, and measured to the nearest platform.
    const R = { latitude: 25.826446447023613, longitude: -80.33062626199339 };
    const palmetto = realScheduleRepo().platforms().find((platform) => platform.stopId === '9486');
    expect([metresToStation(R, 'rail:palmetto'), palmetto?.stationKey]).toEqual([NEAR_TRIP_M, 'rail:palmetto']);
    const atLimit = await bar('regular', [trip('p', 'rail:palmetto', 'rail:okeechobee')], R);
    expect([atLimit.lines[0], VERDICT_WORDS.test(atLimit.lines[1] ?? ''), atLimit.label.includes('estimated')]).toEqual(['Okeechobee', true, true]);
    await unmountAll();
    const beyond = along(palmetto as LatLon, R, NEAR_TRIP_M + 1);
    expect(metresToStation(beyond, 'rail:palmetto')).toBeGreaterThan(NEAR_TRIP_M);
    const outside = await bar('regular', [trip('p', 'rail:palmetto', 'rail:okeechobee')], beyond);
    expect(outside.label).not.toMatch(/estimated|going by (live|scheduled) times/);
  });

  it('the bar watches only the judged trip origin', async () => {
    const keys = new Map<string, string>();
    const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: () => undefined, fetch: new FakeServer({}).fetch, nowS: () => WED_0800,
      keychain: { getItemAsync: (k) => Promise.resolve(keys.get(k) ?? null), setItemAsync: (k, v) => Promise.resolve(void keys.set(k, v)), deleteItemAsync: (k) => Promise.resolve(void keys.delete(k)) },
      quotaStore: { get: () => null, set: () => undefined } });
    const watch = jest.spyOn(runtime, 'watchStations');
    await bar('regular', [], P, WED_0800, { state: null, runtime });
    expect(watch.mock.calls.filter(([stations]) => stations.length > 0)).toEqual([]);
    await unmountAll();
    // Two near trips: only the judged one's origin is watched — not Fifth Street, the other trip's (and the nearest).
    await bar('regular', [trip('b', 'mover:fifth-street', 'mover:college-north'), trip('a', BCC, BAYFRONT)], P, WED_0800, { state: null, runtime });
    expect(watch.mock.calls.filter(([stations]) => stations.length > 0)).toEqual([[[BCC]]]);
  });
});

describe('the walk the bar judges is labelled an estimate (mfix8)', () => {
  it('an estimated walk is labelled as estimated', async () => {
    // m7c's straight-line estimate: the metres to the nearest boarding platform of the trip's rides, × 1.3 detour.
    const rides = realScheduleRepo().tripRides(BCC, BAYFRONT, windowFrom(WED_0800, 3 * 3600));
    const boards = new Set(rides.ok && rides.value.kind === 'rides' ? rides.value.rides.map((ride) => ride.boardStopId) : []);
    const metres = nearestPlatform(P, realScheduleRepo().platforms().filter((platform) => boards.has(platform.stopId)), null)?.walkMeters ?? Number.NaN;
    const minutes = Math.ceil((metres * 1.3) / PACE.walkMps / 60);
    const shown = await bar('regular', [trip('a', BCC, BAYFRONT)], P);
    expect(shown.lines[1]).toMatch(new RegExp(` · ~${minutes} min walk$`));
    expect(shown.label).toContain(`an estimated ${minutes}-minute walk`);
  });
});

/**
 * Every verdict kind the engine gives, with the longest numbers a bar can show: trains to 2 h out, the clock
 * "12:59", and walks from beside the platform out to the near limit at Data & Settings' slowest pace.
 */
function everyVerdict(): TripVerdict[] {
  const ctx = { now: 0, clock: () => '12:59' };
  const departures = [[600], [450], [300, 1200], [100, 180], [1500, 1800], [150, 900], [100, 110, 120, 2000], [], [7200]];
  const walks = [[0, PACE.walkMps], [400, PACE.walkMps], [NEAR_TRIP_M, PACE.walkMps], [NEAR_TRIP_M, PACE_RANGE_MPS.min]] as const;
  const all = walks.flatMap(([walkMeters, walkMps]) =>
    departures.map((epochs): TripVerdict => estimatedOver(hurryVerdict({ now: 0, walkMeters, walkMps, jogMps: walkMps * 2, departures: epochs.map((epoch) => ({ epoch, live: false, lineId: 'ORANGE', headsign: null })) }), ctx, walkMeters)),
  );
  expect(new Set(all.map(({ verdict }) => verdict.kind))).toEqual(new Set<HurryVerdict['kind']>(['CHILL', 'JOG', 'NOT_WORTH_IT', 'MISSED', 'NO_SERVICE']));
  expect(Math.max(...all.map(({ verdict }) => Math.ceil(verdict.walkS / 60)))).toBeGreaterThan(100);
  return all;
}

/** `verdict` over m7c's estimate of a walk `walkMeters` in a straight line (× 1.3), carrying that walk as the bar shows it (mfix11). */
function estimatedOver(verdict: HurryVerdict, ctx: TripVerdict['ctx'], walkMeters: number): TripVerdict {
  expect(Number.isFinite(verdict.walkS) && verdict.walkS >= 0).toBe(true);
  expect(walkMeters).toBeGreaterThanOrEqual(0);
  return { verdict, ctx, walkMeters, walk: { source: 'estimated', from: 'here', walkS: Math.ceil(verdict.walkS), minutes: Math.ceil(verdict.walkS / 60), stopId: '9514', walkedM: walkMeters * 1.3, straightM: walkMeters } };
}

/** A ride leaving at `depEpoch` (every clock the longest, 12:59 PM), to leave for 5 min before it. */
function timedRide(depEpoch: number): TimedRide {
  const ride: Ride = { serviceDate: 20260930, boardTripIdx: 1, alightTripIdx: 1, viaBlockLink: false, lineId: 'ORANGE', alightLineId: 'ORANGE', boardStopId: '9514', alightStopId: '9512', depEpoch, arrEpoch: depEpoch + 600 };
  expect(Number.isSafeInteger(depEpoch)).toBe(true);
  expect(ride.arrEpoch).toBeGreaterThan(ride.depEpoch);
  return { ride, leaveByEpoch: depEpoch - 300, leaveClock: '12:59 PM', departClock: '12:59 PM', arriveClock: '12:59 PM' };
}

/** A countdown at 08:00 with `leftS` seconds to its leave-by (negative: missed), with a later ride or none. */
function countdownTo(leftS: number, later: boolean): Timed {
  expect(Number.isSafeInteger(leftS)).toBe(true);
  expect(typeof later).toBe('boolean');
  return { kind: 'leave', current: timedRide(WED_0800 + leftS + 300), next: later ? timedRide(WED_0800 + leftS + 900) : null };
}

/** A trip card to `station` (from another station), as the bar names it. */
function cardTo(station: { readonly stationKey: string; readonly name: string }, status: TripCardModel['status']): TripCardModel {
  const from = station.stationKey === 'rail:palmetto' ? { key: 'rail:okeechobee', name: 'Okeechobee' } : { key: 'rail:palmetto', name: 'Palmetto' };
  expect(from.key).not.toBe(station.stationKey);
  expect(station.name.length).toBeGreaterThan(0);
  return { trip: savedTrip('t', from.key, station.stationKey), fromName: from.name, toName: station.name, walk: null, status };
}

describe('the bar fits the measured budget (mfix8)', () => {
  it('every bar line fits the measured budget', async () => {
    expect(REGULAR_LINE_MAX_CHARS >= 30 && REGULAR_LINE_MAX_CHARS <= 38).toBe(true);
    const offsets = [7200, 3600, 1800, 600, 240, 60, 1, 0, -1, -29];
    const lines: string[][] = [];
    for (const station of realScheduleRepo().stations()) {
      for (const judged of everyVerdict()) {
        lines.push([...nearTripText(cardTo(station, { kind: 'no-service' }), judged, 'regular').lines]);
      }
      for (const status of offsets.flatMap((leftS) => [countdownTo(leftS, true), countdownTo(leftS, false)])) {
        lines.push([...tripText({ card: cardTo(station, status), status }, WED_0800, 'regular').lines]);
      }
    }
    const night = { kind: 'noService', reopens: { mode: 'mover', at: { epoch: WED_0800, serviceDate: 20260930, serviceSec: 12 * 3600 + 59 * 60 } } } as const;
    lines.push([...nowStripText(night, null, 'regular').lines], [...nowStripText({ kind: 'unknown' }, null, 'regular').lines]);
    expect(lines.filter((said) => said.length > 2 || said.some((line) => [...line].length > REGULAR_LINE_MAX_CHARS))).toEqual([]);
    expect(lines.some((said) => said[0] === 'Miami International Airport')).toBe(true);
    // On the real bar every line is its own one-line Text at no more than the 15 pt the budget was measured at.
    for (const trips of [[trip('a', BCC, BAYFRONT)], [trip('d', 'rail:dadeland-north', 'rail:dadeland-south', { walkOverrideMin: 4 })]]) {
      const shown = await bar('regular', trips, P);
      expect(shown.nodes.map((node) => [node.props.numberOfLines, (StyleSheet.flatten(node.props.style) as { fontSize?: number }).fontSize])).toEqual([[1, 15], [1, 15]]);
      await unmountAll();
    }
  });
});
