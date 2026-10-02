import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { closeScheduleCopy } from '../../../data/__tests__/schedule-sqlite-fake';
import { ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import type { LiveBatch, LivePrediction } from '../../../domain/live/types';
import { FakeServer, runtimeNetwork, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import type { SecretStore } from '../../../live/keys';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { locateAt } from '../../location/__tests__/located';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { readWalkingPace } from '../../settings/walking-pace';
import { WED_0800 } from '../../stations/__tests__/station-fixtures';
import { closeTripDbs, realScheduleRepo } from '../../trips/__tests__/trip-db';
import { hurryReading, stationTimetable } from '../hurry-reading';
import { StationHurry } from '../StationHurry';
import { LIVE_CHECK_TIMEOUT_MS } from '../useHurryVerdict';

// test-time mock of native module
jest.mock('expo-sqlite', () => jest.requireActual('../../../data/__tests__/schedule-sqlite-fake').scheduleSqliteModule());
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), watchPositionAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(() => Promise.resolve()), NotificationFeedbackType: { Warning: 'warning' } }));

/**
 * mfix7 fix 4 (Jamie's 07:10 recording: the Brickell City Centre sheet opened on a TIMETABLE verdict and flipped
 * ~1 s later to the LIVE one). The REAL StationHurry — under the REAL ScheduleDbProvider over the committed DB,
 * the app's ONE UserLocationProvider (its expo-location answer stood in) and a LiveValueProvider whose live state
 * this test controls (a real LiveRuntime's published state, its station predictions set here) — says "Checking
 * live times…" while the station's first live predictions are on their way, with no verdict and no jog buzz.
 *
 * The scene: 10:00 PM on Wednesday 2026-09-30 at Government Center (Metrorail), the rider ~1 km north. The next
 * train to Dadeland South leaves in 14 min and the one after 30 min later, so by the timetable it is a JOG; the
 * live prediction has it 5 min late, which a walk makes — a live CHILL.
 */

const STATION = 'rail:government-ctr';
const NIGHT_S = WED_0800 + 14 * 3600;
/** About 1 km north of Government Center's Metrorail platforms. */
const RIDER = { latitude: 25.785, longitude: -80.1961 };
const LATE_S = 300;

const runtimes: LiveRuntime[] = [];

afterEach(async () => {
  await unmountAll();
  runtimes.splice(0, runtimes.length).forEach((runtime) => (runtime.isStarted() ? runtime.stop() : undefined));
  jest.useRealTimers();
  jest.clearAllMocks();
  expect(runtimes).toHaveLength(0);
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
});
afterAll(() => {
  closeScheduleCopy();
  closeTripDbs();
});

/** Lets the schedule DB open, the location ask answer and the effects run, without moving the (fake) clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  expect(jest.isMockFunction(Location.watchPositionAsync)).toBe(true);
  expect(runtimes.length).toBeLessThanOrEqual(1);
}

/** Moves the fake clock `ms` forward in half-second steps, each inside act (CLAUDE.md's timer trap). */
async function step(ms: number): Promise<void> {
  expect(ms % 500).toBe(0);
  const from = jest.now();
  for (let moved = 0; moved < ms; moved += 500) {
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
  }
  expect(jest.now() - from).toBe(ms);
}

/**
 * A real LiveRuntime's published state — with a Transitland key (its predictions chain serves Transitland), or
 * without one (the chain is 'none') — and the runtime, stopped (no poll ever runs; the test sets the predictions).
 */
async function liveRuntime(keyed: boolean): Promise<{ readonly runtime: LiveRuntime; readonly state: LiveState }> {
  const keychain = new Map<string, string>(keyed ? [['live.key.transitland', 'fake-transitland-key-for-checking-test']] : []);
  const secrets: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const states: LiveState[] = [];
  const quota = new Map<string, number>();
  const fetch = new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } }).fetch;
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secrets, quotaStore: { get: (key) => quota.get(key) ?? null, set: (key, n) => void quota.set(key, n) }, nowS: () => NIGHT_S });
  runtimes.push(runtime);
  runtime.start();
  await settle();
  runtime.tick();
  await settle();
  runtime.stop();
  const state = states[states.length - 1] as LiveState;
  expect(state.status.predictions.provider).toBe(keyed ? 'transitland' : 'none');
  expect(state.predictions.has(STATION)).toBe(false);
  return { runtime, state };
}

/** The live state with `batch` as the station's predictions (null: its first fetch is still in flight). */
function withPredictions(state: LiveState, batch: LiveBatch<LivePrediction> | null): LiveState {
  const predictions = new Map(state.predictions);
  if (batch !== null) {
    predictions.set(STATION, batch);
  }
  expect(predictions.has(STATION)).toBe(batch !== null);
  expect(state.status.predictions).toBeDefined();
  return { ...state, predictions };
}

