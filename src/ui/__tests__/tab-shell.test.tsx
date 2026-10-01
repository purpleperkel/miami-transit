import { NativeTabs } from 'expo-router/unstable-native-tabs';

import TabsLayout from '@/app/(tabs)/_layout';
import StationsRoute from '@/app/(tabs)/stations/index';
import TripsRoute from '@/app/(tabs)/trips/index';
import type { StationListing } from '@/data/schedule-queries';
import { REAL_STOPS } from '@/domain/network/__fixtures__/real-stops';
import { buildStations } from '@/domain/network/stations';

import { DataVersionAccessory } from '../diagnostics/DataVersionAccessory';
import { EmptyState } from '../primitives/EmptyState';
import { renderPrimitive, unmountAll } from '../primitives/__tests__/render-primitive';
import { StationsScreen, StationsView } from '../stations/StationsScreen';
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
    expect(names).toEqual(['index', 'trips/index', 'stations/index']);
    // Each Trigger names a route expo-router really builds in the (tabs) group, and every tab route has one.
    const routes = childLayout(appRoutes(), '(tabs)').children.map((child) => child.route);
    expect([...routes].sort()).toEqual([...names].sort());
  });

  it('keeps the BottomAccessory', () => {
    const elements = elementsOf(TabsLayout());
    const accessories = elements.filter((element) => element.type === NativeTabs.BottomAccessory);
    expect(accessories).toHaveLength(1);
    const inside = elementsOf(accessories[0] as NonNullable<(typeof accessories)[0]>);
    expect(inside.some((element) => element.type === DataVersionAccessory)).toBe(true);
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
    const tree = await renderPrimitive(<StationsView state={{ kind: 'ready', stations }} />);
    const rows = tree.root.findAll((node) => typeof node.type === 'string' && String(node.props.testID).startsWith('station-row-'));
    expect(rows).toHaveLength(stations.length);
    expect(rows.map((row) => row.props.testID)).toEqual(stations.map((station) => `station-row-${station.stationKey}`));
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual(
      stations.map((station) => `${station.name}, ${station.mode === 'rail' ? 'Metrorail' : 'Metromover'}`),
    );
  });

  it('the Stations route renders the screen that reads the schedule DB; until it opens, the list says so', async () => {
    expect(StationsRoute().type).toBe(StationsScreen);
    const opening = await renderPrimitive(<StationsView state={{ kind: 'opening' }} />);
    expect(opening.root.findByType(EmptyState).props.title).toBe('Opening the schedule');
    const failed = await renderPrimitive(<StationsView state={{ kind: 'failed', message: 'the schedule DB did not open: disk full' }} />);
    expect(failed.root.findByType(EmptyState).props.message).toBe('the schedule DB did not open: disk full');
    expect(failed.root.findAll((node) => String(node.props.testID).startsWith('station-row-'))).toHaveLength(0);
  });
});
