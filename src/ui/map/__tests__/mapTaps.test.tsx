import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { StationListing } from '@/data/schedule-queries';
import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';
import type { LatLon } from '@/lib/geo';

import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { mapEmphasis, NO_FOCUS } from '../emphasis';
import { DEFAULT_LAYERS } from '../layers';
import { layoutTracks, lineSegments } from '../lineLayout';
import { linesNear, tapToleranceM } from '../mapTaps';
import { TransitMap, type TransitMapProps } from '../TransitMap';
import { MARKER_ECHO_MS } from '../use-map-taps';
import { frame } from './map-fixtures';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: 'MapView', Polyline: 'Polyline', Marker: 'Marker' }));

/**
 * mfix3 §5, taps name things, on the map the Map tab mounts (TransitMap): a station or vehicle Marker's
 * onPress, and the MapView's onPress with a coordinate (Apple Maps reports a press on the map with its
 * coordinate; the lines are hit-tested against what lineSegments draws at the bucket). react-native-maps'
 * views are native, so they are mocked as host elements of their names and their props read back.
 * expo-location is jest-expo's automatic mock (its permission answer is undefined: no blue dot).
 */

const BUCKET = 2;
const LAID = layoutTracks(TEST_TRACKS);
const SEGMENTS = lineSegments(LAID, BUCKET);
const STATIONS: readonly StationListing[] = [
  { stationKey: 'rail:government-ctr', name: 'Government Center', mode: 'rail', coordinate: { latitude: 25.7743, longitude: -80.1955 } },
  { stationKey: 'rail:dadeland-south', name: 'Dadeland South', mode: 'rail', coordinate: { latitude: 25.6848, longitude: -80.3133 } },
];
const DESTINATIONS: ReadonlyMap<string, string> = new Map([
  ['T-G', 'rail:dadeland-south'],
  ['T-O', 'rail:dadeland-south'],
]);
const LIVE_G = frame({ key: 'live:g-41', source: 'live', lineId: 'GREEN', tripId: 'T-G', live: { provider: 'transitland', ageS: 40, feedAgeS: 30, lagS: 10 } });
const GHOST_O = frame({ key: '20260930:block-o', tripId: 'T-O' });

afterEach(async () => {
  await unmountAll();
});

/** TransitMap at the downtown bucket with mock handlers, and its MapView. */
async function rendered(): Promise<{ tree: ReactTestRenderer; map: ReactTestInstance; props: TransitMapProps }> {
  const props: TransitMapProps = {
    scheme: 'light',
    initialRegion: { latitude: 25.7743, longitude: -80.1937, latitudeDelta: 0.035, longitudeDelta: 0.035 },
    bucket: BUCKET,
    segments: SEGMENTS,
    stations: STATIONS,
    vehicles: [LIVE_G, GHOST_O],
    emphasis: mapEmphasis(DEFAULT_LAYERS, NO_FOCUS),
    selectedStationKey: null,
    onRegionChange: jest.fn(),
    onStationPress: jest.fn(),
    onVehiclePress: jest.fn(),
    onMapPress: jest.fn(),
    tripDestinations: DESTINATIONS,
  };
  const tree = await renderPrimitive(<TransitMap {...props} />);
  const map = tree.root.findByType('MapView' as never);
  expect(map.props.testID).toBe('transit-map');
  expect(captionOf(tree)).toBeNull();
  return { tree, map, props };
}

/** The caption's words, or null when none is up. */
function captionOf(tree: ReactTestRenderer): string | null {
  const texts = hostsByTestID(tree.root, 'map-caption-text');
  expect(texts.length).toBeLessThanOrEqual(1);
  const words = texts.length === 0 ? null : [texts[0]?.props.children].flat().join('');
  expect(words === null || words.length > 0).toBe(true);
  return words;
}

/** Fires the onPress of the Marker whose view carries `testID`. */
async function pressMarker(tree: ReactTestRenderer, testID: string): Promise<void> {
  const marker = tree.root.findAllByType('Marker' as never).find((node) => hostsByTestID(node, testID).length === 1);
  expect(marker).toBeDefined();
  await act(async () => {
    (marker as ReactTestInstance).props.onPress();
  });
  expect(marker?.props.coordinate).toBeDefined();
}

/** Fires the MapView's onPress at `coordinate`, as Apple Maps reports a press on the map. */
async function pressMap(map: ReactTestInstance, coordinate: LatLon): Promise<void> {
  expect(typeof map.props.onPress).toBe('function');
  await act(async () => {
    map.props.onPress({ nativeEvent: { coordinate, position: { x: 100, y: 200 } } });
  });
  expect(coordinate.latitude).not.toBeNaN();
}

