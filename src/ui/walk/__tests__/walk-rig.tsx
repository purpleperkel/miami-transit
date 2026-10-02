import { Activity, type ReactNode, useEffect, useMemo, useState } from 'react';
import { AppState, View } from 'react-native';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import type { LiveError } from '../../../domain/live/types';
import { transitousUserAgent } from '../../../domain/routes/transitous';
import { WALK_ROUTER_URL } from '../../../domain/walk/one-to-many';
import type { WalkEstimate, WalkStop } from '../../../domain/walk/walk-cache';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { err, ok, type Result } from '../../../lib/result';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { useUserPosition } from '../../map/use-user-location';
import { renderPrimitive } from '../../primitives/__tests__/render-primitive';
import { appVersion } from '../../routes/plan-client';
import { RoutedWalkProvider, useWalkStatus, useWalkTo, type WalkFetch, type WalkStatus } from '../RoutedWalkProvider';
import { queryPoint } from './fixture-walks';
import type { LocationFake } from './walk-location';

/**
 * mfix9: the rig the routed-walk runtime's tests share. The provider runs under the REAL UserLocationProvider, whose one
 * watch is walk-location.ts's fake of the native expo-location (each test file mocks it); fetchWalk is INJECTED
 * (scriptedWalks: it records each request and answers street walks twice the straight line, holds an answer, fails with
 * a LiveError, or breaks its contract); the fake clock moves 1 s per act (the repo's act() trap). The rider starts at
 * GTFS stop 815 (Third Street); the stops are the committed capture's five Metromover targets. The provider sits in an
 * <Activity> the test can hide and show again (visibility), and, given a live rig (liveRuntime), under a REAL started
 * LiveRuntime whose published states reach useLive() as LiveDataProvider offers them.
 */

export const O: LatLon = { latitude: 25.772024, longitude: -80.193508 };
export const FIVE: readonly WalkStop[] = [
  { stopId: '806', latitude: 25.771051, longitude: -80.192558 },
  { stopId: '805', latitude: 25.769165, longitude: -80.192248 },
  { stopId: '804', latitude: 25.766888, longitude: -80.192121 },
  { stopId: '807', latitude: 25.771865, longitude: -80.191377 },
  { stopId: '808', latitude: 25.773099, longitude: -80.187323 },
];
export const FIFTH = FIVE[1] as WalkStop;
const PER_DEGREE_M = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });
export const E429: LiveError = { kind: 'http', status: 429, message: 'api.transitous.org answered HTTP 429' };
export const E503: LiveError = { kind: 'http', status: 503, message: 'api.transitous.org answered HTTP 503' };
export const ENET: LiveError = { kind: 'network', message: 'api.transitous.org could not be reached: offline' };

/** Every consumer's latest walks while the rider is located: consumer name → stop_id → WalkEstimate. */
export const seen = new Map<string, Readonly<Record<string, WalkEstimate>>>();
/** Where each consumer last saw the rider. */
export const riderSeen = new Map<string, LatLon>();
/** The provider's status, as its last render gave it (StatusProbe). */
export const statusSeen: { latest: WalkStatus | null } = { latest: null };

