import { AppState } from 'react-native';

import type { LatLon } from '../../../lib/geo';

/**
 * Test-time stand-in for the NATIVE expo-location module, which the walk tests reach through the app's ONE
 * UserLocationProvider: it grants foreground location, runs the one watch (reporting the current fix at once), and
 * lets a test move the rider. Each test file mocks 'expo-location' (labelled as a test-time mock of a native module)
 * with the one-line factory `() => jest.requireActual('./walk-location').locationModule()`, and reads it back with
 * jest.requireMock('expo-location') (walk-rig.tsx's location() does).
 */

/** One fix as expo-location reports it. */
type Fix = { readonly coords: LatLon; readonly timestamp: number };

/** expo-location as the walk tests drive it: the calls the location provider makes, and the rider's place. */
export function locationModule() {
  const watchers: ((fix: Fix) => void)[] = [];
  const rider: { at: LatLon | null } = { at: null };
  const module = {
    __esModule: true,
    Accuracy: { Balanced: 3 },
    watchers,
    rider,
    requestForegroundPermissionsAsync: () => Promise.resolve({ granted: true, status: 'granted' }),
    watchPositionAsync: (_options: unknown, onFix: (fix: Fix) => void) => {
      expect(watchers).toHaveLength(0);
      expect(typeof onFix).toBe('function');
      watchers.push(onFix);
      if (rider.at !== null) {
        onFix({ coords: rider.at, timestamp: Date.now() });
      }
      return Promise.resolve({ remove: () => void watchers.splice(watchers.indexOf(onFix), 1) });
    },
  };
  expect(watchers).toHaveLength(0);
  // AppState is react-native's own jest mock: the foreground cases call its recorded 'change' listeners.
  expect(jest.isMockFunction(AppState.addEventListener)).toBe(true);
  return module;
}

export type LocationFake = ReturnType<typeof locationModule>;
