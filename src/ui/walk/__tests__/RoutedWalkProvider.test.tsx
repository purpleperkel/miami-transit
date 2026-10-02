import { AppState, View } from 'react-native';
import { act } from 'react-test-renderer';

import { WALK_ROUTER_URL } from '../../../domain/walk/one-to-many';
import { mergeWalks, walkFor, type WalkStop } from '../../../domain/walk/walk-cache';
import { haversineMeters } from '../../../lib/geo';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { useUserPosition } from '../../map/use-user-location';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { useWalkTo } from '../RoutedWalkProvider';
import { queryPoint } from './fixture-walks';
import { type Asked, askedAt, consumers, E429, E503, ENET, FIFTH, FIVE, location, mountWalks, moveTo, O, resetRig, scriptedWalks, seen, south, step, stepUntil, walkSeen } from './walk-rig';

// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('./walk-location').locationModule());
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: mockExpoFetch }));

/**
 * mfix9 C + G: the app's ONE routed-walk runtime under the REAL UserLocationProvider (walk-rig.tsx; expo-location is
 * the native module mocked, by walk-location.ts). fetchWalk is INJECTED: a fake that records each request and answers
 * street walks twice the straight line, holds an answer, or fails with a LiveError. AppState is react-native's own jest
 * mock. Only the default-fetch case reaches expo/fetch, the native module mocked below, which answers like Transitous.
 */

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

/** A consumer outside any provider: records each stop's walk whenever the rider is located. */
function BareProbe({ stops }: { readonly stops: readonly WalkStop[] }) {
  const walk = useWalkTo(stops);
  const rider = useUserPosition().coordinate;
  if (rider !== null) {
    seen.set('bare', Object.fromEntries(stops.map((stop) => [stop.stopId, walk(stop)])));
  }
  expect(stops.length).toBeGreaterThan(0);
  expect(rider === null || seen.has('bare')).toBe(true);
  return <View testID="probe-bare" />;
}

beforeEach(() => {
  resetRig();
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
});

describe('useWalkTo without the provider', () => {
  it('without a provider the walk is the estimated fallback', async () => {
    location().rider.at = O;
    await renderPrimitive(
      <UserLocationProvider>
        <BareProbe stops={FIVE} />
      </UserLocationProvider>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.get('bare')).toEqual(Object.fromEntries(FIVE.map((stop) => [stop.stopId, walkFor(null, stop, O)])));
    expect(Object.values(seen.get('bare') ?? {}).map((walk) => walk.source)).toEqual(FIVE.map(() => 'estimated'));
  });
});

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
  await mountWalks(walks.fetchWalk, { a: FIVE.slice(0, 2), b: FIVE.slice(2) }, ['a']);
  await act(async () => consumers.show(['a', 'b']));
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
  await mountWalks(walks.fetchWalk, { a: FIVE.slice(0, 2), b: FIVE.slice(2) }, ['a']);
  await moveTo(O);
  await step(2);
  await moveTo(south(400));
  await act(async () => consumers.show(['a', 'b']));
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
  await mountWalks(walks.fetchWalk, { a: FIVE }, ['a']);
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

/** The fake's attempts `i` and `i + 1` are `waitS` apart: none a second sooner, the next a second later. */
async function waitsBetween(asked: readonly Asked[], i: number, waitS: number): Promise<void> {
  await stepUntil(askedAt(asked, i) + waitS - 1);
  expect(asked).toHaveLength(i + 1);
  await stepUntil(askedAt(asked, i) + waitS + 1);
  expect(asked).toHaveLength(i + 2);
}

/**
 * Backed off: 429 → the next attempt 60 s later, 429 again → 120 s; an answer resets it (503 → 60 s), and a network
 * failure after that 503 waits 120 s. Meanwhile the kept answer still walks the streets within 300 m of where it was
 * asked, and the estimate takes over beyond.
 */
async function backedOff(): Promise<number> {
  const walks = scriptedWalks([E429, E429, 'walks', E503, ENET]);
  await mountWalks(walks.fetchWalk, { a: FIVE }, ['a']);
  await moveTo(O);
  await step(2);
  expect(walkSeen('a', FIFTH).source).toBe('estimated');
  await waitsBetween(walks.asked, 0, 60);
  await waitsBetween(walks.asked, 1, 120);
  expect(walkSeen('a', FIFTH)).toEqual({ walkMeters: 2 * haversineMeters(O, FIFTH), detour: 1, source: 'routed' });
  await stepUntil(askedAt(walks.asked, 2) + 61);
  await moveTo(south(200));
  await step(1);
  const kept = mergeWalks(null, { origin: O, requestedAtS: askedAt(walks.asked, 2), stops: FIVE, paths: FIVE.map((stop) => ({ distanceM: 2 * haversineMeters(O, stop), costS: 1 })) });
  expect(walkSeen('a', FIFTH)).toEqual(walkFor(kept, FIFTH, south(200)));
  await waitsBetween(walks.asked, 3, 60);
  await moveTo(south(350));
  expect(walkSeen('a', FIFTH).source).toBe('estimated');
  await waitsBetween(walks.asked, 4, 120);
  return walks.asked.length;
}

/** Beyond the server's 128 targets: one request for the nearest 128, and the two left out never ask again. */
async function nearest128(): Promise<number> {
  const stops = Array.from({ length: 130 }, (_, i) => ({ stopId: `s${i}`, ...south(10 * (i + 1)) }));
  const walks = scriptedWalks();
  await mountWalks(walks.fetchWalk, { a: [...stops].reverse() }, ['a']);
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
      resetRig();
      requests.push(await run());
      await unmountAll();
    }
    expect(requests).toEqual([3, 2, 1, 6, 1]);
    expect(location().watchers).toHaveLength(0);
  }, 120_000);
});

describe('the provider\'s default fetch', () => {
  it('without fetchWalk the provider asks through the app\'s typed HTTP (expo/fetch)', async () => {
    location().rider.at = O;
    await mountWalks(undefined, { default: FIVE }, ['default']);
    await act(async () => {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(mockExpoAsked).toHaveLength(1);
    expect(walkSeen('default', FIFTH)).toEqual({ walkMeters: 2 * haversineMeters(O, FIFTH), detour: 1, source: 'routed' });
  });
});
