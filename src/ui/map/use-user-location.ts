import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';
import { detach } from '@/live/detach';

import { copy } from '../copy';

/**
 * You-are-here (mfix3 §5): the map's blue dot and its locate-me button, through the app's existing
 * expo-location foreground-permission flow (as src/ui/diagnostics/device-probes.ts asks). The Map tab
 * asks once when it mounts; iOS shows its prompt the first time only, and answers at once after.
 *
 * Anything but an explicit grant counts as DENIED: a refusal, an answer with nothing in it (jest-expo's
 * automatic expo-location mock resolves undefined), or a failed request — a rejection is turned into an
 * err(...) value whose message the map shows, never swallowed. Denied means no blue dot, and one line
 * of explanation in the map legend.
 *
 * ONE location owner for the app (mfix6): UserLocationProvider (src/ui/location/UserLocationProvider.tsx),
 * mounted once by the root layout, asks once and runs the app's ONE position watch — Balanced accuracy, a
 * new fix every WATCH_DISTANCE_M, enough to keep "350 m" honest without running GPS hard. It shares the
 * answer and the latest fix through LocationContext, which this module owns. The Stations list (m6b R7),
 * the hurry hook and the Now strip, the Trips tab and a trip's screen, and the route options sheet's
 * hurry chips (mfix5; every plan since mfix8) read the fix through useUserPosition; the map's blue dot reads the
 * answer through useUserLocation. So the dot, the list's distances and the chips agree, and the phone
 * runs one watch, not one per caller (the Now strip alone is mounted twice on iOS 26, once per accessory
 * placement). This module holds the pieces the provider uses and never imports the provider.
 */

export type UserLocation =
  | { readonly kind: 'asking' }
  | { readonly kind: 'granted' }
  /** `problem`: why the request itself failed; null when the answer was simply not a grant. */
  | { readonly kind: 'denied'; readonly problem: string | null };

export type UserLocationApi = {
  readonly location: UserLocation;
  /** The user's position now, or why there is none. */
  readonly locate: () => Promise<Result<LatLon, string>>;
};

const ASKING: UserLocation = Object.freeze({ kind: 'asking' });

/** Why there is no grant: the answer was not one, or the request itself failed. */
export type NoGrant = { readonly kind: 'refused' } | { readonly kind: 'failed'; readonly message: string };

/** Asks for foreground location; resolves (never rejects) with the grant, or why there is none. */
export function askForLocation(): Promise<Result<'granted', NoGrant>> {
  invariant(typeof Location.requestForegroundPermissionsAsync === 'function', 'expo-location asks for permission');
  const asked = Location.requestForegroundPermissionsAsync().then(grantOf, (error: unknown) => failedRequest(error));
  invariant(typeof asked.then === 'function', 'the answer arrives later');
  return asked;
}

/** A permission answer read defensively: only `granted === true` is a grant (an absent answer is not). */
function grantOf(answer: Location.LocationPermissionResponse | undefined): Result<'granted', NoGrant> {
  const granted = answer?.granted === true;
  invariant(typeof granted === 'boolean', 'an answer grants or does not');
  invariant(!granted || answer !== undefined, 'only a real answer grants');
  return granted ? ok('granted') : err({ kind: 'refused' });
}

/** A permission request that failed: denied, with the failure's message kept. */
function failedRequest(error: unknown): Result<never, NoGrant> {
  const message = messageOf(error);
  invariant(message.length > 0, 'a failed request says why');
  const noGrant = err<NoGrant>({ kind: 'failed', message });
  invariant(!noGrant.ok, 'a failed request is an err value');
  return noGrant;
}

/** A failed read, as an err value carrying its message. */
function failureOf(error: unknown): Result<never, string> {
  const failure = err(messageOf(error));
  invariant(!failure.ok, 'a failure is an err value');
  invariant(failure.error.length > 0, 'a failure says why');
  return failure;
}

/** What a rejection says: an Error's name and message, else the value itself. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : `${String(error)}`;
  invariant(typeof message === 'string', 'a failure has a message');
  const said = message.trim().length > 0 ? message : 'the request failed without a message';
  invariant(said.length > 0, 'a message is never empty');
  return said;
}

/** The user's position now (one fix at balanced accuracy, as the Diagnostics probe takes it), or why there is none. */
export function currentPosition(): Promise<Result<LatLon, string>> {
  invariant(typeof Location.getCurrentPositionAsync === 'function', 'expo-location reads a position');
  const read = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(positionOf, failureOf);
  invariant(typeof read.then === 'function', 'the position arrives later');
  return read;
}

/** A position answer read defensively: one with no coordinates is no position. */
export function positionOf(fix: Location.LocationObject | undefined): Result<LatLon, string> {
  const coords = fix?.coords;
  invariant(coords === undefined || typeof coords.latitude === 'number', 'a fix carries its coordinates');
  const position = coords === undefined ? null : { latitude: coords.latitude, longitude: coords.longitude };
  invariant(position === null || (Number.isFinite(position.latitude) && Number.isFinite(position.longitude)), 'a position is a real coordinate');
  return position === null ? err('the position came back empty') : ok(position);
}

