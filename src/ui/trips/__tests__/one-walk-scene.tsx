import { BottomAccessoryPlacementContext } from 'expo-router/build/native-tabs/hooks';
import { AppState } from 'react-native';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { SavedTrip } from '../../../data/saved-trips-repo';
import { ScheduleDbProvider } from '../../../data/schedule-db-provider';
import { UserDbProvider } from '../../../data/user-db-provider';
import type { LatLon } from '../../../lib/geo';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { NowAccessory } from '../../now/NowAccessory';
import { hostsByTestID, renderPrimitive } from '../../primitives/__tests__/render-primitive';
import { RoutedWalkProvider, type WalkFetch } from '../../walk/RoutedWalkProvider';
import type { LocationFake } from '../../walk/__tests__/walk-location';
import { TripDetail } from '../TripScreen';
import { TripsTab } from '../TripsTab';
import { memoryUserRepos, savedTrip } from './trip-db';

/**
 * mfix11's scene (mfix9's, in PUBLIC data): the saved trip Fifth Street → Bayfront Park, which boards at platform 805,
 * 342 m from GTFS stop 815 (Third Street, where the rider stands) and 710.6 m along the streets of the committed
 * Transitous capture; T is 05:26:50 on Wednesday 2026-09-30, 430 s before the first ride from 805. The REAL Now bar,
 * Trips tab and trip screen render in ONE tree — under the walk provider when the test injects a fetchWalk — so one
 * saved trip's walk can be read off all three. Each test file mocks the native modules: expo-sqlite (the committed
 * schedule DB through node:sqlite), expo-sqlite/kv-store (settings/__tests__/native-fakes.ts) and expo-location
 * (walk/__tests__/walk-location.ts, whose `rider` places the rider and whose `watchers` report a newer fix).
 */

export const FIFTH = 'mover:fifth-street';
export const BAYFRONT = 'mover:bayfront-park';
export const T = Date.parse('2026-09-30T05:26:50-04:00') / 1000;
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
const SETTINGS = { boardBufferS: 120, reminderLeadS: 0 };

/** The saved trip Fifth Street → Bayfront Park, with `extra` (its own walk minutes, a saved start). */
export function fifthToBayfront(extra: Partial<SavedTrip> = {}): SavedTrip {
  const trip = savedTrip('fifth', FIFTH, BAYFRONT, { createdEpoch: 1_790_000_100, ...extra });
  expect(trip.fromStationKey).toBe(FIFTH);
  expect(trip.toStationKey).toBe(BAYFRONT);
  return trip;
}

/** What to render: the bar alone or with both cards, in a placement, under the walk provider when `fetchWalk` is given. */
export type SceneOptions = { readonly fetchWalk: WalkFetch | null; readonly placement?: 'regular' | 'inline'; readonly cards?: boolean; readonly clock?: () => number };

/** The REAL bar (and, by default, the Trips tab and the trip screen) for `trip`, saved through the real repo, at T. */
export async function renderScene(trip: SavedTrip, { fetchWalk, placement = 'regular', cards = true, clock = () => T }: SceneOptions): Promise<ReactTestRenderer> {
  Object.assign(AppState, { currentState: 'active' });
  const repos = memoryUserRepos();
  expect(repos.ok && repos.value.trips.create(trip).ok).toBe(true);
  const screens = (
    <>
      <BottomAccessoryPlacementContext.Provider value={placement}>
        <NowAccessory clock={clock} />
      </BottomAccessoryPlacementContext.Provider>
      {cards ? <TripsTab clock={clock} /> : null}
      {cards ? <TripDetail trip={trip} settings={SETTINGS} remove={() => true} clock={clock} /> : null}
    </>
  );
  const tree = await renderPrimitive(
    <UserLocationProvider>
      <ScheduleDbProvider>
        <UserDbProvider open={() => repos}>
          <LiveValueProvider value={NO_LIVE}>{fetchWalk === null ? screens : <RoutedWalkProvider fetchWalk={fetchWalk}>{screens}</RoutedWalkProvider>}</LiveValueProvider>
        </UserDbProvider>
      </ScheduleDbProvider>
    </UserLocationProvider>,
  );
  await settle(tree);
  expect(hostsByTestID(tree.root, 'now-accessory')).toHaveLength(1);
  return tree;
}

/** Lets every pending effect, fix and injected walk answer land, the scene still mounted and in the foreground. */
async function settle(tree: ReactTestRenderer): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  expect(tree.toJSON()).not.toBeNull();
  expect(AppState.currentState).toBe('active');
}

/** The rider moves: the one watch reports a NEWER fix at `to`, as expo-location does, and `tree` re-renders. */
export async function moveRider(tree: ReactTestRenderer, location: LocationFake, to: LatLon): Promise<void> {
  const watch = location.watchers[0];
  expect(location.watchers).toHaveLength(1); // the app's one watch is running
  expect(location.rider.at).not.toEqual(to); // a "move" to where the rider already is would prove nothing
  location.rider.at = to;
  await act(async () => watch?.({ coords: to, timestamp: Date.now() + 30_000 }));
  await settle(tree);
}

/** The bar's lines and what VoiceOver hears of it. */
export function barOf(tree: ReactTestRenderer): { readonly lines: string[]; readonly label: string } {
  const button = hostsByTestID(tree.root, 'now-accessory')[0] as ReactTestInstance;
  const texts = button.findAll((node) => (node.type as unknown) === 'Text');
  expect(texts.length).toBeGreaterThan(0);
  expect(typeof button.props.accessibilityLabel).toBe('string');
  return { lines: texts.map((node) => String(node.props.children)), label: String(button.props.accessibilityLabel) };
}

/** The walk as each screen shows it: the bar's "~N min walk" (or "N min walk"), then each card's "a N min walk …". */
export function walksShown(tree: ReactTestRenderer): string[] {
  const bar = barOf(tree).lines[1] ?? '';
  const walk = bar.slice(bar.lastIndexOf(' · ') + 3);
  expect(bar).toContain(' · ');
  expect(walk).toMatch(/^~?\d+ min walk$/);
  return [walk, ...cardWalks(tree)];
}

/** Each card's walk (the Trips tab's, then the trip screen's): "a N min walk from here / from your start / (your setting)". */
export function cardWalks(tree: ReactTestRenderer): string[] {
  const rides = hostsByTestID(tree.root, 'countdown-hero-ride').map((host) => String(host.props.children));
  expect(rides).toHaveLength(2);
  expect(rides.every((ride) => ride.includes(' train, arrives '))).toBe(true);
  return rides.map((ride) => ride.slice(ride.lastIndexOf(' · ') + 3));
}
