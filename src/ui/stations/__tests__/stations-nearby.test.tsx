import { fetch as expoFetch } from 'expo/fetch';
import * as Location from 'expo-location';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { closeScheduleCopy } from '../../../data/__tests__/schedule-sqlite-fake';
import { ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { LIVE_VEHICLES_FIXTURE_BYTES } from '../../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { FakeServer, runtimeNetwork, TL_VEHICLES_URL } from '../../../live/__tests__/live-fakes';
import type { FetchFn } from '../../../live/http';
import type { SecretStore } from '../../../live/keys';
import { LiveValueProvider } from '../../../live/live-context';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import type { LatLon } from '../../../lib/geo';
import { locateAt } from '../../location/__tests__/located';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { StationsScreen } from '../StationsScreen';
import { WED_0800 } from './station-fixtures';

// test-time mock of native module
jest.mock('expo-sqlite', () => jest.requireActual('../../../data/__tests__/schedule-sqlite-fake').scheduleSqliteModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), watchPositionAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

/**
 * mfix7 fix 3 (Jamie's 07:10 recording: Metrorail's Brickell, 530 m, sat above his nearest station, a Metromover
 * stop, because the list ordered nearest first only WITHIN a mode). The REAL Stations tab — StationsScreen under
 * the REAL ScheduleDbProvider over the committed schedule DB, inside the app's ONE UserLocationProvider (its
 * expo-location answer is the only thing stood in) — opens, with a location, on a "Nearby" section of the 3
 * nearest stations of ANY mode, then the Metrorail and Metromover sections as before; and it still asks for no
 * live prediction (R7, the REALTIME COST RULE): a Nearby row reads the local timetable only.
 */

/** Jamie's off-line point near Brickell (the route capture's start): the 3 nearest stations are all Metromover. */
const NEAR_BRICKELL: LatLon = { latitude: 25.7645, longitude: -80.1897 };
const NEARBY_ROW = /^nearby-row-(rail|mover):[a-z0-9-]+$/;

const runtimes: LiveRuntime[] = [];
const trees: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  runtimes.splice(0, runtimes.length).forEach((runtime) => runtime.stop());
  await unmountAll();
  expect(trees).toHaveLength(0);
  expect(runtimes).toHaveLength(0);
});
afterAll(() => closeScheduleCopy());

/** Lets the schedule DB open, the location ask answer, the watch fix and the effects run (zero-timeouts inside act). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  expect(trees.length).toBeLessThanOrEqual(1);
  expect(jest.isMockFunction(Location.watchPositionAsync)).toBe(true);
}

/** The REAL Stations tab at 8:00 on a Wednesday, the rider at `at` (null: location refused). */
async function renderStations(at: LatLon | null): Promise<ReactTestRenderer> {
  locateAt(Location, at);
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <StationsScreen clock={() => WED_0800} />
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await settle();
  expect(hostsByTestID(tree.root, /^station-row-(rail|mover):[a-z0-9-]+$/)).toHaveLength(44);
  expect(hostsByTestID(tree.root, /^stations-section-(rail|mover)$/)).toHaveLength(2);
  return tree;
}

/** The station keys of the rows matching `rows` under `root`, top to bottom. */
function rowKeys(root: ReactTestInstance, rows: RegExp): string[] {
  const keys = hostsByTestID(root, rows).map((node) => String(node.props.testID).replace(/^(nearby|station)-row-/, ''));
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every((key) => key.includes(':'))).toBe(true);
  return keys;
}

/** The texts under one host node, in order. */
function textsIn(node: ReactTestInstance | undefined): string[] {
  expect(node).toBeDefined();
  const texts = (node as ReactTestInstance).findAll((n) => (n.type as unknown) === 'Text' && typeof n.props.children === 'string').map((n) => n.props.children as string);
  expect(Array.isArray(texts)).toBe(true);
  return texts;
}

