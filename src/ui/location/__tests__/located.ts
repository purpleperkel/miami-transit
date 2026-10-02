import type * as Location from 'expo-location';

import type { LatLon } from '../../../lib/geo';

/**
 * What a test's labelled expo-location mock (the NATIVE module) answers, for screens rendered inside the app's ONE
 * UserLocationProvider (mfix7; one-watch.test's pattern, shared). The test file mocks expo-location with a labelled
 * native-module mock whose Accuracy, requestForegroundPermissionsAsync and watchPositionAsync are jest functions (the
 * exact mock is one-watch.test.tsx's), and, before each render, says where the rider is: `locateAt(Location, point)` grants and fixes the one watch at
 * the point at once; `locateAt(Location, null)` refuses, so there is no watch and no fix.
 */
export function locateAt(location: typeof Location, at: LatLon | null): void {
  const ask = jest.mocked(location.requestForegroundPermissionsAsync);
  const watch = jest.mocked(location.watchPositionAsync);
  expect(jest.isMockFunction(ask) && jest.isMockFunction(watch)).toBe(true);
  const answer = { granted: at !== null, status: at === null ? 'denied' : 'granted', canAskAgain: false, expires: 'never' } as Location.LocationPermissionResponse;
  ask.mockReset().mockImplementation(() => Promise.resolve(answer));
  watch.mockReset().mockImplementation((_options, onFix) => watchFixing(at, onFix));
  expect(ask.mock.calls.length + watch.mock.calls.length).toBe(0);
}

/** A started watch that fixes the rider at `at` at once. */
function watchFixing(at: LatLon | null, onFix: Location.LocationCallback): Promise<Location.LocationSubscription> {
  expect(at).not.toBeNull();
  expect(typeof onFix).toBe('function');
  if (at !== null) {
    void onFix({ coords: { ...at, altitude: null, accuracy: 10, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  }
  return Promise.resolve({ remove: () => undefined });
}
