import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';

import { invariant } from '../../../lib/invariant';
import { err, ok } from '../../../lib/result';
import {
  judgeGeocode,
  probeGeocode,
  probeHaptics,
  probeLiquidGlass,
  probeLocation,
  probeMapsLink,
  probeNotification,
} from '../device-probes';

// test-time mock of native module
jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: jest.fn(), setNotificationHandler: jest.fn(), scheduleNotificationAsync: jest.fn(),
  addNotificationReceivedListener: jest.fn(), SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));
// test-time mock of native module
jest.mock('expo-location', () => ({
  geocodeAsync: jest.fn(), requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));
// test-time mock of native module
jest.mock('expo-glass-effect', () => ({ isGlassEffectAPIAvailable: jest.fn(), isLiquidGlassAvailable: jest.fn() }));
// test-time mock of native module
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(), NotificationFeedbackType: { Success: 'success' } }));
// expo-linking is deliberately NOT mocked: its real openURL (`return await RNLinking.openURL(url)`) runs as on the
// phone, over react-native's Linking, which RN's jest preset already replaces with jest.fn.

// Government Center Metrorail (GTFS stop 9512, the southbound platform ~13 m from the probe's reference).
const AT_THE_STATION = { latitude: 25.776047, longitude: -80.196157 };
const BRICKELL = { latitude: 25.7586, longitude: -80.1951 }; // ~1.9 km south
const MAPS_URL = 'maps://?q=Government%20Center&ll=25.776044,-80.19603';
const PROBE_NOTIFICATION_ID = 'probe-notification-id';
const OTHER_NOTIFICATION_ID = 'another-apps-notification';
const NOTIFICATION_TIMEOUT_ERROR =
  'notification: nothing arrived within 15 s. Keep Diagnostics open while it runs, ' +
  'and check that Settings > Notifications > Expo Go allows notifications';
const PENDING = Symbol('pending');

afterEach(() => {
  jest.useRealTimers();
  jest.resetAllMocks();
});

const removeSubscription = jest.fn();

/** Fake timers; permission granted; scheduling answers with the probe's identifier; subscribing hands back `remove`. */
function armNotificationProbe(): void {
  invariant(jest.isMockFunction(Notifications.addNotificationReceivedListener), 'expo-notifications is the jest mock');
  jest.useFakeTimers();
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted' } as never);
  jest.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue(PROBE_NOTIFICATION_ID);
  jest.mocked(Notifications.addNotificationReceivedListener).mockReturnValue({ remove: removeSubscription });
  invariant(removeSubscription.mock.calls.length === 0, 'each run starts with an untouched subscription');
}

/** Fires the received-listener the latest probe run subscribed, as iOS does when a notification arrives. */
function deliver(identifier: string): void {
  invariant(identifier.length > 0, 'a delivered notification has an identifier');
  const listener = jest.mocked(Notifications.addNotificationReceivedListener).mock.lastCall?.[0];
  invariant(listener !== undefined, 'the probe subscribed its received-listener before anything arrived');
  listener({ request: { identifier } } as never);
}

describe('probeNotification', () => {
  beforeEach(armNotificationProbe);

  it('schedules one local notification on a 5 s time-interval trigger once permission is granted', async () => {
    const outcome = probeNotification();
    await jest.advanceTimersByTimeAsync(5_000);
    deliver(PROBE_NOTIFICATION_ID);
    await expect(outcome).resolves.toEqual(ok('received after 5 s'));
    const request = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls[0]?.[0];
    expect(request?.trigger).toEqual({ type: 'timeInterval', seconds: 5 });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('reports received when the listener fires', async () => {
    const outcome = probeNotification();
    await jest.advanceTimersByTimeAsync(5_000);
    deliver(OTHER_NOTIFICATION_ID); // not the probe's identifier: ignored, so the wait goes on
    await jest.advanceTimersByTimeAsync(1_000);
    deliver(PROBE_NOTIFICATION_ID);
    await expect(outcome).resolves.toEqual(ok('received after 6 s'));
    // Subscribed BEFORE scheduling, so no arrival can slip past the listener.
    const [subscribed] = jest.mocked(Notifications.addNotificationReceivedListener).mock.invocationCallOrder;
    const [scheduled] = jest.mocked(Notifications.scheduleNotificationAsync).mock.invocationCallOrder;
    expect(subscribed).toBeLessThan(scheduled ?? Number.NEGATIVE_INFINITY);
  });

  it('fails after 15 s with the Expo Go settings hint', async () => {
    const outcome = probeNotification();
    await jest.advanceTimersByTimeAsync(5_000);
    deliver(OTHER_NOTIFICATION_ID);
    await jest.advanceTimersByTimeAsync(9_999);
    await expect(Promise.race([outcome, Promise.resolve(PENDING)])).resolves.toBe(PENDING);
    await jest.advanceTimersByTimeAsync(1);
    const result = await outcome;
    expect(result).toEqual(err(NOTIFICATION_TIMEOUT_ERROR));
    expect(result.ok ? '' : result.error).toContain('15 s');
    expect(result.ok ? '' : result.error).toContain('Settings > Notifications > Expo Go');
  });

  it('removes its listener on both paths', async () => {
    const received = probeNotification();
    await jest.advanceTimersByTimeAsync(5_000);
    deliver(PROBE_NOTIFICATION_ID);
    await expect(received).resolves.toEqual(ok('received after 5 s'));
    expect(removeSubscription).toHaveBeenCalledTimes(1);
    removeSubscription.mockClear();
    const timedOut = probeNotification();
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(timedOut).resolves.toEqual(err(NOTIFICATION_TIMEOUT_ERROR));
    expect(removeSubscription).toHaveBeenCalledTimes(1);
    expect(Notifications.addNotificationReceivedListener).toHaveBeenCalledTimes(2);
  });
});

describe('probeNotification: failures before the wait', () => {
  beforeEach(armNotificationProbe);

  it('fails, and still removes its listener, when scheduling rejects', async () => {
    jest.mocked(Notifications.scheduleNotificationAsync).mockRejectedValue(new Error('UNErrorDomain error 1'));
    await expect(probeNotification()).resolves.toEqual(err('notification: UNErrorDomain error 1'));
    expect(removeSubscription).toHaveBeenCalledTimes(1);
  });

  it('fails, and schedules nothing, when permission is denied', async () => {
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: false, status: 'denied' } as never);
    await expect(probeNotification()).resolves.toEqual(err('notification: permission is denied'));
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(Notifications.addNotificationReceivedListener).not.toHaveBeenCalled();
  });
});