describe('the Stations tab with a location: Nearby (mfix7)', () => {
  it('with a location the stations tab opens on a nearby section of the 3 nearest stations of any mode', async () => {
    const tree = await renderStations(NEAR_BRICKELL);
    expect(hostsByTestID(tree.root, /^stations-section-/).map((node) => node.props.testID)).toEqual(['stations-section-nearby', 'stations-section-rail', 'stations-section-mover']);
    const nearby = hostsByTestID(tree.root, 'stations-section-nearby')[0] as ReactTestInstance;
    expect(textsIn(nearby)[0]).toBe('Nearby');
    // Metromover first although Metrorail is the first mode group: 291 m, 360 m, 558 m (Metrorail's Brickell is 530+ m).
    expect(rowKeys(nearby, NEARBY_ROW)).toEqual(['mover:tenth-street-promanade', 'mover:brickell-city-centre', 'mover:financial-district']);
    expect(rowKeys(tree.root, NEARBY_ROW)).toHaveLength(3);
  });

  it('nearby rows show their walking distance and next departures inline', async () => {
    const tree = await renderStations(NEAR_BRICKELL);
    const keys = rowKeys(tree.root, NEARBY_ROW);
    expect(keys.map((key) => hostsByTestID(tree.root, `nearby-row-distance-${key}`)[0]?.props.children)).toEqual(['290 m', '360 m', '560 m']);
    for (const key of keys) {
      const inline = hostsByTestID(tree.root, new RegExp(`^nearby-row-next-${key}-[01]$`));
      // Each Nearby row is the station's own row: the same next scheduled departures as in its mode's section.
      expect(inline.length).toBeGreaterThan(0);
      expect(inline.map(textsIn)).toEqual(hostsByTestID(tree.root, new RegExp(`^station-row-next-${key}-[01]$`)).map(textsIn));
    }
    expect(textsIn(hostsByTestID(tree.root, 'nearby-row-next-mover:brickell-city-centre-0')[0])).toHaveLength(2);
  });

  it('at a mixed point the nearby section lists both metromover and metrorail stations', async () => {
    // Government Center: the Metromover and Metrorail stations of that name, and Miami Avenue (184 m, 203 m, 217 m).
    const tree = await renderStations({ latitude: 25.7743, longitude: -80.1955 });
    const keys = rowKeys(tree.root, NEARBY_ROW);
    expect(keys).toEqual(['mover:government-center', 'rail:government-ctr', 'mover:miami-avenue']);
    expect(new Set(keys.map((key) => key.split(':')[0]))).toEqual(new Set(['mover', 'rail']));
    expect(keys.map((key) => hostsByTestID(tree.root, `nearby-row-distance-${key}`)[0]?.props.children)).toEqual(['180 m', '200 m', '220 m']);
  });
});

describe('the Stations tab without a location (mfix7)', () => {
  it('without a location the stations tab shows no nearby section', async () => {
    const tree = await renderStations(null);
    expect(hostsByTestID(tree.root, /^stations-section-/).map((node) => node.props.testID)).toEqual(['stations-section-rail', 'stations-section-mover']);
    expect(hostsByTestID(tree.root, /^nearby-row-/)).toHaveLength(0);
    expect(textsIn(hostsByTestID(tree.root, 'stations-notes')[0])).toEqual(['Location is off, so stations are listed in line order.']);
  });
});

/** The fake server's fetch, telling `departures` about every departures (live prediction) request first. */
function watchedFetch(server: FakeServer, departures: jest.Mock): FetchFn {
  expect(server.requests).toEqual([]);
  expect(departures).not.toHaveBeenCalled();
  return (url, init) => {
    expect(url.startsWith('https://')).toBe(true);
    if (url.includes('/departures')) {
      departures(url);
    }
    expect(init.signal).toBeDefined();
    return server.fetch(url, init);
  };
}

/** A real runtime holding a (fake) Transitland key, started and polling; every departures request reaches `departures`. */
async function startedRuntime(departures: jest.Mock): Promise<{ readonly runtime: LiveRuntime; readonly state: () => LiveState | null }> {
  const keychain = new Map<string, string>([['live.key.transitland', 'fake-transitland-key-for-nearby-test']]);
  const states: LiveState[] = [];
  const secrets: SecretStore = {
    getItemAsync: (key) => Promise.resolve(keychain.get(key) ?? null),
    setItemAsync: (key, value) => Promise.resolve(void keychain.set(key, value)),
    deleteItemAsync: (key) => Promise.resolve(void keychain.delete(key)),
  };
  const fetch = watchedFetch(new FakeServer({ [TL_VEHICLES_URL]: { status: 200, body: LIVE_VEHICLES_FIXTURE_BYTES } }), departures);
  const quota = new Map<string, number>();
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch, keychain: secrets, quotaStore: { get: (key) => quota.get(key) ?? null, set: (key, n) => void quota.set(key, n) }, nowS: () => WED_0800 });
  runtimes.push(runtime);
  runtime.start();
  await settle();
  expect(states.length).toBeGreaterThan(0);
  expect(states[states.length - 1]?.hasKey.transitland).toBe(true);
  return { runtime, state: () => states[states.length - 1] ?? null };
}

describe('the Stations tab with a location and the live layer (mfix7, R7)', () => {
  it('with a location the stations list still makes no live prediction calls', async () => {
    const departures = jest.fn();
    const live = await startedRuntime(departures);
    const watch = jest.spyOn(live.runtime, 'watchStations');
    locateAt(Location, NEAR_BRICKELL);
    await act(async () => {
      expect(trees).toHaveLength(0);
      trees.push(
        create(
          <UserLocationProvider>
            <ScheduleDbProvider>
              <LiveValueProvider value={{ state: live.state(), runtime: live.runtime }}>
                <StationsScreen clock={() => WED_0800} />
              </LiveValueProvider>
            </ScheduleDbProvider>
          </UserLocationProvider>,
        ),
      );
      expect(trees).toHaveLength(1);
    });
    await settle();
    const tree = trees[0] as ReactTestRenderer;
    // Located: the Nearby section is drawn, its rows from the timetable.
    expect(rowKeys(tree.root, NEARBY_ROW)).toEqual(['mover:tenth-street-promanade', 'mover:brickell-city-centre', 'mover:financial-district']);
    await act(async () => live.runtime.tick());
    await settle();
    expect(expoFetch).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(departures).not.toHaveBeenCalled();
  });
});
