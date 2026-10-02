import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { mapEmphasis, NO_FOCUS } from '../emphasis';
import { DEFAULT_LAYERS } from '../layers';
import { TransitMap, type TransitMapProps } from '../TransitMap';
import { LOCATE_DELTA } from '../use-map-taps';

import { animateToRegionCalls } from './map-view-mock';

const mockAskPermission = jest.fn<Promise<unknown>, []>();
const mockCurrentPosition = jest.fn<Promise<unknown>, [unknown]>();

// test-time mock of native module
jest.mock('react-native-maps', () => ({ __esModule: true, default: jest.requireActual<typeof import('./map-view-mock')>('./map-view-mock').MapViewMock, Polyline: 'Polyline', Marker: 'Marker' }));
// test-time mock of native module
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => mockAskPermission(),
  getCurrentPositionAsync: (options: unknown) => mockCurrentPosition(options),
  Accuracy: { Balanced: 3 },
}));

/**
 * mfix3 §5, the legend and you-are-here, on the map the Map tab mounts (TransitMap): the control stack's
 * ⓘ opens the map legend; once expo-location grants foreground permission the MapView shows the user's
 * dot, and locate-me moves the MapView's camera to the user's position. Anything but a grant — a refusal,
 * an empty answer, a failed request — is denied: no dot, one line saying why, nothing thrown.
 */

afterEach(async () => {
  await unmountAll();
  jest.clearAllMocks();
});

/** TransitMap with no lines or vehicles (the chrome is what is under test), its MapView, and its handlers. */
async function rendered(): Promise<{ tree: ReactTestRenderer; map: ReactTestInstance }> {
  const props: TransitMapProps = {
    scheme: 'light',
    initialRegion: { latitude: 25.7743, longitude: -80.1937, latitudeDelta: 0.08, longitudeDelta: 0.08 },
    bucket: 1,
    segments: null,
    stations: [],
    vehicles: [],
    emphasis: mapEmphasis(DEFAULT_LAYERS, NO_FOCUS),
    selectedStationKey: null,
    onRegionChange: jest.fn(),
    onStationPress: jest.fn(),
    onVehiclePress: jest.fn(),
    onMapPress: jest.fn(),
    controlsTopPt: 59,
  };
  const asksBefore = mockAskPermission.mock.calls.length;
  const tree = await renderPrimitive(<TransitMap {...props} />);
  const map = tree.root.findByType('MapView' as never);
  expect(map.props.testID).toBe('transit-map');
  // The map asks for location once, when it mounts.
  expect(mockAskPermission.mock.calls.length).toBe(asksBefore + 1);
  return { tree, map };
}

/** Presses the control stack's button `id` (the Pressable carrying testID map-control-<id>). */
async function pressControl(tree: ReactTestRenderer, id: string): Promise<void> {
  const button = tree.root.findByProps({ testID: `map-control-${id}` });
  expect(typeof button.props.onPress).toBe('function');
  await act(async () => {
    button.props.onPress();
  });
  expect(hostsByTestID(tree.root, `map-control-${id}`)).toHaveLength(1);
}

/** The words of every host Text under the node carrying `testID`. */
function textsIn(tree: ReactTestRenderer, testID: string): string[] {
  const [node] = hostsByTestID(tree.root, testID);
  expect(node).toBeDefined();
  const texts = (node as ReactTestInstance).findAll((child) => typeof child.type === 'string' && String(child.type) === 'Text').map((text) => [text.props.children].flat().join(''));
  expect(texts.length).toBeGreaterThan(0);
  return texts;
}

/** The legend's location line (opening the legend first): exactly one row of it. */
async function locationLineShown(tree: ReactTestRenderer): Promise<string[]> {
  await pressControl(tree, 'legend');
  expect(hostsByTestID(tree.root, 'map-legend')).toHaveLength(1);
  const rows = hostsByTestID(tree.root, 'map-legend-location');
  expect(rows).toHaveLength(1);
  return textsIn(tree, 'map-legend-location');
}

