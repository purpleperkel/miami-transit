import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { act } from 'react-test-renderer';

import type { LiveError } from '../../../domain/live/types';
import { transitousUserAgent } from '../../../domain/routes/transitous';
import { WALK_ROUTER_URL } from '../../../domain/walk/one-to-many';
import { walkFor, type WalkEstimate, type WalkStop } from '../../../domain/walk/walk-cache';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { err, ok } from '../../../lib/result';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { useUserPosition } from '../../map/use-user-location';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { queryPoint } from './fixture-walks';
import { appVersion } from '../../routes/plan-client';
import { RoutedWalkProvider, useWalkTo, type WalkFetch } from '../RoutedWalkProvider';

// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockGrant, watchPositionAsync: mockWatch }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: mockExpoFetch }));

/**
 * mfix9 C + G: the app's ONE routed-walk runtime under the REAL UserLocationProvider, whose one watch reports the fixes
 * this test pushes (expo-location is the native module mocked). fetchWalk is INJECTED: a fake that records each
 * request and answers with street walks twice the straight line, holds an answer, or fails with a LiveError. AppState
 * is react-native's own jest mock. The fake clock (Date.now included) moves 1 s per act (the repo's act() trap).
 * Only the default-fetch case reaches expo/fetch, the native module mocked below, which answers like Transitous.
 * The rider starts at GTFS stop 815 (Third Street); the stops are the committed capture's five Metromover targets.
 */

let mockFix: LatLon | null = null;
const mockWatchers: ((fix: { coords: LatLon }) => void)[] = [];

/** test-time mock of native module: expo-location grants foreground location. */
function mockGrant(): Promise<{ granted: boolean; status: string }> {
  expect(mockWatchers).toHaveLength(0);
  // The foreground case drives react-native's own AppState jest mock: its listeners are recorded calls.
  expect(jest.isMockFunction(AppState.addEventListener)).toBe(true);
  return Promise.resolve({ granted: true, status: 'granted' });
}

/** test-time mock of native module: the one watch, which hears every fix the test pushes (and the current one at once). */
function mockWatch(_options: unknown, onFix: (fix: { coords: LatLon }) => void): Promise<{ remove: () => void }> {
  expect(mockWatchers).toHaveLength(0);
  mockWatchers.push(onFix);
  if (mockFix !== null) {
    onFix({ coords: mockFix });
  }
  expect(mockWatchers).toEqual([onFix]);
  return Promise.resolve({ remove: () => void mockWatchers.splice(mockWatchers.indexOf(onFix), 1) });
}

/** The URLs expo/fetch was asked for. */
const mockExpoAsked: string[] = [];

/** test-time mock of native module: expo/fetch answering a one-to-many GET with street walks twice the straight line. */
function mockExpoFetch(url: string, init: { readonly signal: AbortSignal }): Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }> {
  expect(init.signal.aborted).toBe(false);
  mockExpoAsked.push(url);
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const one = queryPoint(query.get('one') ?? '');
  const body = JSON.stringify((query.get('many') ?? '').split(',').map((target) => ({ duration: 1, distance: 2 * haversineMeters(one, queryPoint(target)) })));
  const bytes = new TextEncoder().encode(body);
  expect(url.startsWith(`${WALK_ROUTER_URL}?`)).toBe(true);
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
}

const O: LatLon = { latitude: 25.772024, longitude: -80.193508 };
const FIVE: readonly WalkStop[] = [
  { stopId: '806', latitude: 25.771051, longitude: -80.192558 },
  { stopId: '805', latitude: 25.769165, longitude: -80.192248 },
  { stopId: '804', latitude: 25.766888, longitude: -80.192121 },
  { stopId: '807', latitude: 25.771865, longitude: -80.191377 },
  { stopId: '808', latitude: 25.773099, longitude: -80.187323 },
];
const FIFTH = FIVE[1] as WalkStop;
const PER_DEGREE_M = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });
const E429: LiveError = { kind: 'http', status: 429, message: 'api.transitous.org answered HTTP 429' };
const E503: LiveError = { kind: 'http', status: 503, message: 'api.transitous.org answered HTTP 503' };
/** Every consumer's latest walks while the rider is located: consumer name → stop_id → WalkEstimate. */
const seen = new Map<string, Readonly<Record<string, WalkEstimate>>>();
/** Where each consumer last saw the rider. */
const riderSeen = new Map<string, LatLon>();