/** `metres` due south of Third Street. */
export function south(metres: number): LatLon {
  const point = { latitude: O.latitude - metres / PER_DEGREE_M, longitude: O.longitude };
  expect(haversineMeters(O, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(O.longitude);
  return point;
}

/** `metres` due north of Third Street. */
export function north(metres: number): LatLon {
  const point = { latitude: O.latitude + metres / PER_DEGREE_M, longitude: O.longitude };
  expect(haversineMeters(O, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(O.longitude);
  return point;
}

export type Asked = { readonly atS: number; readonly one: LatLon; readonly many: readonly LatLon[] };
/**
 * How an answer lands: street walks (twice the straight line), or its contract broken — 'throwing' (an answer whose
 * value throws when read) or 'rejecting' (a rejected promise).
 */
export type Landing = 'walks' | 'throwing' | 'rejecting';
/** What the fake answers next: an answer that lands at once, one held until the test lands it, or a failure. */
export type Answer = Landing | 'held' | LiveError;

/** A held answer: its request's signal (aborted once the provider abandons it), and how the test lands it. */
type Held = { readonly signal: AbortSignal; readonly land: (how: Landing) => void };

/** The injected fetchWalk: records each request and answers from `script` in order, then with street walks. */
export function scriptedWalks(script: Answer[] = []) {
  const asked: Asked[] = [];
  const signals: AbortSignal[] = [];
  const held = new Map<number, Held>();
  expect(script.filter((answer) => typeof answer === 'object').map((failure) => failure.kind)).toEqual(expect.not.arrayContaining(['no-key']));
  // Each request's time is read off jest's fake clock: the gap and backoff checks count fake seconds.
  expect(typeof (setTimeout as unknown as { clock?: unknown }).clock).toBe('object');
  const fetchWalk: WalkFetch = (request, signal) => {
    const query = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1));
    const one = queryPoint(query.get('one') ?? '');
    const many = (query.get('many') ?? '').split(',').map(queryPoint);
    // One request in flight: a new one is asked only once every earlier answer has landed or been abandoned.
    expect([...held.values()].map((earlier) => earlier.signal.aborted)).not.toContain(false);
    asked.push({ atS: Date.now() / 1000, one, many });
    signals.push(signal);
    expect([request.url.startsWith(`${WALK_ROUTER_URL}?`), signal.aborted]).toEqual([true, false]);
    expect(request.headers).toEqual({ 'User-Agent': transitousUserAgent(appVersion()) });
    const next = script.shift() ?? 'walks';
    return next === 'held' ? holdAnswer(asked.length - 1, signal, one, many, held) : answerOf(next, one, many);
  };
  /** Lands held request `i` (its index in `asked`) the way `how` says. */
  const land = (i: number, how: Landing = 'walks') => {
    const answer = held.get(i);
    expect(answer).toBeDefined();
    expect(signals[i]).toBe(answer?.signal);
    held.delete(i);
    answer?.land(how);
  };
  return { asked, signals, fetchWalk, land, release: () => [...held.keys()].forEach((i) => land(i)) };
}

/** Request `i`'s answer, held until the test lands it (scriptedWalks' land). */
function holdAnswer(i: number, signal: AbortSignal, one: LatLon, many: readonly LatLon[], held: Map<number, Held>): ReturnType<WalkFetch> {
  expect(held.has(i)).toBe(false);
  expect(many.length).toBeGreaterThan(0);
  return new Promise((resolve, reject) => {
    held.set(i, { signal, land: (how) => void answerOf(how, one, many).then(resolve, reject) });
  });
}

/** The fake's answer to one request (see Answer). */
function answerOf(next: Landing | LiveError, one: LatLon, many: readonly LatLon[]): ReturnType<WalkFetch> {
  const walks = ok(many.map((target) => ({ duration: 1, distance: 2 * haversineMeters(one, target) })));
  expect(many.length).toBeGreaterThan(0);
  expect(walks.value).toHaveLength(many.length);
  if (next === 'throwing') {
    // An Ok whose value throws when the provider reads it: the answer handler breaks, as a bug would.
    const broken = Object.defineProperty({ ok: true }, 'value', { get: (): never => breaks('the answer broke while it was read') });
    return Promise.resolve(broken as Result<unknown, LiveError>);
  }
  return next === 'rejecting' ? Promise.reject(new Error('fetchWalk rejected')) : Promise.resolve(next === 'walks' ? walks : err(next));
}

/** Throws `message`: what a broken answer does when it is read. */
function breaks(message: string): never {
  expect(message.length).toBeGreaterThan(0);
  expect(typeof message).toBe('string');
  throw new Error(message);
}

/** A consumer of the walks: registers `stops` and records each one's walk whenever the rider is located. */
function Probe({ name, stops }: { readonly name: string; readonly stops: readonly WalkStop[] }) {
  const walk = useWalkTo(stops);
  const rider = useUserPosition().coordinate;
  if (rider !== null) {
    seen.set(name, Object.fromEntries(stops.map((stop) => [stop.stopId, walk(stop)])));
    riderSeen.set(name, rider);
  }
  expect(new Set(stops.map((stop) => stop.stopId)).size).toBe(stops.length);
  expect(rider === null || Object.values(seen.get(name) ?? {}).every((estimate) => estimate.detour >= 1)).toBe(true);
  return <View testID={`probe-${name}`} />;
}

/** Records the provider's status on every render. */
function StatusProbe() {
  const status = useWalkStatus();
  useEffect(() => {
    statusSeen.latest = status;
  }, [status]);
  expect(status.cache === null || status.cache.lastRequestAtS > 0).toBe(true);
  expect(status.lastError === null || status.lastError.message.length > 0).toBe(true);
  return null;
}

/** Which consumers are mounted: the test calls consumers.show([...names]) once Consumers has mounted. */
export const consumers = { show: (names: readonly string[]): void => expect(names).toEqual([]) };

/** One consumer per named stop set; only the ones named in `shown` (at first `initially`) are mounted. */
function Consumers({ sets, initially }: { readonly sets: Readonly<Record<string, readonly WalkStop[]>>; readonly initially: readonly string[] }) {
  const [shown, setShown] = useState(initially);
  useEffect(() => {
    consumers.show = (names) => setShown(names);
  }, []);
  expect(shown.every((name) => sets[name] !== undefined)).toBe(true);
  expect(Object.values(sets).every((stops) => stops.length > 0)).toBe(true);
  return <>{shown.map((name) => <Probe key={name} name={name} stops={sets[name] ?? []} />)}</>;
}

/** A started live runtime over an in-memory Keychain and quota store and a silent server, and every state it publishes. */
export type LiveRig = { readonly runtime: LiveRuntime; readonly states: LiveState[]; readonly listeners: Set<(state: LiveState) => void> };

/** The live rig: a REAL LiveRuntime, started, whose states are recorded and handed to whoever listens (LiveRigValue). */
export function liveRuntime(): LiveRig {
  const states: LiveState[] = [];
  const listeners = new Set<(state: LiveState) => void>();
  const keys = new Map<string, string>();
  const runtime = new LiveRuntime({
    network: runtimeNetwork(),
    onChange: (state) => {
      states.push(state);
      listeners.forEach((listener) => listener(state));
    },
    fetch: new FakeServer({}).fetch,
    nowS: () => Math.floor(Date.now() / 1000),
    keychain: { getItemAsync: (k) => Promise.resolve(keys.get(k) ?? null), setItemAsync: (k, v) => Promise.resolve(void keys.set(k, v)), deleteItemAsync: (k) => Promise.resolve(void keys.delete(k)) },
    quotaStore: { get: () => null, set: () => undefined },
  });
  runtime.start();
  expect(runtime.isStarted()).toBe(true);
  expect(states.at(-1)?.internalError).toBeNull();
  return { runtime, states, listeners };
}

/** Offers the rig's runtime and its latest published state to useLive(), as LiveDataProvider offers its own. */
function LiveRigValue({ live, children }: { readonly live: LiveRig; readonly children: ReactNode }) {
  const [state, setState] = useState<LiveState | null>(() => live.states.at(-1) ?? null);
  useEffect(() => {
    live.listeners.add(setState);
    return () => void live.listeners.delete(setState);
  }, [live]);
  const value = useMemo<LiveContextValue>(() => ({ state, runtime: live.runtime }), [state, live.runtime]);
  expect(live.runtime.isStarted() || live.states.length > 0).toBe(true);
  expect(value.state === null || live.states.includes(value.state)).toBe(true);
  return <LiveValueProvider value={value}>{children}</LiveValueProvider>;
}

/** The provider's <Activity>: the test hides it and shows it again (what Fast Refresh does to its effects). */
export const visibility = { set: (mode: 'visible' | 'hidden'): void => expect(mode).toBe('mounted first') };

/** An <Activity> around the provider, visible until the test hides it through visibility.set. */
function Hideable({ children }: { readonly children: ReactNode }) {
  const [mode, setMode] = useState<'visible' | 'hidden'>('visible');
  useEffect(() => {
    visibility.set = (next) => setMode(next);
  }, []);
  expect(['visible', 'hidden']).toContain(mode);
  expect(children).toBeDefined();
  return <Activity mode={mode}>{children}</Activity>;
}

/** What mountWalks puts around and beside the provider. */
export type MountOptions = {
  /** A started live runtime (liveRuntime()): useLive() offers it, with its latest state, to everything inside. */
  readonly live?: LiveRig;
  /** Rendered inside the provider beside the consumers: a screen that reads the provider, like Diagnostics. */
  readonly beside?: ReactNode;
};

/** The provider (fed `fetchWalk`; its default fetch when undefined) in its <Activity>, under the REAL UserLocationProvider, around the consumers; the rendered tree. */
export async function mountWalks(fetchWalk: WalkFetch | undefined, sets: Readonly<Record<string, readonly WalkStop[]>>, initially: readonly string[], options: MountOptions = {}): Promise<ReactTestRenderer> {
  const provider = (
    <Hideable>
      <RoutedWalkProvider fetchWalk={fetchWalk}>
        <StatusProbe />
        <Consumers sets={sets} initially={initially} />
        {options.beside}
      </RoutedWalkProvider>
    </Hideable>
  );
  const inner: ReactNode = options.live === undefined ? provider : <LiveRigValue live={options.live}>{provider}</LiveRigValue>;
  const tree = await renderPrimitive(<UserLocationProvider>{inner}</UserLocationProvider>);
  expect(tree.root.findAll((node) => node.props.testID === `probe-${initially[0] ?? ''}`)).not.toHaveLength(0);
  expect(location().watchers.length).toBeLessThanOrEqual(1);
  return tree;
}

/** The mocked expo-location (walk-location.ts), as the test file handed it to jest.mock. */
export function location(): LocationFake {
  const fake = jest.requireMock<LocationFake>('expo-location');
  expect(Array.isArray(fake.watchers)).toBe(true);
  expect(fake.rider).toBeDefined();
  return fake;
}

/** The fake clock moved `seconds` times by 1 s, each in its own act. */
export async function step(seconds: number): Promise<void> {
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
export async function stepUntil(atS: number): Promise<void> {
  const seconds = Math.max(0, Math.ceil(atS - Date.now() / 1000));
  await step(seconds);
  expect(Date.now() / 1000).toBeGreaterThanOrEqual(atS);
  expect(Date.now() / 1000 - atS).toBeLessThan(1);
}

/** The rider moves to `at`: the one watch reports it. */
export async function moveTo(at: LatLon): Promise<void> {
  const fake = location();
  fake.rider.at = at;
  await act(async () => [...fake.watchers].forEach((onFix) => onFix({ coords: at, timestamp: Date.now() })));
  expect(fake.watchers).toHaveLength(1);
  expect([...riderSeen.values()].some((rider) => rider.latitude === at.latitude && rider.longitude === at.longitude)).toBe(true);
}

/** The walk consumer `name` last saw to `stop`. */
export function walkSeen(name: string, stop: WalkStop): WalkEstimate {
  const walk = seen.get(name)?.[stop.stopId];
  expect(walk).toBeDefined();
  expect(walk?.walkMeters).toBeGreaterThan(0);
  return walk as WalkEstimate;
}

/** When request `i` was made, epoch s (the fake wall clock). */
export function askedAt(asked: readonly Asked[], i: number): number {
  const request = asked[i];
  expect(request).toBeDefined();
  expect(i === 0 || (request as Asked).atS > (asked[i - 1] as Asked).atS).toBe(true);
  return (request as Asked).atS;
}

/** A fresh start for the next case: no rider, the app in the foreground, nothing seen. */
export function resetRig(): void {
  location().rider.at = null;
  Object.assign(AppState, { currentState: 'active' });
  [seen, riderSeen].forEach((map) => map.clear());
  statusSeen.latest = null;
  expect(seen.size + riderSeen.size).toBe(0);
  expect(AppState.currentState).toBe('active');
}
