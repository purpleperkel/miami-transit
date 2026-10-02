import { type ReactNode, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { act } from 'react-test-renderer';

import type { LiveError } from '../../../domain/live/types';
import { transitousUserAgent } from '../../../domain/routes/transitous';
import { WALK_ROUTER_URL } from '../../../domain/walk/one-to-many';
import type { WalkEstimate, WalkStop } from '../../../domain/walk/walk-cache';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { err, ok, type Result } from '../../../lib/result';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
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
 * GTFS stop 815 (Third Street); the stops are the committed capture's five Metromover targets.
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
 * What the fake answers next: street walks (twice the straight line), an answer held until release(), a failure, or a
 * broken contract — 'throwing' (an answer whose value throws when read) or 'rejecting' (a rejected promise).
 */
export type Answer = 'walks' | 'held' | 'throwing' | 'rejecting' | LiveError;

/** The injected fetchWalk: records each request and answers from `script` in order, then with street walks. */
export function scriptedWalks(script: Answer[] = []) {
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
    return answerOf(script.shift() ?? 'walks', one, many, held);
  };
  return { asked, fetchWalk, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

/** The fake's answer to one request (see Answer). */
function answerOf(next: Answer, one: LatLon, many: readonly LatLon[], held: (() => void)[]): ReturnType<WalkFetch> {
  const walks = ok(many.map((target) => ({ duration: 1, distance: 2 * haversineMeters(one, target) })));
  expect(many.length).toBeGreaterThan(0);
  expect(held.length).toBeLessThanOrEqual(1);
  if (next === 'held') {
    return new Promise((resolve) => held.push(() => resolve(walks)));
  }
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

/** The provider (fed `fetchWalk`; its default fetch when undefined) under the REAL UserLocationProvider around the consumers; under `live` when given. */
export async function mountWalks(fetchWalk: WalkFetch | undefined, sets: Readonly<Record<string, readonly WalkStop[]>>, initially: readonly string[], live?: LiveContextValue): Promise<void> {
  const provider = (
    <RoutedWalkProvider fetchWalk={fetchWalk}>
      <StatusProbe />
      <Consumers sets={sets} initially={initially} />
    </RoutedWalkProvider>
  );
  const inner: ReactNode = live === undefined ? provider : <LiveValueProvider value={live}>{provider}</LiveValueProvider>;
  const tree = await renderPrimitive(<UserLocationProvider>{inner}</UserLocationProvider>);
  expect(tree.root.findAll((node) => node.props.testID === `probe-${initially[0] ?? ''}`)).not.toHaveLength(0);
  expect(location().watchers.length).toBeLessThanOrEqual(1);
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
