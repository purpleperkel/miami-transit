import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

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
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
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
// test-time mock of native module
jest.mock('expo-linking', () => ({ openURL: jest.fn() }));

// Government Center Metrorail (GTFS stop 9512, the southbound platform ~13 m from the probe's reference).
const AT_THE_STATION = { latitude: 25.776047, longitude: -80.196157 };
const BRICKELL = { latitude: 25.7586, longitude: -80.1951 }; // ~1.9 km south

afterEach(() => {
  jest.resetAllMocks();
});

describe('probeNotification', () => {
  it('schedules one local notification on a 5 s time-interval trigger once permission is granted', async () => {
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: true, status: 'granted' } as never);
    jest.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('notification-id');
    await expect(probeNotification()).resolves.toEqual(ok('due in 5 s; background the app now and watch for it'));
    const request = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls[0]?.[0];
    expect(request?.trigger).toEqual({ type: 'timeInterval', seconds: 5 });
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  });

  it('fails, and schedules nothing, when permission is denied', async () => {
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: false, status: 'denied' } as never);
    await expect(probeNotification()).resolves.toEqual(err('notification: permission is denied'));
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
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

describe('probeMapsLink', () => {
  it('opens a maps:// link centred on Government Center, and fails if iOS refuses it', async () => {
    jest.mocked(Linking.openURL).mockResolvedValue(true);
    await expect(probeMapsLink()).resolves.toEqual(ok('Apple Maps opened at Government Center'));
    expect(Linking.openURL).toHaveBeenCalledWith('maps://?q=Government%20Center&ll=25.776044,-80.19603');
    jest.mocked(Linking.openURL).mockRejectedValue(new Error('Unable to open URL'));
    await expect(probeMapsLink()).resolves.toEqual(err('maps:// link: Unable to open URL'));
  });
});