/** The point `metres` east of a point on the map. */
function east(point: LatLon, metres: number): LatLon {
  const moved = { latitude: point.latitude, longitude: point.longitude + metres / (111_195 * Math.cos((point.latitude * Math.PI) / 180)) };
  expect(moved.latitude).toBe(point.latitude);
  expect(Number.isFinite(moved.longitude)).toBe(true);
  return moved;
}

/** Half-way along segment `s` of TEST_TRACKS[k] (the track, before any lane shift). */
function onTrack(k: number, s: number): LatLon {
  const points = (TEST_TRACKS[k] as (typeof TEST_TRACKS)[number]).points;
  const [a, b] = [points[s] as LatLon, points[s + 1] as LatLon];
  expect([a, b].every((p) => p !== undefined)).toBe(true);
  const middle = { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
  expect(Number.isFinite(middle.latitude) && Number.isFinite(middle.longitude)).toBe(true);
  return middle;
}

describe('station and vehicle taps (mfix3 §5)', () => {
  it('a station tap shows the station name', async () => {
    const { tree } = await rendered();
    await pressMarker(tree, 'station-marker-rail:government-ctr');
    expect(captionOf(tree)).toBe('Government Center, Metrorail');
  });

  it('a station tap still reports the station', async () => {
    const { tree, props } = await rendered();
    await pressMarker(tree, 'station-marker-rail:government-ctr');
    expect(props.onStationPress).toHaveBeenCalledTimes(1);
    expect(props.onStationPress).toHaveBeenCalledWith('rail:government-ctr');
  });

  it('a live vehicle tap shows line, destination and live age', async () => {
    const { tree } = await rendered();
    await pressMarker(tree, 'vehicle-marker-live:g-41');
    expect(captionOf(tree)).toBe('Green Line train to Dadeland South · live, 40 s ago');
  });

  it('a scheduled vehicle tap says timetable estimate', async () => {
    const { tree } = await rendered();
    await pressMarker(tree, 'vehicle-marker-20260930:block-o');
    expect(captionOf(tree)).toBe('Orange Line train to Dadeland South · timetable estimate');
  });

  it('a vehicle tap still reports the vehicle', async () => {
    const { tree, props } = await rendered();
    await pressMarker(tree, 'vehicle-marker-live:g-41');
    expect(props.onVehiclePress).toHaveBeenCalledTimes(1);
    expect(props.onVehiclePress).toHaveBeenCalledWith('live:g-41', 'GREEN');
  });
});

describe('line taps (mfix3 §5)', () => {
  it('a line tap shows the line name', async () => {
    const { tree, map } = await rendered();
    // 60 m off the Green Line toward Palmetto, where only Green is drawn (tolerance 22 pt ≈ 100 m here).
    await pressMap(map, east(onTrack(0, 1), 60));
    expect(captionOf(tree)).toBe('Green Line');
    // On the Omni loop's own stretch north of downtown.
    await pressMap(map, onTrack(2, 0));
    expect(captionOf(tree)).toBe('Metromover Omni');
  });

  it('a shared trunk tap shows both line names', async () => {
    const { tree, map } = await rendered();
    // The trunk's own track, half-way between the Green and Orange lanes drawn either side of it.
    expect(linesNear(SEGMENTS, onTrack(0, 15), BUCKET)).toEqual(['GREEN', 'ORANGE']);
    await pressMap(map, onTrack(0, 15));
    expect(captionOf(tree)).toBe('Green Line · Orange Line');
  });

  it('a map press away from every line names no line', async () => {
    const { tree, map, props } = await rendered();
    await pressMap(map, east(onTrack(0, 1), 60));
    expect(captionOf(tree)).toBe('Green Line');
    // Key Biscayne: kilometres from every line. The caption goes, the press is still reported, nothing throws.
    const far = { latitude: 25.693, longitude: -80.162 };
    expect(linesNear(SEGMENTS, far, BUCKET)).toEqual([]);
    await pressMap(map, far);
    expect(captionOf(tree)).toBeNull();
    expect(props.onMapPress).toHaveBeenCalledTimes(2);
  });
});

describe('map presses and marker taps together (mfix3 §5)', () => {
  it('apple maps reporting a marker tap to the map as well keeps the marker caption', async () => {
    const { tree, map, props } = await rendered();
    await pressMarker(tree, 'station-marker-rail:government-ctr');
    // The same tap, seen by the map's own tap recognizer a moment later.
    await pressMap(map, STATIONS[0]?.coordinate as LatLon);
    expect(captionOf(tree)).toBe('Government Center, Metrorail');
    expect(props.onMapPress).not.toHaveBeenCalled();
    expect(MARKER_ECHO_MS).toBeLessThanOrEqual(500);
  });

  it('the tap tolerance is 22 pt at the bucket scale', () => {
    expect(tapToleranceM(BUCKET)).toBeCloseTo(22 * ((0.035 * 111_195.08) / 852), 1);
    expect(tapToleranceM(3)).toBeLessThan(tapToleranceM(0));
  });
});
