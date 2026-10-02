import { invariant } from '../../lib/invariant';

/**
 * mfix10 (Jamie, 2026-10-02: "use swiftly only on wifi"): is the phone on Wi-Fi, and may Swiftly be
 * asked for anything now? Pure: the reading arrives as plain strings (expo-network's network type
 * names), never the expo enum, so the domain stays shared with the Mac scripts.
 *
 * Arbiter ruling: on Wi-Fi = type WIFI or ETHERNET. CELLULAR, NONE, UNKNOWN, any other type, a reading
 * without a type and no reading at all are NOT on Wi-Fi, so an unknown network never spends cellular
 * data on Swiftly's whole-agency feed.
 */

/** A network reading as far as the gate reads it: its type, when it has one. */
export type NetworkReading = { readonly type?: string };

/** The network types that count as Wi-Fi. */
const WIFI_TYPES: readonly string[] = Object.freeze(['WIFI', 'ETHERNET']);

/** True only for a reading of type WIFI or ETHERNET; every other type, no type and no reading (null) are off Wi-Fi. */
export function isOnWifi(state: NetworkReading | null): boolean {
  invariant(state === null || typeof state === 'object', 'a network reading is an object, or null before the first one');
  const type = state === null ? undefined : state.type;
  const onWifi = typeof type === 'string' && WIFI_TYPES.includes(type);
  invariant(!onWifi || type === 'WIFI' || type === 'ETHERNET', 'only WIFI and ETHERNET count as on Wi-Fi');
  return onWifi;
}

/** Swiftly may be asked unless the rider turned on "Use Swiftly only on Wi-Fi" and the phone is off Wi-Fi. */
export function swiftlyAllowed({ wifiOnly, onWifi }: { readonly wifiOnly: boolean; readonly onWifi: boolean }): boolean {
  invariant(typeof wifiOnly === 'boolean', 'the Wi-Fi only setting is on or off');
  invariant(typeof onWifi === 'boolean', 'the phone is on Wi-Fi or not');
  const allowed = !wifiOnly || onWifi;
  invariant(allowed !== (wifiOnly && !onWifi), 'Swiftly is held back exactly when the setting is on and the phone is off Wi-Fi');
  return allowed;
}
