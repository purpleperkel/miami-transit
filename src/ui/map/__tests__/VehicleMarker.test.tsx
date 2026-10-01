import { StyleSheet } from 'react-native';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { PROVIDER_CONFIG } from '@/domain/live/constants';

import { SCHEDULED_POSITION } from '../../a11y';
import { lineColors, MAP_LAND } from '../../colors';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import type { VehicleFrame } from '../vehicleFrames';
import { VehicleMarker } from '../VehicleMarker';
import { bearingOctant, MIN_HIT_AREA_PT, RAIL_VEHICLE_PT, STALE_OPACITY } from '../vehicleVisual';
import { frame, liveFrame } from './map-fixtures';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, Marker: 'Marker' }));

/**
 * M5.9 VehicleMarker: react-native-maps' Marker is a native MapKit annotation, so it is mocked as a
 * host element of that name; the marker's own views (hit area, body, nose, stale badge) render inside
 * it and are read back. Staleness thresholds are the providers' own fresh values (m4a constants.ts).
 */

afterEach(async () => {
  await unmountAll();
});

type Drawn = { tree: ReactTestRenderer; hit: ReactTestInstance; body: Record<string, unknown>; fill: Record<string, unknown>; badge: boolean; onPress: jest.Mock };

/** One marker rendered: its hit-area view, the flattened style of its body group and of its filled body, whether it has a stale badge. */
async function drawn(vehicle: VehicleFrame, scheme: 'light' | 'dark' = 'light'): Promise<Drawn> {
  const onPress = jest.fn();
  const tree = await renderPrimitive(<VehicleMarker vehicle={vehicle} scheme={scheme} onPress={onPress} />);
  const [hit] = hostsWithTestId(tree, `vehicle-marker-${vehicle.key}`);
  const [group] = hostsWithTestId(tree, `vehicle-body-${vehicle.key}`);
  expect([hit, group].every((node) => node !== undefined)).toBe(true);
  const fill = (group as ReactTestInstance).findAll((node) => typeof node.type === 'string' && StyleSheet.flatten(node.props.style)?.backgroundColor !== undefined);
  expect(fill.length).toBeGreaterThan(0);
  return {
    tree,
    hit: hit as ReactTestInstance,
    body: StyleSheet.flatten((group as ReactTestInstance).props.style),
    fill: StyleSheet.flatten(fill[0]?.props.style),
    badge: hostsWithTestId(tree, `vehicle-stale-badge-${vehicle.key}`).length === 1,
    onPress,
  };
}

/** The host views carrying `testID` (at most one). */
function hostsWithTestId(tree: ReactTestRenderer, testID: string): ReactTestInstance[] {
  const hosts = tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
  expect(testID.length).toBeGreaterThan(0);
  expect(hosts.length).toBeLessThanOrEqual(1);
  return hosts;
}

/** Asserts the marker is drawn fresh (opacity 1, no clock badge) or stale (half opacity, clock badge). */
async function expectStale(vehicle: VehicleFrame, stale: boolean): Promise<void> {
  const { body, badge } = await drawn(vehicle);
  expect(body.opacity).toBe(stale ? STALE_OPACITY : 1);
  expect(badge).toBe(stale);
}

describe('VehicleMarker heading (M5.9)', () => {
  it('bearingOctant(359) is 0', () => {
    expect(bearingOctant(359)).toBe(0);
    expect(Math.floor(359 / 45)).toBe(7); // what flooring would have said
    expect([0, 22, 23, 45, 90, 180, 270, 337, 338, 360, -1, 719].map(bearingOctant)).toEqual([0, 0, 1, 1, 2, 4, 6, 7, 0, 0, 0, 0]);
  });

  it('the nose turns to the octant and a vehicle without a bearing has none', async () => {
    const { tree } = await drawn(frame({ bearing: 92 }));
    const turned = tree.root.findAll((node) => typeof node.type === 'string' && JSON.stringify(StyleSheet.flatten(node.props.style)?.transform ?? []).includes('90deg'));
    expect(turned).toHaveLength(1);
    const { tree: bare } = await drawn(frame({ key: 'no-heading', bearing: null }));
    expect(bare.root.findAll((node) => typeof node.type === 'string' && StyleSheet.flatten(node.props.style)?.transform !== undefined)).toHaveLength(0);
  });
});