/** `metres` due south of Third Street. */
function south(metres: number): LatLon {
  const point = { latitude: O.latitude - metres / PER_DEGREE_M, longitude: O.longitude };
  expect(haversineMeters(O, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(O.longitude);
  return point;
}

type Asked = { readonly atS: number; readonly one: LatLon; readonly many: readonly LatLon[] };
/** What the fake answers next: street walks (twice the straight line), an answer held until release(), or a failure. */
type Answer = 'walks' | 'held' | LiveError;

/** The injected fetchWalk: records each request and answers from `script` in order, then with street walks. */
function scriptedWalks(script: Answer[] = []) {
  const asked: Asked[] = [];
  const held: (() => void)[] = [];
  expect(script.filter((answer) => typeof answer === 'object').map((failure) => failure.kind)).toEqual(expect.not.arrayContaining(['no-key']));
  // Each request's time is read off jest's fake clock: the gap and backoff checks count fake seconds.
  expect(typeof (setTimeout as unknown as { clock?: unknown }).clock).toBe('object');
  const fetchWalk: WalkFetch = (request, signal) => {
    const query = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1));
    const one = queryPoint(query.get('one') ?? '');
    const many = (query.get('many') ?? '').split(',').map(queryPoint);
    asked.push({ atS: Date.now() / 1000, one, many });
    expect([request.url.startsWith(`${WALK_ROUTER_URL}?`), signal.aborted]).toEqual([true, false]);
    expect(request.headers).toEqual({ 'User-Agent': transitousUserAgent(appVersion()) });
    const walks = ok(many.map((target) => ({ duration: 1, distance: 2 * haversineMeters(one, target) })));
    const next = script.shift() ?? 'walks';
    return next === 'held' ? new Promise((resolve) => held.push(() => resolve(walks))) : Promise.resolve(next === 'walks' ? walks : err(next));
  };
  return { asked, fetchWalk, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

/** A consumer of the walks: registers `stops` and records each one's walk whenever the rider is located. */
function Probe({ name, stops }: { readonly name: string; readonly stops: readonly WalkStop[] }) {
  const walk = useWalkTo(stops);
  const rider = useUserPosition().coordinate;
  if (rider !== null) {
    seen.set(name, Object.fromEntries(stops.map((stop) => [stop.stopId, walk(stop.stopId)])));
    riderSeen.set(name, rider);
  }
  expect(new Set(stops.map((stop) => stop.stopId)).size).toBe(stops.length);
  expect(rider === null || Object.values(seen.get(name) ?? {}).every((estimate) => estimate.detour >= 1)).toBe(true);
  return <View testID={`probe-${name}`} />;
}

/** Shows the second consumer (once Consumers has mounted). */
const reveal = { second: (): void => undefined };

/** Two consumers of the walks; the second mounts when the test calls reveal.second(). */
function Consumers({ first, second }: { readonly first: readonly WalkStop[]; readonly second: readonly WalkStop[] }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    reveal.second = () => setShown(true);
  }, []);
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  return (
    <>
      <Probe name="a" stops={first} />
      {shown ? <Probe name="b" stops={second} /> : null}
    </>
  );
}

/** The provider (fed `fetchWalk`) under the REAL UserLocationProvider, around two consumers. */
async function mountWalks(fetchWalk: WalkFetch, first: readonly WalkStop[], second: readonly WalkStop[] = FIVE): Promise<void> {
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <RoutedWalkProvider fetchWalk={fetchWalk}>
        <Consumers first={first} second={second} />
      </RoutedWalkProvider>
    </UserLocationProvider>,
  );
  expect(tree.root.findAll((node) => node.props.testID === 'probe-a')).not.toHaveLength(0);
  expect(mockWatchers.length).toBeLessThanOrEqual(1);
}

/** The fake clock moved `seconds` times by 1 s, each in its own act. */
async function step(seconds: number): Promise<void> {
  expect(Number.isSafeInteger(seconds) && seconds >= 0).toBe(true);
  const until = Date.now() + seconds * 1000;
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
  }
  expect(Date.now()).toBe(until);
}

/** The fake clock moved to the first whole second at or after `atS`. */
async function stepUntil(atS: number): Promise<void> {
  const seconds = Math.max(0, Math.ceil(atS - Date.now() / 1000));
  await step(seconds);
  expect(Date.now() / 1000).toBeGreaterThanOrEqual(atS);
  expect(Date.now() / 1000 - atS).toBeLessThan(1);
}

