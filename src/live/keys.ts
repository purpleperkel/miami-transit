import * as SecureStore from 'expo-secure-store';

import { DEFAULT_SWIFTLY_AGENCY_KEY } from '../domain/live/transports';
import { PROVIDER_IDS, type ProviderId } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';

/**
 * Plan M4.8 / CLAUDE.md "Secrets": the realtime API keys live ONLY in the iOS Keychain, through
 * expo-secure-store. Jamie pastes a key in Data & Settings; it is stored under
 * `live.key.<provider>` and read back when the live runtime starts. No key is ever bundled, logged,
 * or read from the build environment.
 *
 * Swiftly's agency key (the `<agencyKey>` path segment of its URLs) is a Settings value that arrives
 * in the same onboarding email as the API key, so it is kept beside it, under `live.agency.swiftly`;
 * it defaults to `miami` when unset.
 *
 * Every function returns a Result: a Keychain call that rejects (e.g. the device is locked) becomes
 * `{ kind: 'keychain' }`, a bad paste `{ kind: 'invalid-key' }` — nothing here rejects or throws for
 * either, and no message ever contains a key.
 */

/** The Keychain operations keys.ts uses. expo-secure-store is the store; tests pass an in-memory one. */
export type SecretStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/** What the live runtime knows about its credentials. */
export type LiveKeys = {
  readonly swiftly: string | null;
  readonly transitland: string | null;
  readonly swiftlyAgency: string;
};

export type KeyError = { readonly kind: 'invalid-key' | 'keychain'; readonly message: string };

export const NO_KEYS: LiveKeys = Object.freeze({ swiftly: null, transitland: null, swiftlyAgency: DEFAULT_SWIFTLY_AGENCY_KEY });

/** The Keychain item holding Swiftly's agency key. */
export const SWIFTLY_AGENCY_ITEM = 'live.agency.swiftly';

/** An agency key is one URL path segment, e.g. `miami`. */
const AGENCY_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** expo-secure-store as a SecretStore. */
export const KEYCHAIN: SecretStore = SecureStore;

/** What a masked key starts with: four bullets stand for the hidden characters, whatever their number. */
export const KEY_MASK = '••••';
/** A masked key shows at most this many of its last characters… */
const HINT_MAX_CHARS = 4;
/** …and never more than one in this many of the key's characters (a short key shows fewer, or none). */
const HINT_SHARE = 4;

/**
 * A key as Data & Settings shows it: `••••` + its last 4 characters (`••••WXYZ`), so Jamie can tell
 * which key is stored without the key ever being rendered. At most a quarter of the key is shown,
 * so a key shorter than 16 characters shows fewer of its last characters, and one under 4 shows none.
 */
export function maskKey(key: string): string {
  invariant(key.length > 0, 'only a stored (non-empty) key is masked');
  const shown = Math.min(HINT_MAX_CHARS, Math.floor(key.length / HINT_SHARE));
  const masked = `${KEY_MASK}${key.slice(key.length - shown)}`;
  invariant(masked.length - KEY_MASK.length === shown && shown * HINT_SHARE <= key.length, 'at most a quarter of the key shows');
  return masked;
}

/** The Keychain item holding `provider`'s API key, e.g. `live.key.transitland`. */
export function keyItem(provider: ProviderId): string {
  invariant((PROVIDER_IDS as readonly string[]).includes(provider), `"${provider}" is a realtime provider`);
  const item = `live.key.${provider}`;
  invariant(/^[A-Za-z0-9._-]+$/.test(item), 'a Keychain item name uses only the characters expo-secure-store allows');
  return item;
}

/** `provider`'s stored API key (null when none is stored), or why the Keychain could not be read. */
export async function readKey(provider: ProviderId, store: SecretStore = KEYCHAIN): Promise<Result<string | null, KeyError>> {
  invariant(typeof store.getItemAsync === 'function', 'keys are read from a SecretStore');
  const stored = await keychain(() => store.getItemAsync(keyItem(provider)), `read the ${provider} key`);
  if (!stored.ok) {
    return stored;
  }
  const key = stored.value === null || stored.value.trim() === '' ? null : stored.value;
  invariant(key === null || key.trim().length > 0, 'a read key is null or has content');
  return ok(key);
}

/**
 * Stores a pasted API key for `provider`, trimmed; returns the key stored. A blank paste, or one with
 * whitespace inside it (a header value cannot carry a line break, and no real key has a space), is
 * refused — and nothing is stored — so a bad paste can never replace a good key.
 */