describe('VehicleMarker (M5.9)', () => {
  it('live is solid', async () => {
    const colors = lineColors('ORANGE', 'light');
    const { fill, body, badge } = await drawn(liveFrame('transitland', 10));
    expect([fill.backgroundColor, fill.borderColor, fill.width]).toEqual([colors.stroke, colors.casing, RAIL_VEHICLE_PT]);
    expect([body.opacity, badge]).toEqual([1, false]);
  });

  it('scheduled is hollow', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const colors = lineColors('ORANGE', scheme);
      const { fill } = await drawn(frame(), scheme);
      expect(fill.backgroundColor).toBe(MAP_LAND[scheme]);
      expect(fill.borderColor).toBe(scheme === 'light' ? colors.casing : colors.stroke);
      expect(fill.backgroundColor).not.toBe(colors.stroke);
    }
  });

  it('scheduled a11y label contains Scheduled position', async () => {
    const { hit } = await drawn(frame());
    expect(hit.props.accessibilityLabel).toContain(SCHEDULED_POSITION);
    expect(hit.props.accessibilityLabel).toBe('Orange Line train, Scheduled position, heading south');
    const { hit: live } = await drawn(liveFrame('swiftly', 5));
    expect(live.props.accessibilityLabel).not.toContain(SCHEDULED_POSITION);
  });

  it('a tap reports the vehicle and its line, inside a 44 pt hit area', async () => {
    const { tree, hit, onPress } = await drawn(frame());
    expect(StyleSheet.flatten(hit.props.style)).toMatchObject({ width: MIN_HIT_AREA_PT, height: MIN_HIT_AREA_PT });
    await act(async () => {
      tree.root.findByType('Marker' as never).props.onPress();
    });
    expect(onPress).toHaveBeenCalledWith('20260930:block-1', 'ORANGE');
  });
});

describe('VehicleMarker staleness (M5.9; §3 fresh thresholds)', () => {
  it('swiftly at 75 s is not stale', async () => {
    expect(PROVIDER_CONFIG.swiftly.freshS).toBe(75);
    await expectStale(liveFrame('swiftly', PROVIDER_CONFIG.swiftly.freshS), false);
  });

  it('swiftly stale above 75 s', async () => {
    expect(PROVIDER_CONFIG.swiftly.freshS).toBe(75);
    await expectStale(liveFrame('swiftly', PROVIDER_CONFIG.swiftly.freshS + 1), true);
  });

  it('transitland at 120 s is not stale', async () => {
    expect(PROVIDER_CONFIG.transitland.freshS).toBeGreaterThan(120);
    await expectStale(liveFrame('transitland', 120), false);
  });

  it('transitland at 150 s is not stale', async () => {
    expect(PROVIDER_CONFIG.transitland.freshS).toBe(150);
    await expectStale(liveFrame('transitland', PROVIDER_CONFIG.transitland.freshS), false);
  });

  it('transitland stale above 150 s', async () => {
    expect(PROVIDER_CONFIG.transitland.freshS).toBe(150);
    await expectStale(liveFrame('transitland', PROVIDER_CONFIG.transitland.freshS + 1), true);
  });

  it('a stale vehicle says how old it is', async () => {
    const { hit } = await drawn(liveFrame('swiftly', 130));
    expect(hit.props.accessibilityLabel).toBe('Orange Line train, live position, 2 min old, heading south');
    expect(hit.props.accessibilityLabel).not.toContain(SCHEDULED_POSITION);
  });
});
