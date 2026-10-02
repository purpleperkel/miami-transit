import { NativeTabs } from 'expo-router/unstable-native-tabs';

import TabsLayout from '@/app/(tabs)/_layout';
import StationsRoute from '@/app/(tabs)/stations/index';
import TripsRoute from '@/app/(tabs)/trips/index';
import type { StationListing } from '@/data/schedule-queries';
import { REAL_STOPS } from '@/domain/network/__fixtures__/real-stops';
import { buildStations } from '@/domain/network/stations';

import { NowAccessory } from '../now/NowAccessory';
import { EmptyState } from '../primitives/EmptyState';
import { renderPrimitive, unmountAll } from '../primitives/__tests__/render-primitive';
import { stationList, type StationList } from '../stations/station-list';
import { StationsScreen, StationsView, type StationsViewProps } from '../stations/StationsScreen';
import { appRoutes, childLayout, elementsOf, textOf } from './app-tree';

/**
 * M5.5: the tab shell. The layout's element tree is walked (it has no hooks), its Trigger names are
 * checked against the route names expo-router builds from the real files, and each tab's screen is
 * rendered with react-test-renderer.
 */

afterEach(async () => {
  await unmountAll();
});

/** The stations the feed's stops cluster into (M2.9) — the set the real-DB test proves the DB lists. */
function realStations(): StationListing[] {
  const built = buildStations(REAL_STOPS);
  expect(built.ok).toBe(true);
  const stations = built.ok ? built.value.stations : [];
  expect(stations).toHaveLength(44);
  return stations.map((s) => ({ stationKey: s.key, name: s.name, mode: s.mode, coordinate: { latitude: s.latitude, longitude: s.longitude } }));
}

/**
 * The Stations list over those stations. Each row's line strip and next departures come from the
 * schedule DB (station-list-real.test.ts proves them on the real one); here every rail station gets the
 * Green strip, every Mover station the Inner Loop's, and nothing is departing.
 */
function listOf(stations: readonly StationListing[]): StationList {
  const lines = new Map(stations.map((s) => [s.stationKey, s.mode === 'rail' ? (['GREEN'] as const) : (['MM_INNER'] as const)]));
  const list = stationList({ stations: () => stations, stationLines: () => lines, nextDepartures: () => ({ kind: 'next-departures', byStation: new Map() }) }, 1_790_769_600);
  expect(list.sections.map((section) => section.title)).toEqual(['Metrorail', 'Metromover']);
  expect(list.gap).toBeNull();
  return list;
}

/** StationsView's props for `state`: 08:00 Wednesday, no location (the list keeps its line order), taps ignored. */
function viewProps(state: StationsViewProps['state']): StationsViewProps {
  const props: StationsViewProps = { state, nowS: 1_790_769_600, location: { coordinate: null, takenAtMs: null, note: null }, onOpen: jest.fn() };
  expect(props.location.coordinate).toBeNull();
  expect(typeof props.onOpen).toBe('function');
  return props;
}

describe('the tab shell (M5.5)', () => {
  it('tabs are Map, Trips and Stations in order', () => {
    const triggers = elementsOf(TabsLayout()).filter((element) => element.type === NativeTabs.Trigger);
    const labels = triggers.map((trigger) => {
      const label = elementsOf(trigger).find((element) => element.type === NativeTabs.Trigger.Label);
      expect(label).toBeDefined();
      return textOf(label as NonNullable<typeof label>);
    });
    expect(labels).toEqual(['Map', 'Trips', 'Stations']);
    const names = triggers.map((trigger) => trigger.props.name);
    expect(names).toEqual(['index', 'trips', 'stations']);
    // Each Trigger names a route expo-router really builds in the (tabs) group, and every tab route has one.
    const routes = childLayout(appRoutes(), '(tabs)').children.map((child) => child.route);
    expect([...routes].sort()).toEqual([...names].sort());
  });

  it('keeps the BottomAccessory', () => {
    const elements = elementsOf(TabsLayout());
    const accessories = elements.filter((element) => element.type === NativeTabs.BottomAccessory);
    expect(accessories).toHaveLength(1);
    const inside = elementsOf(accessories[0] as NonNullable<(typeof accessories)[0]>);
    expect(inside.some((element) => element.type === NowAccessory)).toBe(true);
  });
});

describe('the tab screens (M5.5)', () => {
  it('Trips shows the EmptyState No trips yet', async () => {
    const tree = await renderPrimitive(<TripsRoute />);
    const empty = tree.root.findByType(EmptyState);
    expect(empty.props.title).toBe('No trips yet');
    expect(JSON.stringify(tree.toJSON())).toContain('"No trips yet"');
  });

  it('Stations renders one row per station', async () => {
    const stations = realStations();
    // Two sections, Metrorail then Metromover, each in the order the DB lists them.
    const listed = [...stations.filter((s) => s.mode === 'rail'), ...stations.filter((s) => s.mode === 'mover')];
    const tree = await renderPrimitive(<StationsView {...viewProps({ kind: 'ready', list: listOf(stations) })} />);
    const rows = tree.root.findAll((node) => typeof node.type === 'string' && /^station-row-(rail|mover):[a-z0-9-]+$/.test(String(node.props.testID)));
    expect(rows).toHaveLength(stations.length);
    expect(rows.map((row) => row.props.testID)).toEqual(listed.map((station) => `station-row-${station.stationKey}`));
    expect(rows.map((row) => String(row.props.accessibilityLabel).split(';')[0])).toEqual(
      listed.map((station) => `${station.name}, ${station.mode === 'rail' ? 'Metrorail' : 'Metromover'}`),
    );
  });

  it('the Stations route renders the screen that reads the schedule DB; until it opens, the list says so', async () => {
    expect(StationsRoute().type).toBe(StationsScreen);
    const opening = await renderPrimitive(<StationsView {...viewProps({ kind: 'opening' })} />);
    expect(opening.root.findByType(EmptyState).props.title).toBe('Opening the schedule');
    const failed = await renderPrimitive(<StationsView {...viewProps({ kind: 'failed', message: 'the schedule DB did not open: disk full' })} />);
    expect(failed.root.findByType(EmptyState).props.message).toBe('the schedule DB did not open: disk full');
    expect(failed.root.findAll((node) => String(node.props.testID).startsWith('station-row-'))).toHaveLength(0);
  });
});