export async function saveKey(provider: ProviderId, pasted: string, store: SecretStore = KEYCHAIN): Promise<Result<string, KeyError>> {
  invariant(typeof pasted === 'string', 'a pasted key is text');
  const key = pasted.trim();
  if (key === '' || /\s/.test(key)) {
    const message = key === '' ? `the pasted ${provider} key is empty` : `the pasted ${provider} key has whitespace inside it — copy it again`;
    return err({ kind: 'invalid-key', message });
  }
  const saved = await keychain(() => store.setItemAsync(keyItem(provider), key), `store the ${provider} key`);
  invariant(key.length > 0 && !/\s/.test(key), 'only a usable key is stored');
  return saved.ok ? ok(key) : saved;
}

/** Removes `provider`'s API key from the Keychain. */
export async function clearKey(provider: ProviderId, store: SecretStore = KEYCHAIN): Promise<Result<null, KeyError>> {
  const item = keyItem(provider);
  invariant(item.startsWith('live.key.'), 'only an API key item is removed');
  const removed = await keychain(() => store.deleteItemAsync(item), `remove the ${provider} key`);
  invariant(removed.ok || removed.error.kind === 'keychain', 'removing a key fails only in the Keychain');
  return removed.ok ? ok(null) : removed;
}

/** Swiftly's agency key: the stored one, else `miami`. */
export async function readSwiftlyAgency(store: SecretStore = KEYCHAIN): Promise<Result<string, KeyError>> {
  const stored = await keychain(() => store.getItemAsync(SWIFTLY_AGENCY_ITEM), 'read the Swiftly agency key');
  if (!stored.ok) {
    return stored;
  }
  const text = stored.value?.trim() ?? '';
  const agency = AGENCY_KEY.test(text) ? text : DEFAULT_SWIFTLY_AGENCY_KEY;
  invariant(AGENCY_KEY.test(agency), 'the agency key is one URL path segment');
  invariant(text === '' || agency === text || !AGENCY_KEY.test(text), 'a valid stored agency key is the one in effect');
  return ok(agency);
}

/** Stores Swiftly's agency key, trimmed; a blank value restores the default (`miami`). Returns the agency key now in effect. */
export async function saveSwiftlyAgency(pasted: string, store: SecretStore = KEYCHAIN): Promise<Result<string, KeyError>> {
  invariant(typeof pasted === 'string', 'a pasted agency key is text');
  const agency = pasted.trim();
  if (agency !== '' && !AGENCY_KEY.test(agency)) {
    return err({ kind: 'invalid-key', message: 'a Swiftly agency key is letters, digits, - and _ only (e.g. miami)' });
  }
  const saved =
    agency === ''
      ? await keychain(() => store.deleteItemAsync(SWIFTLY_AGENCY_ITEM), 'reset the Swiftly agency key')
      : await keychain(() => store.setItemAsync(SWIFTLY_AGENCY_ITEM, agency), 'store the Swiftly agency key');
  invariant(agency === '' || AGENCY_KEY.test(agency), 'only a valid agency key is stored');
  return saved.ok ? ok(agency === '' ? DEFAULT_SWIFTLY_AGENCY_KEY : agency) : saved;
}

/** Every credential the live runtime needs, read from the Keychain at once. */
export async function readLiveKeys(store: SecretStore = KEYCHAIN): Promise<Result<LiveKeys, KeyError>> {
  invariant(typeof store.getItemAsync === 'function', 'credentials are read from a SecretStore');
  const [swiftly, transitland, swiftlyAgency] = await Promise.all([readKey('swiftly', store), readKey('transitland', store), readSwiftlyAgency(store)]);
  if (!swiftly.ok) {
    return swiftly;
  }
  if (!transitland.ok) {
    return transitland;
  }
  if (!swiftlyAgency.ok) {
    return swiftlyAgency;
  }
  const keys: LiveKeys = Object.freeze({ swiftly: swiftly.value, transitland: transitland.value, swiftlyAgency: swiftlyAgency.value });
  invariant(AGENCY_KEY.test(keys.swiftlyAgency), 'the agency key in effect is valid');
  return ok(keys);
}

/** Runs one Keychain call; a rejection becomes a `keychain` KeyError naming what was being done. */
async function keychain<T>(call: () => Promise<T>, doing: string): Promise<Result<T, KeyError>> {
  invariant(typeof call === 'function', 'a Keychain call is a function');
  invariant(doing.length > 0, 'a Keychain call says what it does');
  try {
    return ok(await call());
  } catch (error) {
    return err({ kind: 'keychain', message: `could not ${doing}: ${error instanceof Error ? error.message : String(error)}` });
  }
}
