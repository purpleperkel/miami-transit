import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

import { haversineMeters, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok } from '@/lib/result';

import { type ProbeOutcome, settleProbe } from './probe-kit';

/**
 * M1.17 device-API probes, run on the phone inside Expo Go:
 *   probeNotification  a local notification 5 s out (Jamie backgrounds the app and watches for it)
 *   probeGeocode       Apple's geocoder puts Government Center within 1 km of the real station
 *   probeLocation      a foreground location fix
 *   probeLiquidGlass   Liquid Glass is available for the tab bar and floating chrome
 *   probeHaptics       a success haptic plays (felt, not measured)
 *   probeMapsLink      a `maps://` link opens Apple Maps (the A→B handoff path)
 */

/** Government Center Metrorail, northbound platform: county GTFS stop 9513 (stops.txt, feed of 2026-07-31). */
const GOVERNMENT_CENTER: LatLon = { latitude: 25.776044, longitude: -80.19603 };
/** City-qualified like a real address, so the geocoder cannot pick another city's Government Center. */
const GEOCODE_QUERY = 'Government Center, Miami, FL';
const GEOCODE_TOLERANCE_M = 1000;
const NOTIFICATION_DELAY_S = 5;
const MAPS_URL = `maps://?q=Government%20Center&ll=${GOVERNMENT_CENTER.latitude},${GOVERNMENT_CENTER.longitude}`;
/** Steps that may show a system permission prompt wait for a human; the rest answer quickly. */
const PROMPT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 20_000;
const QUICK_TIMEOUT_MS = 5_000;

export function probeNotification(): Promise<ProbeOutcome> {
  invariant(Number.isInteger(NOTIFICATION_DELAY_S) && NOTIFICATION_DELAY_S === 5, 'the probe notification is due 5 s out');
  invariant(NOTIFICATION_DELAY_S * 1000 < PROMPT_TIMEOUT_MS, 'scheduling finishes well before the step deadline');
  return settleProbe('notification', scheduleProbeNotification, PROMPT_TIMEOUT_MS);
}

async function scheduleProbeNotification(): Promise<ProbeOutcome> {
  const permission = await Notifications.requestPermissionsAsync();
  invariant(typeof permission.granted === 'boolean', 'a permission answer says granted or not');
  if (!permission.granted) {
    return err(`notification: permission is ${permission.status}`);
  }
  // Without a handler iOS drops a notification that fires while the app is in front.
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  const id = await Notifications.scheduleNotificationAsync({
    content: { title: 'Miami Transit probe', body: `Scheduled ${NOTIFICATION_DELAY_S} s earlier: local notifications work.` },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: NOTIFICATION_DELAY_S },
  });
  invariant(id.length > 0, 'a scheduled notification has an identifier');
  return ok(`due in ${NOTIFICATION_DELAY_S} s; background the app now and watch for it`);
}

export function probeGeocode(): Promise<ProbeOutcome> {
  invariant(GEOCODE_QUERY.includes('Government Center'), 'the probe geocodes Government Center');
  invariant(GEOCODE_TOLERANCE_M === 1000, 'the result must land within 1 km');
  return settleProbe('geocode', geocodeGovernmentCenter, NETWORK_TIMEOUT_MS);
}

async function geocodeGovernmentCenter(): Promise<ProbeOutcome> {
  const results = await Location.geocodeAsync(GEOCODE_QUERY);
  invariant(Array.isArray(results), 'geocodeAsync answers with a list');
  const outcome = judgeGeocode(results);
  invariant(outcome.ok || outcome.error.startsWith('geocode:'), 'a geocode failure names its probe');
  return outcome;
}

/** Apple's best match (the first result) must land within 1 km of the real station. */
export function judgeGeocode(results: readonly LatLon[]): ProbeOutcome {
  invariant(Array.isArray(results), 'geocode results are a list');
  const best = results[0];
  if (best === undefined) {
    return err(`geocode: no result for "${GEOCODE_QUERY}"`);
  }
  const meters = haversineMeters(GOVERNMENT_CENTER, best);
  invariant(meters >= 0, 'a distance is never negative');
  if (meters > GEOCODE_TOLERANCE_M) {
    return err(`geocode: "${GEOCODE_QUERY}" landed ${formatDistance(meters)} from the station (limit 1 km)`);
  }
  return ok(`"${GEOCODE_QUERY}" landed ${formatDistance(meters)} from the station`);
}