/** The rider moves to `at`: the one watch reports it. */
async function moveTo(at: LatLon): Promise<void> {
  mockFix = at;
  await act(async () => [...mockWatchers].forEach((onFix) => onFix({ coords: at })));
  expect(mockWatchers).toHaveLength(1);
  expect(riderSeen.get('a')).toEqual(at);
}

/** The walk consumer `name` last saw to `stop`. */
function walkSeen(name: string, stop: WalkStop): WalkEstimate {
  const walk = seen.get(name)?.[stop.stopId];
  expect(walk).toBeDefined();
  expect(walk?.walkMeters).toBeGreaterThan(0);
  return walk as WalkEstimate;
}

beforeEach(() => {
  Object.assign(AppState, { currentState: 'active' });
  mockFix = null;
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
  [seen, riderSeen].forEach((map) => map.clear());
});

describe('useWalkTo without the provider', () => {
  it('without a provider the walk is the estimated fallback', async () => {
    mockFix = O;
    await renderPrimitive(
      <UserLocationProvider>
        <Probe name="bare" stops={FIVE} />
      </UserLocationProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.get('bare')).toEqual(Object.fromEntries(FIVE.map((stop) => [stop.stopId, walkFor(null, stop, O)])));
    expect(Object.values(seen.get('bare') ?? {}).map((walk) => walk.source)).toEqual(FIVE.map(() => 'estimated'));
  });
});

/** When request `i` was made, epoch s (the fake wall clock). */
function askedAt(asked: readonly Asked[], i: number): number {
  const request = asked[i];
  expect(request).toBeDefined();
  expect(i === 0 || (request as Asked).atS > (asked[i - 1] as Asked).atS).toBe(true);
  return (request as Asked).atS;
}

/** AppState moves to `state`: its currentState, and every 'change' listener added since the `from`-th. */
function changeAppState(state: 'active' | 'background', from: number): void {
  const listeners = jest.mocked(AppState.addEventListener).mock.calls.slice(from).filter(([type]) => type === 'change');
  expect(listeners.length).toBeGreaterThan(0);
  Object.assign(AppState, { currentState: state });
  listeners.forEach(([, listener]) => listener(state));
  expect(AppState.currentState).toBe(state);
}

/** Few and batched: no fix, no request; then both consumers' stops in ONE; only a move of more than 150 m asks again, never inside 60 s. */
async function fewAndBatched(): Promise<number> {
  const walks = scriptedWalks();
  await mountWalks(walks.fetchWalk, FIVE.slice(0, 2), FIVE.slice(2));
  await act(async () => reveal.second());
  await step(3);
  expect(walks.asked).toHaveLength(0);
  await moveTo(O);
  await step(2);
  expect(walks.asked.map((a) => [a.one, a.many.length])).toEqual([[O, 5]]);
  expect(walks.asked[0]?.many).toEqual(expect.arrayContaining(FIVE.map(({ latitude, longitude }) => ({ latitude, longitude }))));
  expect(walkSeen('a', FIFTH)).toEqual({ walkMeters: 2 * haversineMeters(O, FIFTH), detour: 1, source: 'routed' });
  await moveTo(south(100));
  await step(80);
  expect(walks.asked).toHaveLength(1);
  await moveTo(south(200));
  await step(2);
  expect(walks.asked.map((a) => a.one)).toEqual([O, south(200)]);
  await step(10);
  await moveTo(south(400));
  await stepUntil(askedAt(walks.asked, 1) + 59);
  expect(walks.asked).toHaveLength(2);
  await stepUntil(askedAt(walks.asked, 1) + 61);
  expect(walks.asked.map((a) => a.one)).toEqual([O, south(200), south(400)]);
  return walks.asked.length;
}

/** One in flight: while an answer is held, new fixes and a new consumer ask nothing; once it lands, one request asks for both. */
async function oneInFlight(): Promise<number> {
  const walks = scriptedWalks(['held']);
  await mountWalks(walks.fetchWalk, FIVE.slice(0, 2), FIVE.slice(2));
  await moveTo(O);
  await step(2);
  await moveTo(south(400));
  await act(async () => reveal.second());
  await step(70);
  expect(walks.asked).toHaveLength(1);
  await act(async () => walks.release());
  await step(1);
  expect(walks.asked.map((a) => [a.one, a.many.length])).toEqual([[O, 2], [south(400), 5]]);
  return walks.asked.length;
}

