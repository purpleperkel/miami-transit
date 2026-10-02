import Storage from 'expo-sqlite/kv-store';

import { isLatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';

/**
 * Plan M10b.1 (ruling R6): the "To" field's recent places — the destinations Jamie planned, newest
 * first, each name once, so a trip he takes again is one tap. They persist in expo-sqlite/kv-store, the
 * same ruling as src/ui/settings/walking-pace.ts (bundled in Expo Go, read SYNCHRONOUSLY), never in
 * module memory: every read goes to the store, so an app reload reads back exactly what was saved.
 *
 * The whole list lives under ONE key, written in one setItemSync, as a JSON array of { name, lat, lon }.
 * Only this module writes that key; a stored value it cannot read (only a future format could write one)
 * is not used — the list reads as empty and the next planned destination starts it again.
 */

export type RecentPlace = { readonly name: string; readonly lat: number; readonly lon: number };
export type RecentsError = { readonly kind: 'invalid-place' | 'storage'; readonly message: string };

/** The part of expo-sqlite/kv-store the recents use (tests may pass an in-memory one). */
export type RecentsStore = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

/** The kv-store key holding the list, as `[{"name":"Brickell","lat":25.7584,"lon":-80.1918}, …]`. */
export const RECENT_PLACES_ITEM = 'routes.recent-places';
/** The list keeps at most this many places; the oldest falls off. */
export const MAX_RECENT_PLACES = 8;

/** The list with `place` first and no other place of the same name (names compare trimmed, ignoring case), capped. */
export function withRecentPlace(places: readonly RecentPlace[], place: RecentPlace): RecentPlace[] {
  invariant(isPlace(place), `a recent place has a name and a real coordinate, got ${JSON.stringify(place)}`);
  const key = nameKey(place.name);
  const next = [place, ...places.filter((other) => nameKey(other.name) !== key)].slice(0, MAX_RECENT_PLACES);
  invariant(next[0] === place && next.length <= MAX_RECENT_PLACES, 'the newest place leads a capped list');
  invariant(new Set(next.map((p) => nameKey(p.name))).size === next.length, 'each name appears once');
  return next;
}

/** The recent places, newest first, read from the kv store (empty when nothing readable is stored). */
export function readRecentPlaces(store: RecentsStore = Storage): RecentPlace[] {
  invariant(typeof store.getItemSync === 'function', 'recent places are read synchronously from the kv store');
  const stored = parseStored(store.getItemSync(RECENT_PLACES_ITEM));
  const places = stored.ok ? stored.value : [];
  invariant(places.every(isPlace), 'every recent place read is a usable place');
  return places;
}

/** Puts `place` first in the stored list (moving it up if it is already there); returns the new list. */
export function recordRecentPlace(place: RecentPlace, store: RecentsStore = Storage): Result<RecentPlace[], RecentsError> {
  invariant(typeof store.setItemSync === 'function', 'recent places are written synchronously to the kv store');
  if (!isPlace(place)) {
    return err({ kind: 'invalid-place', message: `a recent place needs a name and a real coordinate, got ${JSON.stringify(place)}` });
  }
  const clean: RecentPlace = { name: place.name.trim(), lat: place.lat, lon: place.lon };
  const next = withRecentPlace(readRecentPlaces(store), clean);
  const written = writeList(store, next);
  if (!written.ok) {
    return written;
  }
  invariant(nameKey(readRecentPlaces(store)[0]?.name ?? '') === nameKey(clean.name), 'the place reads back first');
  return ok(next);
}

/** The stored text as places, or why it is not a list this module wrote. */
function parseStored(text: string | null): Result<RecentPlace[], string> {
  invariant(text === null || typeof text === 'string', 'the kv store holds text or nothing');
  if (text === null) {
    return ok([]);
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !Array.isArray(parsed.value) || !parsed.value.every(isPlace)) {
    return err(parsed.ok ? 'the stored value is not a list of places' : parsed.error);
  }
  const places = parsed.value.reduce<RecentPlace[]>((list, place) => (list.some((p) => nameKey(p.name) === nameKey(place.name)) ? list : [...list, place]), []);
  invariant(places.length <= parsed.value.length, 'reading only drops repeated names');
  return ok(places.slice(0, MAX_RECENT_PLACES));
}

function parseJson(text: string): Result<unknown, string> {
  invariant(typeof text === 'string', 'JSON is parsed from text');
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch (error) {
    invariant(error !== undefined, 'a parse failure has a cause');
    return err(`the stored value is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A place with a non-empty name and a real coordinate. */
function isPlace(value: unknown): value is RecentPlace {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const { name, lat, lon } = record ?? {};
  const yes = typeof name === 'string' && name.trim().length > 0 && typeof lat === 'number' && typeof lon === 'number' && isLatLon({ latitude: lat, longitude: lon });
  invariant(!yes || record !== null, 'only an object is a place');
  invariant(!yes || typeof name === 'string', 'a place is named');
  return yes;
}

/** How names are compared: trimmed, ignoring case ("brickell " is Brickell). */
function nameKey(name: string): string {
  invariant(typeof name === 'string', 'a name is text');
  const key = name.trim().toLowerCase();
  invariant(key.length <= name.length, 'a key never grows');
  return key;
}

/** One kv-store write of the whole list; a native failure becomes a `storage` error. */
function writeList(store: RecentsStore, places: readonly RecentPlace[]): Result<null, RecentsError> {
  invariant(places.length > 0 && places.length <= MAX_RECENT_PLACES, 'a written list has a place, and stays capped');
  const text = JSON.stringify(places.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon })));
  invariant(text.startsWith('[{'), 'the list is written as a JSON array of places');
  try {
    store.setItemSync(RECENT_PLACES_ITEM, text);
    return ok(null);
  } catch (error) {
    return err({ kind: 'storage', message: `could not save the recent places: ${error instanceof Error ? error.message : String(error)}` });
  }
}