export function probeLocation(): Promise<ProbeOutcome> {
  invariant(PROMPT_TIMEOUT_MS >= 30_000, 'a location fix may follow a permission prompt and a cold GPS start');
  invariant(GOVERNMENT_CENTER.latitude > 25 && GOVERNMENT_CENTER.latitude < 26, 'the reference point is in Miami');
  return settleProbe('location', locateDevice, PROMPT_TIMEOUT_MS);
}

/** Reports accuracy and distance to Government Center, never raw coordinates (screenshots are evidence). */
async function locateDevice(): Promise<ProbeOutcome> {
  const permission = await Location.requestForegroundPermissionsAsync();
  invariant(typeof permission.granted === 'boolean', 'a permission answer says granted or not');
  if (!permission.granted) {
    return err(`location: permission is ${permission.status}`);
  }
  const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const meters = haversineMeters(GOVERNMENT_CENTER, fix.coords);
  invariant(Number.isFinite(meters), 'a fix is a real coordinate');
  const accuracy = fix.coords.accuracy === null ? 'unknown accuracy' : `±${Math.round(fix.coords.accuracy)} m`;
  return ok(`fix (${accuracy}) ${formatDistance(meters)} from Government Center`);
}

export function probeLiquidGlass(): Promise<ProbeOutcome> {
  invariant(typeof isLiquidGlassAvailable === 'function', 'expo-glass-effect exports isLiquidGlassAvailable');
  invariant(typeof isGlassEffectAPIAvailable === 'function', 'expo-glass-effect exports isGlassEffectAPIAvailable');
  return settleProbe('Liquid Glass', checkLiquidGlass, QUICK_TIMEOUT_MS);
}

function checkLiquidGlass(): ProbeOutcome {
  const api = isGlassEffectAPIAvailable();
  invariant(typeof api === 'boolean', 'isGlassEffectAPIAvailable answers yes or no');
  const components = isLiquidGlassAvailable();
  invariant(typeof components === 'boolean', 'isLiquidGlassAvailable answers yes or no');
  if (!api) {
    return err('Liquid Glass: the glass effect API is missing on this iOS build');
  }
  if (!components) {
    return err('Liquid Glass: the API exists but Liquid Glass components are unavailable');
  }
  return ok('available: the glass effect API and Liquid Glass components');
}

export function probeHaptics(): Promise<ProbeOutcome> {
  invariant(typeof Haptics.notificationAsync === 'function', 'expo-haptics exports notificationAsync');
  invariant(Haptics.NotificationFeedbackType.Success !== undefined, 'expo-haptics has a success pattern');
  return settleProbe(
    'haptics',
    async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return ok('success haptic played: confirm you felt it');
    },
    QUICK_TIMEOUT_MS,
  );
}

export function probeMapsLink(): Promise<ProbeOutcome> {
  invariant(MAPS_URL.startsWith('maps://'), 'the probe opens the Apple Maps URL scheme');
  invariant(!MAPS_URL.includes(' '), 'the maps URL is percent-encoded');
  // openURL resolves true once iOS opened the link, and rejects (settleProbe → err) when nothing can.
  return settleProbe(
    'maps:// link',
    async () => {
      const opened = await Linking.openURL(MAPS_URL);
      return opened ? ok('Apple Maps opened at Government Center') : err('maps:// link: iOS did not open it');
    },
    PROMPT_TIMEOUT_MS,
  );
}

function formatDistance(meters: number): string {
  invariant(Number.isFinite(meters) && meters >= 0, 'a distance to format is finite and non-negative');
  const text = meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  invariant(text.length > 0, 'a formatted distance is never empty');
  return text;
}