describe('the map legend (mfix3 §5)', () => {
  it('the legend button opens the map legend', async () => {
    mockAskPermission.mockResolvedValue({ granted: true, status: 'granted' });
    const { tree } = await rendered();
    expect(hostsByTestID(tree.root, 'map-legend')).toHaveLength(0);
    await pressControl(tree, 'legend');
    expect(hostsByTestID(tree.root, 'map-legend')).toHaveLength(1);
    expect(textsIn(tree, 'map-legend')).toContain('Map legend');
  });

  it('the legend explains every marker kind', async () => {
    mockAskPermission.mockResolvedValue({ granted: true, status: 'granted' });
    const { tree } = await rendered();
    await pressControl(tree, 'legend');
    // Lettered squares are Metrorail trains (G Green, O Orange); dots are Metromover cars by loop colour.
    expect(textsIn(tree, 'map-legend-row-green')).toEqual(['G', 'G — Green Line train (Metrorail)']);
    expect(textsIn(tree, 'map-legend-row-orange')).toEqual(['O', 'O — Orange Line train (Metrorail)']);
    expect(textsIn(tree, 'map-legend-row-mover')).toEqual(['Dots — Metromover cars, coloured by loop: Inner Loop, Omni, Brickell']);
    // Solid is live, hollow is a timetable estimate, faded with a clock was last seen a while ago.
    expect(textsIn(tree, 'map-legend-row-live').at(-1)).toBe('Solid — a live position');
    expect(textsIn(tree, 'map-legend-row-scheduled').at(-1)).toBe('Hollow — a timetable estimate');
    expect(textsIn(tree, 'map-legend-row-stale')).toEqual(['O', 'Last seen a while ago']);
    expect(hostsByTestID(tree.root, /^map-legend-clock-/)).toHaveLength(1);
  });
});

describe('you are here (mfix3 §5)', () => {
  it('the map shows the user location once permission is granted', async () => {
    mockAskPermission.mockResolvedValue({ granted: true, status: 'granted' });
    const { map } = await rendered();
    expect(map.props.showsUserLocation).toBe(true);
    expect(map.props.showsMyLocationButton).toBeUndefined();
  });

  it('locate me centres the map on the user', async () => {
    mockAskPermission.mockResolvedValue({ granted: true, status: 'granted' });
    mockCurrentPosition.mockResolvedValue({ coords: { latitude: 25.7617, longitude: -80.1918 }, timestamp: 0 });
    const { tree } = await rendered();
    await pressControl(tree, 'locate');
    expect(mockCurrentPosition).toHaveBeenCalledWith({ accuracy: 3 });
    expect(animateToRegionCalls).toHaveBeenCalledTimes(1);
    expect(animateToRegionCalls.mock.calls[0]?.[0]).toEqual({ latitude: 25.7617, longitude: -80.1918, latitudeDelta: LOCATE_DELTA, longitudeDelta: LOCATE_DELTA });
  });

  it('location denied shows no dot and one line of explanation', async () => {
    mockAskPermission.mockResolvedValue({ granted: false, status: 'denied', canAskAgain: false });
    const { tree, map } = await rendered();
    expect(map.props.showsUserLocation).toBe(false);
    expect(await locationLineShown(tree)).toEqual(['Location is off — allow it in Settings to see where you are']);
    // Locate-me says the same instead of moving the camera.
    await pressControl(tree, 'locate');
    expect(animateToRegionCalls).not.toHaveBeenCalled();
  });
});

describe('a permission answer that is not a grant (mfix3 §5)', () => {
  it('a missing or failed location permission answer counts as denied', async () => {
    // jest-expo's automatic expo-location mock resolves with nothing at all.
    mockAskPermission.mockResolvedValue(undefined);
    const empty = await rendered();
    expect(empty.map.props.showsUserLocation).toBe(false);
    expect(await locationLineShown(empty.tree)).toEqual(['Location is off — allow it in Settings to see where you are']);
    // A request that fails is denied too — its reason shown, not swallowed, and nothing thrown.
    mockAskPermission.mockRejectedValue(new Error('Location services are disabled'));
    const failed = await rendered();
    expect(failed.map.props.showsUserLocation).toBe(false);
    expect(await locationLineShown(failed.tree)).toEqual(['Location is unavailable — Error: Location services are disabled']);
  });
});
