import * as Location from 'expo-location';
import { router } from 'expo-router';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';

import { closeScheduleCopy } from '../../../data/__tests__/schedule-sqlite-fake';
import { ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { locateAt } from '../../location/__tests__/located';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { FromStep, ToStep } from '../add/AddTripSteps';
import { closeTripDbs, realScheduleRepo } from './trip-db';

// test-time mock of native module
jest.mock('expo-sqlite', () => jest.requireActual('../../../data/__tests__/schedule-sqlite-fake').scheduleSqliteModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), watchPositionAsync: jest.fn() }));

/**
 * mfix7 fix 2 (Jamie's 07:10 recording): the add-trip pickers. "Leaving from" was one long alphabetical list;
 * with the app's ONE location provider holding a fix it now lists the nearest stations first (m6b's
 * orderStations), and without one keeps the schedule's order. "Going to" from Brickell City Centre opened on a
 * wall of greyed-out Metrorail rows; now every reachable destination comes first and every other station sits
 * in ONE trailing "Needs a transfer" group. The schedule is the REAL committed DB, under the REAL provider.
 */

/** The off-line point of Jamie's recording, ~400 m from the Metromover (the arbiter's capture start). */
const NEAR_BRICKELL = { latitude: 25.7645, longitude: -80.1897 };
const ORIGIN = 'mover:brickell-city-centre';

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});
afterAll(() => {
  closeScheduleCopy();
  closeTripDbs();
});

/** Lets the schedule DB open, the location ask answer and the watch fix (zero-timeouts inside act). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  expect(jest.isMockFunction(Location.watchPositionAsync)).toBe(true);
  expect(jest.isMockFunction(Location.requestForegroundPermissionsAsync)).toBe(true);
}

/** The REAL "Leaving from" step under the real providers, with the rider at `at` (null: location refused). */
async function renderFrom(at: typeof NEAR_BRICKELL | null): Promise<ReactTestRenderer> {
  locateAt(Location, at);
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <FromStep />
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await settle();
  expect(hostsByTestID(tree.root, 'add-trip-from')).toHaveLength(1);
  expect(hostsByTestID(tree.root, 'add-trip-wait')).toHaveLength(0);
  return tree;
}

/** The REAL "Going to" step from Brickell City Centre, under the real schedule provider. */
async function renderTo(): Promise<ReactTestRenderer> {
  const tree = await renderPrimitive(
    <ScheduleDbProvider>
      <ToStep from={ORIGIN} />
    </ScheduleDbProvider>,
  );
  await settle();
  expect(hostsByTestID(tree.root, 'add-trip-to')).toHaveLength(1);
  expect(hostsByTestID(tree.root, 'add-trip-wait')).toHaveLength(0);
  return tree;
}

/** The station keys of the pick rows under `root`, top to bottom. */
function pickKeys(root: ReactTestInstance): string[] {
  const keys = hostsByTestID(root, /^pick-(rail|mover):[a-z0-9-]+$/).map((node) => String(node.props.testID).slice('pick-'.length));
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every((key) => key.includes(':'))).toBe(true);
  return keys;
}

/** A row's "Metromover · 360 m" read back as metres. */
function metresOf(detail: string): number {
  const match = /· (\d+(?:\.\d)?) (k?m)$/.exec(detail);
  expect(match).not.toBeNull();
  const metres = Number(match?.[1]) * (match?.[2] === 'km' ? 1000 : 1);
  expect(Number.isFinite(metres)).toBe(true);
  return metres;
}

