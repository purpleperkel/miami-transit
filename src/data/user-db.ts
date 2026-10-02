import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import type { SqlExecutor, WritableSqlExecutor } from './sql-executor';

/**
 * Plan M7.3: the user DB — the one database the app writes: saved trips (saved-trips-repo.ts) and
 * trip settings (settings-repo.ts). The schedule DB is replaced wholesale with each feed; this one
 * survives app updates, so its schema only ever moves forward through numbered migrations, and
 * `PRAGMA user_version` records the last one applied.
 *
 * Platform-neutral: it talks to a `WritableSqlExecutor` only — on the phone the expo-sqlite twin
 * (`new ExpoSqlExecutor(openDatabaseSync(USER_DB_NAME))`), on the Mac an in-memory node:sqlite
 * executor in the tests. It never imports node:sqlite or expo-sqlite itself.
 *
 * Rules for migrations: append, never edit one that has shipped; each runs in its own transaction
 * together with its user_version bump, so a failed step leaves the DB at the previous version.
 * (m4a's quota meter and m8b's walking pace live in expo-sqlite/kv-store by ruling, not here.)
 */

/** The user DB's file name on the phone (expo-sqlite's default directory). */
export const USER_DB_NAME = 'user.db';

export type Migration = { readonly version: number; readonly sql: string };

/** Version 1: saved trips and integer settings. */
const V1 = `
CREATE TABLE saved_trip(
  trip_id TEXT PRIMARY KEY CHECK (length(trip_id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  from_station_key TEXT NOT NULL CHECK (length(from_station_key) > 0),
  to_station_key TEXT NOT NULL CHECK (length(to_station_key) > 0 AND to_station_key <> from_station_key),
  start_lat REAL,
  start_lon REAL,
  walk_override_min INTEGER CHECK (walk_override_min IS NULL OR walk_override_min BETWEEN 0 AND 180),
  remind_days INTEGER NOT NULL DEFAULT 0 CHECK (remind_days BETWEEN 0 AND 127),
  remind_at_min INTEGER CHECK (remind_at_min IS NULL OR remind_at_min BETWEEN 0 AND 1439),
  created_epoch INTEGER NOT NULL,
  CHECK ((start_lat IS NULL) = (start_lon IS NULL)),
  CHECK ((remind_days = 0) = (remind_at_min IS NULL))
) WITHOUT ROWID;
CREATE TABLE setting(
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  value INTEGER NOT NULL CHECK (typeof(value) = 'integer')
) WITHOUT ROWID;
`;

/** Every migration, in version order (1, 2, …). Append only. */
export const USER_DB_MIGRATIONS: readonly Migration[] = Object.freeze([{ version: 1, sql: V1 }]);

/** The schema version this build of the app reads and writes. */
export const USER_DB_VERSION = USER_DB_MIGRATIONS.length;

/** The DB was written by a newer app than this one: leave it untouched. */
export type UserDbError = { readonly kind: 'user-db'; readonly message: string };

export type MigrationReport = {
  /** user_version before migrating. */
  readonly from: number;
  /** user_version after migrating (USER_DB_VERSION). */
  readonly to: number;
  /** The versions applied this time, in order; empty when the DB was already current. */
  readonly applied: readonly number[];
};

/** The DB's `PRAGMA user_version`: the last migration applied (0 for a new, empty DB). */
export function userDbVersion(db: SqlExecutor): number {
  invariant(typeof db.get === 'function', 'userDbVersion reads through a SqlExecutor');
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  const version = row === null ? Number.NaN : row.user_version;
  invariant(Number.isSafeInteger(version) && version >= 0, `PRAGMA user_version is a whole number, got ${version}`);
  return version;
}

/**
 * Bring the DB up to the newest of `migrations` (by default USER_DB_MIGRATIONS), applying each
 * missing version in its own transaction. Idempotent: on a current DB it applies nothing. A DB
 * newer than every migration is refused, untouched.
 */
export function migrateUserDb(db: WritableSqlExecutor, migrations: readonly Migration[] = USER_DB_MIGRATIONS): Result<MigrationReport, UserDbError> {
  invariant(migrations.every((m, i) => m.version === i + 1 && m.sql.trim().length > 0), 'migrations are numbered 1, 2, … with SQL each');
  const from = userDbVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    return err({ kind: 'user-db', message: `user.db is at version ${from}; this app knows up to ${latest} — update the app` });
  }
  const applied: number[] = [];
  for (const migration of migrations.slice(from)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }
  const to = userDbVersion(db);
  invariant(to === latest, `user.db reached version ${latest}, got ${to}`);
  return ok({ from, to, applied });
}

/** The repos' shared precondition: the DB is migrated to exactly this app's version (migrateUserDb). */
export function isCurrentUserDb(db: SqlExecutor): boolean {
  invariant(USER_DB_VERSION > 0, 'this app has a user DB schema');
  const current = userDbVersion(db) === USER_DB_VERSION;
  invariant(!current || userDbVersion(db) > 0, 'a current user DB has a schema');
  return current;
}
