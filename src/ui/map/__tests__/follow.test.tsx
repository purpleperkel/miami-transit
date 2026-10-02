import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TEST_TRACKS } from '@/domain/live/__tests__/test-network';

import { mapEmphasis, NO_FOCUS } from '../emphasis';
import { FOLLOW_GLIDE_MS, FOLLOW_STORE, FollowStore } from '../follow';
import { DEFAULT_LAYERS } from '../layers';
import { layoutTracks, lineSegments } from '../lineLayout';
import { TransitMap, type TransitMapProps } from '../TransitMap';
import type { VehicleFrame } from '../vehicleFrames';
import { frame } from './map-fixtures';

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: 'MapView', Polyline: 'Polyline', Marker: 'Marker' }));

/**
 * M6.6 follow mode, through the REAL TransitMap: react-native-maps' MapView is a native MapKit view,
 * mocked as a host element whose ref is a camera recording animateCamera (react-test-renderer's
 * createNodeMock). The vehicle sheet follows a vehicle through the shared FOLLOW_STORE; each frame
 * that moves it must re-centre the camera on it, and the rider's own gesture must end follow mode.
 */

const SEGMENTS = lineSegments(layoutTracks(TEST_TRACKS), 2);
const FOLLOWED = '20260930:block-1';
const camera = { animateCamera: jest.fn() };
const trees: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  FOLLOW_STORE.stop();
  camera.animateCamera.mockClear();
  expect(FOLLOW_STORE.read()).toBeNull();
  expect(trees).toHaveLength(0);
});

/** The map's props with these vehicles drawn. */
function mapProps(vehicles: readonly VehicleFrame[]): TransitMapProps {
  const props: TransitMapProps = {
    scheme: 'light',
    initialRegion: { latitude: 25.7743, longitude: -80.1937, latitudeDelta: 0.08, longitudeDelta: 0.08 },
    bucket: 2,
    segments: SEGMENTS,
    stations: [],
    vehicles,
    emphasis: mapEmphasis(DEFAULT_LAYERS, NO_FOCUS),
    selectedStationKey: null,
    onRegionChange: jest.fn(),
    onStationPress: jest.fn(),
    onVehiclePress: jest.fn(),
    onMapPress: jest.fn(),
  };
  expect(props.vehicles).toBe(vehicles);
  expect(props.initialRegion.latitudeDelta).toBeGreaterThan(0);
  return props;
}

/** The followed vehicle and another one, at `step` along the track (one frame each). */
function vehiclesAt(step: number): readonly VehicleFrame[] {
  const followed = frame({ key: FOLLOWED, coordinate: { latitude: 25.77, longitude: -80.21 + step * 0.001 } });
  const other = frame({ key: '20260930:block-2', lineId: 'GREEN', coordinate: { latitude: 25.78, longitude: -80.2 - step * 0.001 } });
  expect(followed.coordinate).not.toEqual(other.coordinate);
  expect(followed.key).toBe(FOLLOWED);
  return [followed, other];
}

/** Draws (or redraws) the map with the vehicles at `step`, the MapView's ref being the recording camera. */
async function draw(step: number): Promise<ReactTestRenderer> {
  const element = <TransitMap {...mapProps(vehiclesAt(step))} />;
  const existing = trees[0];
  expect(trees.length).toBeLessThanOrEqual(1);
  await act(async () => void (existing === undefined ? trees.push(create(element, { createNodeMock: cameraFor })) : existing.update(element)));
  expect(trees).toHaveLength(1);
  return trees[0] as ReactTestRenderer;
}

/** createNodeMock: the MapView's ref is the recording camera; no other host needs a ref. */
function cameraFor(node: { readonly type: unknown }): typeof camera | null {
  expect(node).toBeDefined();
  expect(camera.animateCamera).toBeDefined();
  return node.type === 'MapView' ? camera : null;
}

/** The centre of every camera move so far. */
function centres(): unknown[] {
  const moves = camera.animateCamera.mock.calls.map(([target, options]) => ({ target, options }));
  expect(moves.every(({ options }) => (options as { duration: number }).duration === FOLLOW_GLIDE_MS)).toBe(true);
  expect(Array.isArray(moves)).toBe(true);
  return moves.map(({ target }) => (target as { center: unknown }).center);
}

describe('follow mode on the map (M6.6)', () => {
  it('follow mode keeps the camera centered on the followed vehicle', async () => {
    await draw(0);
    expect(centres()).toEqual([]);
    await act(async () => FOLLOW_STORE.follow(FOLLOWED));
    await draw(1);
    await draw(2);
    expect(centres()).toEqual([vehiclesAt(0)[0]?.coordinate, vehiclesAt(1)[0]?.coordinate, vehiclesAt(2)[0]?.coordinate]);
    // Never the other vehicle's place.
    expect(centres()).not.toContainEqual(vehiclesAt(1)[1]?.coordinate);
  });

  it('follow mode ends on a user map gesture', async () => {
    const tree = await draw(0);
    await act(async () => FOLLOW_STORE.follow(FOLLOWED));
    expect(centres()).toHaveLength(1);
    const map = tree.root.findByType('MapView' as never);
    await act(async () => map.props.onPanDrag({ nativeEvent: { coordinate: { latitude: 25.771, longitude: -80.2 } } }));
    expect(FOLLOW_STORE.read()).toBeNull();
    await draw(1);
    await draw(2);
    expect(centres()).toHaveLength(1);
    // A double-tap zoom is a gesture too.
    await act(async () => FOLLOW_STORE.follow(FOLLOWED));
    await act(async () => map.props.onDoublePress({ nativeEvent: {} }));
    expect(FOLLOW_STORE.read()).toBeNull();
  });

  it('locate me ends follow mode, so the camera is not pulled back to the vehicle', async () => {
    const tree = await draw(0);
    await act(async () => FOLLOW_STORE.follow(FOLLOWED));
    expect(centres()).toHaveLength(1);
    const locate = tree.root.findByProps({ testID: 'map-control-locate' });
    await act(async () => locate.props.onPress());
    expect(FOLLOW_STORE.read()).toBeNull();
    await draw(1);
    expect(centres()).toHaveLength(1);
  });
});

describe('the follow store (M6.6)', () => {
  it('follows one vehicle at a time and tells its listeners only of changes', () => {
    const store = new FollowStore();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    store.follow('a:1');
    store.follow('a:1');
    store.follow('b:2');
    store.stop();
    store.stop();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.follow('c:3');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.read()).toBe('c:3');
  });
});