describe('add-trip "Leaving from" (mfix7)', () => {
  it('leaving from lists the nearest stations first when the location is known', async () => {
    const tree = await renderFrom(NEAR_BRICKELL);
    const keys = pickKeys(tree.root);
    expect(keys).toHaveLength(realScheduleRepo().stations().length);
    // Metromover first, although the schedule lists Metrorail first: 291 m, 360 m, 558 m from the rider.
    expect(keys.slice(0, 3)).toEqual(['mover:tenth-street-promanade', 'mover:brickell-city-centre', 'mover:financial-district']);
    const details = keys.map((key) => hostsByTestID(tree.root, `pick-distance-${key}`)[0]?.props.children as string);
    expect(details.slice(0, 3)).toEqual(['Metromover · 290 m', 'Metromover · 360 m', 'Metromover · 560 m']);
    const metres = details.map(metresOf);
    expect(metres.every((m, i) => i === 0 || m >= (metres[i - 1] as number))).toBe(true);
    expect(hostsByTestID(tree.root, 'pick-mover:brickell-city-centre')[0]?.props.accessibilityLabel).toBe('Brickell City Centre, Metromover, 360 m');
  });

  it('leaving from keeps the schedule order without a location', async () => {
    const tree = await renderFrom(null);
    const scheduleOrder = realScheduleRepo()
      .stations()
      .map((station) => station.stationKey);
    expect(pickKeys(tree.root)).toEqual(scheduleOrder);
    expect(hostsByTestID(tree.root, /^add-trip-from-(rail|mover)$/).map((node) => node.props.testID)).toEqual(['add-trip-from-rail', 'add-trip-from-mover']);
    expect(hostsByTestID(tree.root, /^pick-distance-/)).toHaveLength(0);
    expect(hostsByTestID(tree.root, 'add-trip-from-nearest')).toHaveLength(0);
  });
});

describe('add-trip "Going to" (mfix7)', () => {
  it('going to lists every reachable destination before any unreachable one', async () => {
    const reach = realScheduleRepo().directReachable(ORIGIN);
    const direct = reach.ok ? reach.value.direct.map((station) => station.stationKey) : [];
    expect(direct.length).toBeGreaterThan(0);
    const tree = await renderTo();
    // Collapsed: the list opens on the reachable destinations alone, every one a button.
    expect(pickKeys(tree.root)).toEqual(direct);
    expect(direct.every((key) => hostsByTestID(tree.root, `pick-${key}`)[0]?.props.accessibilityRole === 'button')).toBe(true);
    await press(tree, 'add-trip-to-transfer-toggle');
    const all = pickKeys(tree.root);
    expect(all.slice(0, direct.length)).toEqual(direct);
    expect(all.slice(direct.length).some((key) => direct.includes(key))).toBe(false);
    expect(all.slice(direct.length).every((key) => hostsByTestID(tree.root, `pick-${key}`)[0]?.props.accessibilityState?.disabled === true)).toBe(true);
  });

  it('going to gathers every unreachable station in one trailing needs a transfer group', async () => {
    const reach = realScheduleRepo().directReachable(ORIGIN);
    const excluded = reach.ok ? reach.value.excluded.map((e) => e.station.stationKey) : [];
    expect(excluded.length).toBeGreaterThan(20);
    const tree = await renderTo();
    const groups = hostsByTestID(tree.root, 'add-trip-to-transfer');
    expect(groups).toHaveLength(1);
    expect(hostsByTestID(tree.root, 'add-trip-to-transfer-toggle')[0]?.props.accessibilityLabel).toBe(`Needs a transfer, ${excluded.length} stations`);
    await press(tree, 'add-trip-to-transfer-toggle');
    const group = hostsByTestID(tree.root, 'add-trip-to-transfer')[0] as ReactTestInstance;
    expect([...pickKeys(group)].sort()).toEqual([...excluded].sort());
    // Trailing: the group is the list's last part, so no pickable row follows it.
    expect(pickKeys(tree.root).slice(-excluded.length)).toEqual(pickKeys(group));
    expect(hostsByTestID(group, 'add-trip-to-transfer-why').map((node) => node.props.children)).toEqual(['Needs a transfer, so no single train goes there. Route options can plan it.']);
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    await press(tree, 'add-trip-to-transfer-route-options');
    expect(push.mock.calls).toEqual([[{ pathname: '/plan', params: { fromStation: ORIGIN } }]]);
  });
});
