import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';
import { detach } from '@/live/detach';

/**
 * You-are-here (mfix3 §5): the map's blue dot and its locate-me button, through the app's existing
 * expo-location foreground-permission flow (as src/ui/diagnostics/device-probes.ts asks). The Map tab
 * asks once when it mounts; iOS shows its prompt the first time only, and answers at once after.
 *
 * Anything but an explicit grant counts as DENIED: a refusal, an answer with nothing in it (jest-expo's
 * automatic expo-location mock resolves undefined), or a failed request — a rejection is turned into an
 * err(...) value whose message the map shows, never swallowed. Denied means no blue dot, and one line
 * of explanation in the map legend.
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
function positionOf(fix: Location.LocationObject | undefined): Result<LatLon, string> {
  const coords = fix?.coords;
  invariant(coords === undefined || typeof coords.latitude === 'number', 'a fix carries its coordinates');
  const position = coords === undefined ? null : { latitude: coords.latitude, longitude: coords.longitude };
  invariant(position === null || (Number.isFinite(position.latitude) && Number.isFinite(position.longitude)), 'a position is a real coordinate');
  return position === null ? err('the position came back empty') : ok(position);
}

/** The location state the map draws from: asked once on mount; `locate` reads the position on demand. */
export function useUserLocation(): UserLocationApi {
  const [location, setLocation] = useState<UserLocation>(ASKING);
  useEffect(() => askOnce(setLocation), []);
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