/**
 * The location state the map draws from. Under UserLocationProvider (the app) it is the provider's one
 * permission answer, so the app asks once. Bare — m5c's TransitMap tests render the map alone — the map
 * asks for itself on mount: permission only, never a watch. `locate` reads the position on demand.
 */
export function useUserLocation(): UserLocationApi {
  const shared = useContext(LocationContext);
  const bare = shared === null;
  const [own, setOwn] = useState<UserLocation>(ASKING);
  useEffect(() => (bare ? askOnce(setOwn) : undefined), [bare]);
  const location = shared === null ? own : shared.location;
  const locate = useCallback(() => currentPosition(), []);
  invariant(location.kind === 'asking' || location.kind === 'granted' || location.kind === 'denied', 'location is asked, granted or denied');
  invariant(typeof locate === 'function', 'the map can locate the user');
  return { location, locate };
}

/** Asks for permission and reports the answer to `set` — unless the map unmounted first; returns the teardown. */
function askOnce(set: (location: UserLocation) => void): () => void {
  invariant(typeof set === 'function', 'the answer is reported to a state setter');
  const life = { mounted: true };
  detach(
    askForLocation().then((answer) => report(life, set, answer.ok ? { kind: 'granted' } : { kind: 'denied', problem: answer.error.kind === 'failed' ? answer.error.message : null })),
    (message) => report(life, set, { kind: 'denied', problem: message }),
  );
  invariant(life.mounted, 'the ask starts while the map is mounted');
  return () => {
    life.mounted = false;
  };
}

/** Reports a location answer to the map, if it is still mounted. */
function report(life: { readonly mounted: boolean }, set: (location: UserLocation) => void, next: UserLocation): void {
  invariant(typeof set === 'function', 'the answer is reported to a state setter');
  invariant(next.kind === 'granted' || next.kind === 'denied', 'an answer grants or denies');
  if (life.mounted) {
    set(next);
  }
}

/** The position watch reports a new fix after the rider has moved this far. */
export const WATCH_DISTANCE_M = 50;

/** The rider's position as a list follows it. */
export type UserPosition = {
  /** The latest fix, or null before one arrives (or without permission). */
  readonly coordinate: LatLon | null;
  /** Why there is no fix (location off, refused or failed), or null. */
  readonly note: string | null;
};

const WAITING: UserPosition = Object.freeze({ coordinate: null, note: null });

/** What the app's one location owner shares: its one permission answer, and its one watch's latest fix. */
export type SharedLocation = {
  readonly location: UserLocation;
  readonly position: UserPosition;
};

/** The shared location before the answer: asking, no fix yet. */
export const LOCATING: SharedLocation = Object.freeze({ location: ASKING, position: WAITING });

/** UserLocationProvider's context; null outside it (useUserPosition fails loud there, useUserLocation asks for itself). */
export const LocationContext = createContext<SharedLocation | null>(null);

/**
 * The rider's position: the latest fix of the app's ONE location watch, or why there is none (the Stations
 * list, the hurry hook and the Now strip, the Trips tab, a trip's screen, and the route options sheet's
 * hurry chips, mfix5 and mfix8). Not `enabled`: no position, whatever the watch has. Outside
 * UserLocationProvider it fails loud: there is no fallback that would open a watch of its own.
 */
export function useUserPosition(enabled: boolean = true): UserPosition {
  const shared = useContext(LocationContext);
  invariant(shared !== null, 'useUserPosition needs UserLocationProvider above it (the app\'s one location watch, mounted by src/app/_layout.tsx)');
  const current = enabled ? shared.position : WAITING;
  invariant(current.coordinate === null || isLatLon(current.coordinate), 'a fix is a real coordinate');
  invariant(current.coordinate === null || current.note === null, 'a fix carries no excuse');
  return current;
}

/** A watched fix as the list's position: the coordinate, or why the fix had none. */
export function fixed(position: Result<LatLon, string>): UserPosition {
  const next = position.ok ? { coordinate: position.value, note: null } : unlocated(position.error);
  invariant(next.coordinate === null || isLatLon(next.coordinate), 'a fix is a real coordinate');
  invariant((next.coordinate === null) !== (next.note === null), 'a position has a fix or an excuse, not both');
  return next;
}

/** No position: location is off, with the problem (when there was one) in brackets. */
export function unlocated(problem: string | null): UserPosition {
  invariant(problem === null || typeof problem === 'string', 'a problem is a message or nothing');
  const note = problem === null || problem.trim().length === 0 ? copy.noLocation : `${copy.noLocation} (${problem})`;
  invariant(note.startsWith(copy.noLocation), 'the note says location is off first');
  return { coordinate: null, note };
}
