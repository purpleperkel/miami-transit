import { fetch as expoFetch } from 'expo/fetch';
import * as Location from 'expo-location';
import { act, type ReactTestRenderer } from 'react-test-renderer';

import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import type { LatLon } from '../../../lib/geo';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { PLAN_TICK_MS, PlanScreen } from '../PlanScreen';
import { type RecentPlace, recordRecentPlace } from '../recent-places';
import { ASKED_AT_S, END, START } from './route-fixtures';

// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(), watchPositionAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * mfix5: the REAL route options sheet stays honest while it is open. It asks Transitous through the app's
 * ONE polite client (plan-client.ts → expo/fetch, stood in for here by the committed fixture), and once
 * its first option has left — the 2:01 → 2:21 option boards the Government Center Mover at 2:06 — it asks
 * again, ONCE: the re-plan's own answer (the same capture, whose trains have all left) must not ask a
 * third time. The sheet's clock, its debounce and its timers run on jest's fake timers, from 2:00 PM.
 */

/** The first option boards the Mover at 2:06, 360 s after the fixture's 2:00 PM query time. */
const FIRST_OPTION_LEAVES_S = ASKED_AT_S + 360;

beforeEach(() => {
  jest.useFakeTimers({ now: ASKED_AT_S * 1000 });
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
  jest.clearAllMocks();
});

/** expo-location grants and fixes the rider at `at`; expo/fetch answers every request with the fixture. */
function riderAndTransitous(at: LatLon): void {
  jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' } as Location.LocationPermissionResponse);
  jest.mocked(Location.getCurrentPositionAsync).mockResolvedValue({ coords: { ...at, altitude: null, accuracy: 10, altitudeAccuracy: null, heading: null, speed: null }, timestamp: ASKED_AT_S * 1000 });
  jest.mocked(expoFetch).mockImplementation(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(fixture) }) as unknown as Awaited<ReturnType<typeof expoFetch>>);
  expect(jest.mocked(expoFetch)).not.toHaveBeenCalled();
  expect(Date.now()).toBe(ASKED_AT_S * 1000);
}

/** The fake clock moves at most this far per act(): React renders (and runs effects) only as an act() ends. */
const STEP_MS = 1_000;

/**
 * Runs the fake clock `ms` forward a second at a time, as the phone's clock would: each step lets the
 * sheet's timers fire, their promises settle and React render, before the next.
 */
async function advance(ms: number): Promise<void> {
  const before = Date.now();
  expect(ms).toBeGreaterThanOrEqual(0);
  for (let done = 0; done < ms; done += STEP_MS) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - done));
    });
  }
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(Date.now()).toBe(before + ms);
}

/** The sheet, open from the rider's location, with `to` chosen from the recent places and its first answer in. */
async function openSheetTo(to: RecentPlace): Promise<ReactTestRenderer> {
  expect(recordRecentPlace(to).ok).toBe(true);
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <PlanScreen fromStation={null} />
    </UserLocationProvider>,
  );
  await advance(0);
  await press(tree, 'plan-recent-0');
  // The polite client's 400 ms debounce, then its one request.
  await advance(1_000);
  expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(1);
  expect(hostsByTestID(tree.root, /^route-option-\d+$/)).toHaveLength(6);
  return tree;
}

/** The query time (`time=`) of each request the sheet sent, in order. */
function askedTimes(): string[] {
  const times = jest.mocked(expoFetch).mock.calls.map(([url]) => /[?&]time=([^&]+)/.exec(String(url))?.[1] ?? '');
  expect(times.every((time) => time.length > 0)).toBe(true);
  expect(times.length).toBe(jest.mocked(expoFetch).mock.calls.length);
  return times;
}

describe('the open route options sheet after its first option leaves (mfix5)', () => {
  it('the open plan sheet re-plans once after its first option departs', async () => {
    riderAndTransitous(START);
    await openSheetTo(END);
    // Up to a second before the Mover leaves, the sheet asks nothing more.
    await advance((FIRST_OPTION_LEAVES_S - 1) * 1000 - Date.now());
    expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(1);
    // Its next 15 s tick sees the Mover gone and asks again, for now: a new minute, a new cache key.
    await advance(PLAN_TICK_MS + 2_000);
    expect(askedTimes()).toEqual(['2026-10-02T18:00:00.000Z', '2026-10-02T18:06:15.000Z']);
    // The re-plan's answer had already left when it came: no third ask, however long the sheet stays open.
    await advance(150_000);
    expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(2);
  });
});

describe('an open itinerary and the re-plan (mfix5)', () => {
  it('the sheet holds its re-plan while an option is open, and asks once the rider is back on the options', async () => {
    // Another start than the case above, so the app's one client has nothing cached for it.
    riderAndTransitous({ latitude: START.latitude + 0.001, longitude: START.longitude });
    const tree = await openSheetTo(END);
    await press(tree, 'route-option-0');
    expect(hostsByTestID(tree.root, 'itinerary-detail')).toHaveLength(1);
    // The rider reads the legs of the trip they are on: the Mover leaves, the sheet keeps the legs open.
    await advance((FIRST_OPTION_LEAVES_S + 60) * 1000 - Date.now());
    expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(1);
    expect(hostsByTestID(tree.root, 'itinerary-detail')).toHaveLength(1);
    await press(tree, 'itinerary-back');
    await advance(2_000);
    expect(askedTimes()).toEqual(['2026-10-02T18:00:00.000Z', '2026-10-02T18:07:00.000Z']);
    await advance(150_000);
    expect(jest.mocked(expoFetch)).toHaveBeenCalledTimes(2);
  });
});
