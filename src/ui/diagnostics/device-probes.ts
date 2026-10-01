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
 *   probeNotification  a local notification 5 s out that the probe sees arrive (keep Diagnostics open)
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
/** How long after scheduling the probe waits for its own notification: the 5 s delay plus slack. */
const NOTIFICATION_WAIT_S = 15;
/** Where iOS turns notifications on or off for Expo Go, which hosts this app on the phone. */
const EXPO_GO_NOTIFICATION_SETTINGS = 'Settings > Notifications > Expo Go';
const NOTIFICATION_TIMEOUT_ERROR =
  `notification: nothing arrived within ${NOTIFICATION_WAIT_S} s. Keep Diagnostics open while it runs, ` +
  `and check that ${EXPO_GO_NOTIFICATION_SETTINGS} allows notifications`;
const MAPS_URL = `maps://?q=Government%20Center&ll=${GOVERNMENT_CENTER.latitude},${GOVERNMENT_CENTER.longitude}`;
/** The maps:// probe's failure prefix names the exact URL, so a FAIL says what iOS could not open. */
const MAPS_FAILURE_LABEL = `maps:// link: could not open ${MAPS_URL}`;
/** Steps that may show a system permission prompt wait for a human; the rest answer quickly. */
const PROMPT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 20_000;
const QUICK_TIMEOUT_MS = 5_000;

/**
 * Passes only when the probe's own notification is seen to arrive. iOS reports an arrival to the app only
 * while it is in the foreground, so Diagnostics stays open for the few seconds the probe runs.
 */
export function probeNotification(): Promise<ProbeOutcome> {
  invariant(NOTIFICATION_DELAY_S === 5 && NOTIFICATION_WAIT_S === 15, 'due 5 s out, awaited for up to 15 s');
  invariant(NOTIFICATION_WAIT_S * 1000 < PROMPT_TIMEOUT_MS, 'the arrival wait fits inside the step deadline');
  return settleProbe('notification', notifyAndAwaitArrival, PROMPT_TIMEOUT_MS);
}

async function notifyAndAwaitArrival(): Promise<ProbeOutcome> {
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
  const outcome = await scheduleAndAwaitArrival();
  invariant(outcome.ok || outcome.error.startsWith('notification:'), 'a notification failure names its probe');
  return outcome;
}

/** Identifiers the received-listener has reported since the probe subscribed, and the wait to wake on each. */
type Arrivals = { readonly seen: Set<string>; wake: (() => void) | null };

/**
 * Subscribes to received notifications BEFORE scheduling, so even a delivery that beats the schedule call's
 * answer is recorded, then waits up to 15 s for the identifier scheduleNotificationAsync returned. Other
 * notifications are ignored. The subscription is removed on every path: arrival, timeout, failed schedule.
 */
async function scheduleAndAwaitArrival(): Promise<ProbeOutcome> {
  const arrivals: Arrivals = { seen: new Set(), wake: null };
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    arrivals.seen.add(notification.request.identifier);
    arrivals.wake?.();
  });
  invariant(typeof subscription.remove === 'function', 'the received-listener subscription can be removed');
  try {
    const scheduledAt = Date.now();
    const id = await Notifications.scheduleNotificationAsync({
      content: { title: 'Miami Transit probe', body: `Scheduled ${NOTIFICATION_DELAY_S} s earlier: local notifications work.` },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: NOTIFICATION_DELAY_S },
    });
    invariant(id.length > 0, 'a scheduled notification has an identifier');
    const arrived = await awaitArrival(arrivals, id);
    return arrived ? ok(`received after ${secondsSince(scheduledAt)} s`) : err(NOTIFICATION_TIMEOUT_ERROR);
  } finally {
    subscription.remove();
  }
}

/** True as soon as `id` is among the arrivals (already, or when the listener next fires); false after 15 s. */
async function awaitArrival(arrivals: Arrivals, id: string): Promise<boolean> {
  invariant(id.length > 0, 'the probe waits for its own identifier');
  invariant(arrivals.wake === null, 'one wait at a time');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), NOTIFICATION_WAIT_S * 1000);
      arrivals.wake = () => (arrivals.seen.has(id) ? resolve(true) : undefined);
      arrivals.wake();
    });
  } finally {
    clearTimeout(timer);
    arrivals.wake = null;
  }
}

function secondsSince(startMs: number): number {
  invariant(Number.isFinite(startMs), 'the start is a real timestamp');
  const seconds = Math.max(0, Math.round((Date.now() - startMs) / 1000));
  invariant(Number.isInteger(seconds) && seconds >= 0, 'elapsed time is whole, non-negative seconds');
  return seconds;
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
  // React Native's Linking.openURL is Promise<void> (Libraries/Linking/Linking.js:47): the promise resolving
  // means iOS opened the link, a rejection means it could not (settleProbe turns that into err). The resolved
  // value is no contract and is never read; reading it scored a link that did open as FAIL on the phone (M1.19).
  return settleProbe(
    MAPS_FAILURE_LABEL,
    async () => {
      await Linking.openURL(MAPS_URL);
      return ok('Apple Maps opened at Government Center');
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
