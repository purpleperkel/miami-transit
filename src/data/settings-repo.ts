import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import type { WritableSqlExecutor } from './sql-executor';
import { isCurrentUserDb, USER_DB_VERSION } from './user-db';

/**
 * Plan M7.3: the trip settings in the user DB (table `setting`, user-db.ts migration 1) — the
 * margins leave-by and the reminder plan use for every trip. Each setting is a whole number with a
 * default and a range (TRIP_SETTINGS); a setting never written reads as its default, and `reset`
 * goes back to it.
 *
 * Not here, by arbiter ruling (2026-10-01): the walking/jogging paces (src/ui/settings/walking-pace.ts)
 * and the quota meter (src/live/quota-store.ts) live in expo-sqlite/kv-store.
 */

export type SettingSpec = {
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
  /** What the number means, for Data & Settings and error messages. */
  readonly label: string;
};

export const TRIP_SETTINGS = Object.freeze({
  /** On the platform this long before the train (leave-by's buffer, src/domain/trips/leave-by.ts). */
  boardBufferS: Object.freeze({ defaultValue: 120, min: 0, max: 900, label: 'seconds on the platform before the train' }),
  /** The reminder fires this long before the leave-by (src/domain/trips/notification-plan.ts); 0 = "leave now". */
  reminderLeadS: Object.freeze({ defaultValue: 0, min: 0, max: 1800, label: 'seconds of warning before the leave-by' }),
} satisfies Record<string, SettingSpec>);

export type SettingKey = keyof typeof TRIP_SETTINGS;
export type TripSettings = Readonly<Record<SettingKey, number>>;

export type SettingError = { readonly kind: 'invalid-setting'; readonly message: string };

const SETTING_KEYS = Object.freeze(Object.keys(TRIP_SETTINGS) as SettingKey[]);

export class SettingsRepo {
  private readonly db: WritableSqlExecutor;

  constructor(db: WritableSqlExecutor) {
    invariant(typeof db.run === 'function', 'the settings need a writable executor');
    invariant(isCurrentUserDb(db), `the user DB is migrated to version ${USER_DB_VERSION} (migrateUserDb) before the settings are used`);
    this.db = db;
  }

  /** The value in effect: the stored one, or the default when none is stored. */
  get(key: SettingKey): number {
    const spec = specOf(key);
    const row = this.db.get<{ value: number }>('SELECT value FROM setting WHERE key = :key', { key });
    invariant(row === null || typeof row.value === 'number', `a stored ${key} is a number`);
    const value = row === null ? spec.defaultValue : row.value;
    invariant(inRange(spec, value), `${key} is within ${spec.min}–${spec.max}, got ${value}`);
    return value;
  }

  /** Store a value if it is a whole number within the setting's range; otherwise refuse, storing nothing. */
  set(key: SettingKey, value: number): Result<number, SettingError> {
    const spec = specOf(key);
    if (!inRange(spec, value)) {
      return err({ kind: 'invalid-setting', message: `${key} (${spec.label}) is a whole number from ${spec.min} to ${spec.max}` });
    }
    const changed = this.db.run('INSERT INTO setting (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value', {
      key,
      value,
    });
    invariant(changed === 1, `one setting row written for ${key}`);
    const stored = this.get(key);
    invariant(stored === value, `${key} reads back as ${value}`);
    return ok(stored);
  }

  /** Forget the stored value: the setting reads as its default again. */
  reset(key: SettingKey): number {
    const spec = specOf(key);
    const removed = this.db.run('DELETE FROM setting WHERE key = :key', { key });
    invariant(removed === 0 || removed === 1, 'a key names at most one setting');
    const value = this.get(key);
    invariant(value === spec.defaultValue, `${key} is back to its default`);
    return value;
  }

  /** Every trip setting in effect. */
  all(): TripSettings {
    const entries = SETTING_KEYS.map((key) => [key, this.get(key)] as const);
    const settings = Object.freeze(Object.fromEntries(entries)) as TripSettings;
    invariant(SETTING_KEYS.every((key) => Number.isSafeInteger(settings[key])), 'every setting has a value');
    invariant(Object.keys(settings).length === SETTING_KEYS.length, 'all() names exactly the trip settings');
    return settings;
  }
}

function specOf(key: SettingKey): SettingSpec {
  invariant(SETTING_KEYS.includes(key), `"${key}" is a trip setting`);
  const spec: SettingSpec = TRIP_SETTINGS[key];
  invariant(inRange(spec, spec.defaultValue), `${key}'s default is in its own range`);
  return spec;
}

function inRange(spec: SettingSpec, value: number): boolean {
  invariant(spec.min <= spec.max, 'a setting range is ordered');
  invariant(typeof value === 'number', 'a setting value is a number');
  return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max;
}