/** Only in the foreground: backgrounded, no request however far the rider moves; foregrounded, one at once. */
async function foregroundOnly(): Promise<number> {
  Object.assign(AppState, { currentState: 'background' });
  const from = jest.mocked(AppState.addEventListener).mock.calls.length;
  const walks = scriptedWalks();
  await mountWalks(walks.fetchWalk, FIVE);
  await moveTo(O);
  await step(90);
  expect(walks.asked).toHaveLength(0);
  await act(async () => changeAppState('active', from));
  await step(1);
  expect(walks.asked).toHaveLength(1);
  await act(async () => changeAppState('background', from));
  await step(61);
  await moveTo(south(200));
  await step(90);
  expect(walks.asked).toHaveLength(1);
  return walks.asked.length;
}

/**
 * Backed off: 429 → the next attempt 60 s later, 429 again → 120 s; an answer resets it (503 → 60 s). Meanwhile the
 * kept answer still walks the streets within 300 m of where it was asked, and the estimate takes over beyond.
 */
async function backedOff(): Promise<number> {
  const walks = scriptedWalks([E429, E429, 'walks', E503, E503]);
  await mountWalks(walks.fetchWalk, FIVE);
  await moveTo(O);
  await step(2);
  expect(walkSeen('a', FIFTH).source).toBe('estimated');
  for (const [i, waitS] of [[0, 60], [1, 120]] as const) {
    await stepUntil(askedAt(walks.asked, i) + waitS - 1);
    expect(walks.asked).toHaveLength(i + 1);
    await stepUntil(askedAt(walks.asked, i) + waitS + 1);
    expect(walks.asked).toHaveLength(i + 2);
  }
  expect(walkSeen('a', FIFTH)).toEqual({ walkMeters: 2 * haversineMeters(O, FIFTH), detour: 1, source: 'routed' });
  await stepUntil(askedAt(walks.asked, 2) + 61);
  await moveTo(south(200));
  await step(1);
  expect(walkSeen('a', FIFTH)).toEqual(walkFor({ origin: O, requestedAtS: askedAt(walks.asked, 2), paths: new Map(FIVE.map((stop) => [stop.stopId, { distanceM: 2 * haversineMeters(O, stop), costS: 1 }])) }, FIFTH, south(200)));
  await stepUntil(askedAt(walks.asked, 3) + 59);
  expect(walks.asked).toHaveLength(4);
  await stepUntil(askedAt(walks.asked, 3) + 61);
  expect(walks.asked).toHaveLength(5);
  await moveTo(south(350));
  expect(walkSeen('a', FIFTH).source).toBe('estimated');
  return walks.asked.length;
}

/** Beyond the server's 128 targets: one request for the nearest 128, and the two left out never ask again. */
async function nearest128(): Promise<number> {
  const stops = Array.from({ length: 130 }, (_, i) => ({ stopId: `s${i}`, ...south(10 * (i + 1)) }));
  const walks = scriptedWalks();
  await mountWalks(walks.fetchWalk, [...stops].reverse());
  await moveTo(O);
  await step(2);
  expect(walks.asked[0]?.many).toEqual(stops.slice(0, 128).map(({ latitude, longitude }) => ({ latitude, longitude })));
  await step(130);
  expect(walks.asked).toHaveLength(1);
  return walks.asked.length;
}

describe('the routed-walk runtime', () => {
  it('routed walk requests are few, batched and backed off', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-09-30T08:00:00-04:00'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const requests: number[] = [];
    for (const run of [fewAndBatched, oneInFlight, foregroundOnly, backedOff, nearest128]) {
      mockFix = null;
      Object.assign(AppState, { currentState: 'active' });
      [seen, riderSeen].forEach((map) => map.clear());
      requests.push(await run());
      await unmountAll();
    }
    expect(requests).toEqual([3, 2, 1, 5, 1]);
    expect(mockWatchers).toHaveLength(0);
  }, 120_000);
});

describe('the provider\'s default fetch', () => {
  it('without fetchWalk the provider asks through the app\'s typed HTTP (expo/fetch)', async () => {
    mockFix = O;
    await renderPrimitive(
      <UserLocationProvider>
        <RoutedWalkProvider>
          <Probe name="default" stops={FIVE} />
        </RoutedWalkProvider>
      </UserLocationProvider>,
    );
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(mockExpoAsked).toHaveLength(1);
    expect(walkSeen('default', FIFTH)).toEqual({ walkMeters: 2 * haversineMeters(O, FIFTH), detour: 1, source: 'routed' });
  });
});
