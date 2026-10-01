import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import type { StationListing } from '@/data/schedule-queries';

import { COLOR_SCHEMES } from '../../colors';
import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { ZOOM_BUCKETS } from '../mapGeometry';
import { StationMarker } from '../StationMarker';
import { MIN_HIT_AREA_PT } from '../vehicleVisual';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, Marker: 'Marker' }));

/**
 * M5.8 StationMarker: react-native-maps' Marker is a native MapKit annotation, so it is mocked as a
 * host element of that name; the marker's own view (its hit area and dot) renders inside it.
 */

const GOVERNMENT_CENTER: StationListing = {
  stationKey: 'rail:government-ctr',
  name: 'Government Center',
  mode: 'rail',
  coordinate: { latitude: 25.7743, longitude: -80.1955 },
};
const MOVER_STOP: StationListing = { ...GOVERNMENT_CENTER, stationKey: 'mover:government-center', mode: 'mover' };

afterEach(async () => {
  await unmountAll();
});

/** One marker rendered: its hit-area view (flattened style and props), the dot inside it, and its press handler. */
async function markerViews(station: StationListing, selected: boolean, bucket: (typeof ZOOM_BUCKETS)[number], scheme: 'light' | 'dark') {
  const onPress = jest.fn();
  const tree = await renderPrimitive(<StationMarker station={station} selected={selected} bucket={bucket} scheme={scheme} onPress={onPress} />);
  const hit = tree.root.find((node) => typeof node.type === 'string' && node.props.testID === `station-marker-${station.stationKey}`);
  const dot = hit.findAll((node) => typeof node.type === 'string' && node !== hit)[0];
  expect(dot).toBeDefined();
  expect(tree.root.findAllByType('Marker' as never)).toHaveLength(1);
  return { tree, onPress, hit: StyleSheet.flatten(hit.props.style), dot: StyleSheet.flatten(dot?.props.style), hitProps: hit.props };
}

describe('StationMarker (M5.8)', () => {
  it('hit area >= 44 pt at every zoom bucket, selected or not, and the dot sits inside it', async () => {
    expect(MIN_HIT_AREA_PT).toBe(44);
    for (const station of [GOVERNMENT_CENTER, MOVER_STOP]) {
      for (const bucket of ZOOM_BUCKETS) {
        for (const selected of [false, true]) {
          const { hit, dot } = await markerViews(station, selected, bucket, COLOR_SCHEMES[0]);
          expect([hit.width >= 44, hit.height >= 44, dot.width <= hit.width, dot.height <= hit.height]).toEqual([true, true, true, true]);
        }
      }
    }
  });

  it('sits on its station and a tap opens that station', async () => {
    const { tree, onPress } = await markerViews(GOVERNMENT_CENTER, false, 2, 'dark');
    const marker = tree.root.findByType('Marker' as never);
    expect(marker.props.coordinate).toBe(GOVERNMENT_CENTER.coordinate);
    expect(marker.props.anchor).toEqual({ x: 0.5, y: 0.5 });
    await act(async () => {
      marker.props.onPress();
    });
    expect(onPress).toHaveBeenCalledWith('rail:government-ctr');
  });

  it('VoiceOver reads the station and its system, and whether it is selected', async () => {
    const { hitProps } = await markerViews(MOVER_STOP, true, 3, 'light');
    expect(hitProps.accessibilityLabel).toBe('Government Center, Metromover');
    expect([hitProps.accessible, hitProps.accessibilityRole, hitProps.accessibilityState]).toEqual([true, 'button', { selected: true }]);
  });
});