describe('probeGeocode', () => {
  it('geocodes Government Center (city-qualified) and passes when it lands within 1 km', async () => {
    jest.mocked(Location.geocodeAsync).mockResolvedValue([AT_THE_STATION]);
    await expect(probeGeocode()).resolves.toEqual(ok('"Government Center, Miami, FL" landed 13 m from the station'));
    expect(Location.geocodeAsync).toHaveBeenCalledWith('Government Center, Miami, FL');
  });

  it('judges Apple’s best match: > 1 km away or no result fails', () => {
    expect(judgeGeocode([BRICKELL, AT_THE_STATION])).toEqual(
      err('geocode: "Government Center, Miami, FL" landed 1.9 km from the station (limit 1 km)'),
    );
    expect(judgeGeocode([]).ok).toBe(false);
  });

  it('turns a geocoder error into a failed probe', async () => {
    jest.mocked(Location.geocodeAsync).mockRejectedValue(new Error('kCLErrorDomain error 8'));
    await expect(probeGeocode()).resolves.toEqual(err('geocode: kCLErrorDomain error 8'));
    expect(Location.geocodeAsync).toHaveBeenCalledTimes(1);
  });
});

describe('probeLocation', () => {
  it('reports accuracy and distance from Government Center, never raw coordinates', async () => {
    jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted' } as never);
    jest.mocked(Location.getCurrentPositionAsync).mockResolvedValue({ coords: { ...BRICKELL, accuracy: 35.4 } } as never);
    const outcome = await probeLocation();
    expect(outcome).toEqual(ok('fix (±35 m) 1.9 km from Government Center'));
    expect(JSON.stringify(outcome)).not.toContain('25.75');
  });

  it('fails without asking for a fix when permission is denied', async () => {
    jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: false, status: 'denied' } as never);
    await expect(probeLocation()).resolves.toEqual(err('location: permission is denied'));
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });
});

describe('probeLiquidGlass', () => {
  it('passes only when both the API and the components are available', async () => {
    jest.mocked(isGlassEffectAPIAvailable).mockReturnValue(true);
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(true);
    await expect(probeLiquidGlass()).resolves.toEqual(ok('available: the glass effect API and Liquid Glass components'));
    jest.mocked(isLiquidGlassAvailable).mockReturnValue(false);
    await expect(probeLiquidGlass()).resolves.toEqual(
      err('Liquid Glass: the API exists but Liquid Glass components are unavailable'),
    );
  });
});

describe('probeHaptics', () => {
  it('plays the success haptic, and fails if the haptic engine rejects', async () => {
    jest.mocked(Haptics.notificationAsync).mockResolvedValue(undefined);
    await expect(probeHaptics()).resolves.toEqual(ok('success haptic played: confirm you felt it'));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    jest.mocked(Haptics.notificationAsync).mockRejectedValue(new Error('haptics unavailable'));
    await expect(probeHaptics()).resolves.toEqual(err('haptics: haptics unavailable'));
  });
});

// React Native's Linking.openURL is Promise<void>: resolving (with any value) is success, rejecting is failure.
describe('probeMapsLink', () => {
  it('passes when openURL resolves undefined', async () => {
    jest.mocked(Linking.openURL).mockResolvedValue(undefined);
    await expect(probeMapsLink()).resolves.toEqual(ok('Apple Maps opened at Government Center'));
    expect(Linking.openURL).toHaveBeenCalledWith(MAPS_URL);
  });

  it('passes when openURL resolves false', async () => {
    jest.mocked(Linking.openURL).mockResolvedValue(false);
    await expect(probeMapsLink()).resolves.toEqual(ok('Apple Maps opened at Government Center'));
    expect(Linking.openURL).toHaveBeenCalledWith(MAPS_URL);
  });

  it('fails naming the URL when openURL rejects', async () => {
    jest.mocked(Linking.openURL).mockRejectedValue(new Error('Unable to open URL'));
    const outcome = await probeMapsLink();
    expect(outcome).toEqual(err(`maps:// link: could not open ${MAPS_URL}: Unable to open URL`));
    expect(outcome.ok ? '' : outcome.error).toContain(MAPS_URL);
    expect(outcome.ok ? '' : outcome.error).toContain('Unable to open URL');
  });
});