/** The station's first live batch: the next train to Dadeland South (direction 0), LATE_S late. */
function lateTrainBatch(): LiveBatch<LivePrediction> {
  const timetable = stationTimetable(realScheduleRepo(), STATION, NIGHT_S);
  const train = timetable.kind === 'timetable' ? timetable.departures.find((d) => d.directionId === 0 && d.epoch >= NIGHT_S) : undefined;
  expect(train?.destName).toBe('Dadeland South');
  const t = train as NonNullable<typeof train>;
  const prediction: LivePrediction = { tripId: t.tripId, routeId: 'GREEN', lineId: null, stopId: t.stopId, stationKey: STATION, epoch: t.epoch + LATE_S, scheduledEpoch: t.epoch, delayS: LATE_S, realtime: true, canceled: false, headsign: t.destName };
  expect(prediction.epoch).toBe(t.epoch + LATE_S);
  return { provider: 'transitland', items: [prediction], feedTimestamp: NIGHT_S, dropped: {}, fetchedAt: NIGHT_S, bytes: 1_024 };
}

/** The REAL station sheet hurry slot, under the real schedule and location providers and the live value `live`. */
function sheet(live: LiveContextValue) {
  expect(live.runtime).not.toBeNull();
  const element = (
    <UserLocationProvider>
      <ScheduleDbProvider>
        <LiveValueProvider value={live}>
          <StationHurry stationKey={STATION} clock={() => NIGHT_S} />
        </LiveValueProvider>
      </ScheduleDbProvider>
    </UserLocationProvider>
  );
  expect(element.type).toBe(UserLocationProvider);
  return element;
}

/** Mounts `element` on the fake clock (the rider fixed at RIDER) and lets the providers settle. */
async function mountOnFakeClock(element: ReturnType<typeof sheet>): Promise<ReactTestRenderer> {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  locateAt(Location, RIDER);
  const tree = await renderPrimitive(element);
  await settle();
  expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(hostsByTestID(tree.root, /^(station-hurry-note|hurry-card-\d)$/).length).toBeGreaterThan(0);
  return tree;
}

/** What the slot shows: the note's text, or each direction card's texts (title, badge, hero, detail). */
function slot(tree: ReactTestRenderer): { readonly note: string | null; readonly cards: readonly (readonly string[])[] } {
  const note = hostsByTestID(tree.root, 'station-hurry-note')[0]?.props.children ?? null;
  const cards = hostsByTestID(tree.root, /^hurry-card-\d$/).map((card: ReactTestInstance) => card.findAll((n) => (n.type as unknown) === 'Text' && typeof n.props.children === 'string').map((n) => n.props.children as string));
  expect(note === null || cards.length === 0).toBe(true);
  expect(typeof note === 'string' || note === null).toBe(true);
  return { note: note as string | null, cards };
}

describe('the station sheet while its first live times load (mfix7)', () => {
  it('while the first live fetch is in flight the hurry card says checking live times and fires no haptic', async () => {
    // By the timetable alone, this is a JOG: today's sheet would show it, and buzz.
    const timetable = stationTimetable(realScheduleRepo(), STATION, NIGHT_S);
    const scheduled = hurryReading({ db: { kind: 'ready' }, position: { coordinate: RIDER, note: null }, timetable, batch: null, nowS: NIGHT_S, pace: readWalkingPace() });
    expect(scheduled.kind === 'boards' ? scheduled.boards[0]?.verdict.kind : scheduled.kind).toBe('JOG');
    const live = await liveRuntime(true);
    const tree = await mountOnFakeClock(sheet({ state: withPredictions(live.state, null), runtime: live.runtime }));
    expect(slot(tree)).toEqual({ note: 'Checking live times…', cards: [] });
    await step(LIVE_CHECK_TIMEOUT_MS - 500);
    expect(slot(tree)).toEqual({ note: 'Checking live times…', cards: [] });
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('when live predictions arrive the hurry card shows the live verdict', async () => {
    const live = await liveRuntime(true);
    const tree = await mountOnFakeClock(sheet({ state: withPredictions(live.state, null), runtime: live.runtime }));
    await step(1_000);
    expect(slot(tree).note).toBe('Checking live times…');
    await act(async () => tree.update(sheet({ state: withPredictions(live.state, lateTrainBatch()), runtime: live.runtime })));
    // The train is 5 min late: a walk makes it, live. No "Checking", and never the timetable's JOG.
    expect(slot(tree).note).toBeNull();
    expect(slot(tree).cards[0]?.slice(0, 3)).toEqual(['To Dadeland South', 'Live', 'Chill']);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('when live predictions miss the timeout the hurry card falls back to the scheduled verdict', async () => {
    const live = await liveRuntime(true);
    const tree = await mountOnFakeClock(sheet({ state: withPredictions(live.state, null), runtime: live.runtime }));
    await step(LIVE_CHECK_TIMEOUT_MS - 500);
    expect(slot(tree).note).toBe('Checking live times…');
    await step(500);
    expect(slot(tree).note).toBeNull();
    expect(slot(tree).cards[0]?.slice(0, 3)).toEqual(['To Dadeland South', 'Scheduled', 'Jog']);
  });

  it('without a live key the hurry card shows the scheduled verdict at once', async () => {
    const live = await liveRuntime(false);
    const tree = await mountOnFakeClock(sheet({ state: live.state, runtime: live.runtime }));
    // No time passes: with no key there is nothing to wait for.
    expect(slot(tree).note).toBeNull();
    expect(slot(tree).cards[0]?.slice(0, 3)).toEqual(['To Dadeland South', 'Scheduled', 'Jog']);
    expect(slot(tree).cards).toHaveLength(2);
  });
});
