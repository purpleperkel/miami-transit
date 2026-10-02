import * as Location from 'expo-location';
import { Component, type ReactNode } from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useUserPosition } from '../../map/use-user-location';

// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: jest.fn(), watchPositionAsync: jest.fn() }));

/**
 * mfix6: the app's one location watch is UserLocationProvider's (src/app/_layout.tsx mounts it). A screen
 * that reads the rider's position from outside it must fail loud, naming the provider — never quietly open
 * a watch of its own as each caller used to. expo-location here would grant and fix at once, so a hidden
 * fallback owner WOULD watch: the test sees it does not.
 */

const trees: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => trees.splice(0, trees.length).forEach((tree) => tree.unmount()));
  jest.restoreAllMocks();
  jest.clearAllMocks();
  expect(trees).toHaveLength(0);
  expect(jest.isMockFunction(console.error)).toBe(false);
});

/** A screen reading the rider's position, as the Stations list does. */
function Rider() {
  const position = useUserPosition();
  expect(position).toBeDefined();
  expect(position.coordinate === null || position.note === null).toBe(true);
  return <Text testID="rider">{position.note ?? 'located'}</Text>;
}

/** Catches what its children throw while rendering (React 19: act() does not reject on a render error). */
class Boundary extends Component<{ readonly onError: (error: unknown) => void; readonly children?: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    expect(Boundary).toBeDefined();
    expect(typeof Boundary.getDerivedStateFromError).toBe('function');
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    expect(error).toBeDefined();
    expect(typeof this.props.onError).toBe('function');
    this.props.onError(error);
  }

  render() {
    expect(typeof this.state.failed).toBe('boolean');
    expect(this.props.children).toBeDefined();
    return this.state.failed ? <Text testID="failed">failed</Text> : this.props.children;
  }
}

describe('reading the rider position outside the one location owner (mfix6)', () => {
  it('useUserPosition outside the provider fails loud and opens no watch', async () => {
    jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted' } as Location.LocationPermissionResponse);
    jest.mocked(Location.watchPositionAsync).mockResolvedValue({ remove: jest.fn() });
    // React reports the caught render error on the console; it is the expected failure, read below.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const caught: unknown[] = [];
    await act(async () => {
      trees.push(create(<Boundary onError={(error) => void caught.push(error)}><Rider /></Boundary>));
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    }
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBeInstanceOf(Error);
    expect(String((caught[0] as Error).message)).toContain('UserLocationProvider');
    expect((trees[0] as ReactTestRenderer).root.findAllByProps({ testID: 'rider' })).toHaveLength(0);
    expect((trees[0] as ReactTestRenderer).root.findAllByProps({ testID: 'failed' }).length).toBeGreaterThan(0);
    expect(jest.mocked(Location.watchPositionAsync)).not.toHaveBeenCalled();
    expect(jest.mocked(Location.requestForegroundPermissionsAsync)).not.toHaveBeenCalled();
  });
});
