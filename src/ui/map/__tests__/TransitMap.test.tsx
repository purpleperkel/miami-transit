import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { StationListing } from '@/data/schedule-queries';
import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';

import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { mapEmphasis, NO_FOCUS } from '../emphasis';
import { DEFAULT_LAYERS, type LayersState } from '../layers';
import { layoutTracks, lineSegments } from '../lineLayout';
import { MAP_RENDER_PROPS, TransitMap, type TransitMapProps } from '../TransitMap';
import { frame, liveFrame } from './map-fixtures';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: 'MapView', Polyline: 'Polyline', Marker: 'Marker' }));

/**
 * M5.12 TransitMap: react-native-maps' MapView, Polyline and Marker are native MapKit views, so they
 * are mocked as host elements of those names and the props TransitMap gives them are read back. The
 * lines are the network's real tracks at station resolution; stations and vehicles are synthetic.
 */

const SEGMENTS = lineSegments(layoutTracks(TEST_TRACKS), 2);
const STATIONS: readonly StationListing[] = [
  { stationKey: 'rail:government-ctr', name: 'Government Center', mode: 'rail', coordinate: { latitude: 25.7743, longitude: -80.1955 } },
  { stationKey: 'mover:government-center', name: 'Government Center', mode: 'mover', coordinate: { latitude: 25.7747, longitude: -80.1946 } },
];
const VEHICLES = [frame(), { ...liveFrame('transitland', 20), key: 'live:syn-mover', mode: 'mover' as const, lineId: 'MM_INNER' as const }];

afterEach(async () => {
  await unmountAll();
});

/** TransitMap rendered with the given layers (all on by default), and its handlers. */
async function rendered(layers: LayersState = DEFAULT_LAYERS): Promise<{ tree: ReactTestRenderer; map: ReactTestInstance; props: TransitMapProps }> {
  const props: TransitMapProps = {
    scheme: 'light',
    initialRegion: { latitude: 25.7743, longitude: -80.1937, latitudeDelta: 0.08, longitudeDelta: 0.08 },
    bucket: 2,
    segments: SEGMENTS,
    stations: STATIONS,
    vehicles: VEHICLES,
    emphasis: mapEmphasis(layers, NO_FOCUS),
    selectedStationKey: null,
    onRegionChange: jest.fn(),
    onStationPress: jest.fn(),
    onVehiclePress: jest.fn(),
    onMapPress: jest.fn(),
  };
  const tree = await renderPrimitive(<TransitMap {...props} />);
  const map = tree.root.findByType('MapView' as never);
  expect(map.props.testID).toBe('transit-map');
  expect(tree.root.findAllByType('MapView' as never)).toHaveLength(1);
  return { tree, map, props };
}

/** The testIDs of the host views under `node`, in document order. */
function hostTestIds(node: ReactTestInstance): string[] {
  const ids = node.findAll((child) => typeof child.type === 'string' && typeof child.props.testID === 'string').map((child) => String(child.props.testID));
  expect(Array.isArray(ids)).toBe(true);
  expect(ids.every((id) => id.length > 0)).toBe(true);
  return ids;
}

describe('TransitMap render props (M5.12)', () => {
  it('mapType is mutedStandard', async () => {
    const { map } = await rendered();
    expect(map.props.mapType).toBe('mutedStandard');
    expect(MAP_RENDER_PROPS.mapType).toBe('mutedStandard');
  });

  it('points of interest off', async () => {
    const { map } = await rendered();
    expect(map.props.showsPointsOfInterests).toBe(false);
    // pointsOfInterestFilter would override showsPointsOfInterests, so it is never set.
    expect('pointsOfInterestFilter' in map.props).toBe(false);
  });

  it('pitch off', async () => {
    const { map } = await rendered();
    expect(map.props.pitchEnabled).toBe(false);
    expect(map.props.initialRegion.latitudeDelta).toBeGreaterThan(0);
  });

  it('buildings off', async () => {
    const { map } = await rendered();
    expect(map.props.showsBuildings).toBe(false);
    expect(map.props.style).toBeDefined();
  });
});

describe('TransitMap layers (M5.12)', () => {
  it('draws the lines, the stations and the vehicles', async () => {
    const { tree } = await rendered();
    expect(tree.root.findAllByType('Polyline' as never)).toHaveLength(2 * SEGMENTS.length);
    const markers = tree.root.findAllByType('Marker' as never).map((marker) => hostTestIds(marker)[0]);
    expect(markers).toEqual(['station-marker-rail:government-ctr', 'station-marker-mover:government-center', 'vehicle-marker-20260930:block-1', 'vehicle-marker-live:syn-mover']);
  });

  it('a layer switched off is not drawn', async () => {
    const noMover = await rendered({ ...DEFAULT_LAYERS, mover: false });
    const polylines = noMover.tree.root.findAllByType('Polyline' as never);
    expect(polylines.length).toBe(2 * SEGMENTS.filter((segment) => segment.lineId === 'GREEN' || segment.lineId === 'ORANGE').length);
    expect(hostTestIds(noMover.tree.root).filter((id) => id.includes('mover'))).toEqual([]);
    const noScheduled = await rendered({ ...DEFAULT_LAYERS, scheduled: false });
    expect(hostTestIds(noScheduled.tree.root).filter((id) => id.startsWith('vehicle-marker-'))).toEqual(['vehicle-marker-live:syn-mover']);
  });

  it('a tap on the map itself clears; a tap that landed on a marker does not', async () => {
    const { map, props } = await rendered();
    await act(async () => {
      map.props.onPress({ nativeEvent: { action: 'marker-press' } });
      map.props.onPress({ nativeEvent: { action: 'press' } });
    });
    expect(props.onMapPress).toHaveBeenCalledTimes(1);
    map.props.onRegionChangeComplete({ latitude: 25.77, longitude: -80.19, latitudeDelta: 0.3, longitudeDelta: 0.3 });
    expect(props.onRegionChange).toHaveBeenCalledWith(expect.objectContaining({ latitudeDelta: 0.3 }));
  });

  it('a frame tick moves the vehicles without sending the lines again', async () => {
    const { tree, props } = await rendered();
    const before = tree.root.findAllByType('Polyline' as never).map((polyline) => polyline.props.coordinates);
    const moved = VEHICLES.map((vehicle) => ({ ...vehicle, coordinate: { latitude: vehicle.coordinate.latitude, longitude: vehicle.coordinate.longitude + 0.0001 } }));
    await act(async () => {
      tree.update(<TransitMap {...props} vehicles={moved} />);
    });
    const after = tree.root.findAllByType('Polyline' as never).map((polyline) => polyline.props.coordinates);
    expect(after).toHaveLength(before.length);
    expect(after.every((coordinates, i) => coordinates === before[i])).toBe(true);
    const marker = tree.root.findAllByType('Marker' as never).find((node) => hostTestIds(node)[0] === 'vehicle-marker-20260930:block-1');
    expect(marker?.props.coordinate.longitude).toBeCloseTo(-80.1955 + 0.0001, 9);
  });
});
