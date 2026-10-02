import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import { ExpoSqlExecutor } from './expo-sql-executor';
import { type SavedTrip, type SavedTripError, SavedTripsRepo } from './saved-trips-repo';
import { isSqliteFailure } from './schedule-db-provider';
import { SettingsRepo, type TripSettings } from './settings-repo';
import { migrateUserDb, USER_DB_NAME } from './user-db';

/**
 * Plan M7.3 → M7.8: the user DB on the phone — the one database the app writes (saved trips, trip
 * settings) — opened once, in the root layout, for every screen: expo-sqlite's openDatabaseSync(user.db)
 * → ExpoSqlExecutor → migrateUserDb → the two repos (m7a left this wiring to the trips UI).
 *
 * The open is synchronous (expo-sqlite's sync API, like the repos), so the provider is ready or failed
 * from its first render. A damaged file or a user.db from a newer app is `failed`, with why; any other
 * throw is a bug and is rethrown. Writes go through `book`, which re-reads the trips afterwards, so
 * every screen showing them (the Trips tab, the Now strip, the reminder sync) sees the change at once.
 *
 * `closed` is the state outside the provider (a screen rendered on its own, as the tab-shell test renders
 * the Trips route): nothing is saved there, so nothing is listed.
 */

export type UserRepos = { readonly trips: SavedTripsRepo; readonly settings: SettingsRepo };

/** The writes a screen may make to the saved trips. */
export type TripBook = {
  readonly save: (trip: SavedTrip) => Result<SavedTrip, SavedTripError>;
  readonly remove: (tripId: string) => boolean;
};

export type UserDbState =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'ready';
      /** Every saved trip, oldest first. */
      readonly trips: readonly SavedTrip[];
      readonly settings: TripSettings;
      readonly book: TripBook;
      /** Counts the writes made through `book`: a new number means the trips were read again. */
      readonly revision: number;
    }
  | { readonly kind: 'failed'; readonly message: string };

const CLOSED: UserDbState = Object.freeze({ kind: 'closed' });
const UserDbContext = createContext<UserDbState>(CLOSED);

/** The repos over an open expo-sqlite database, once its schema is current; or why it cannot be used. */
export function userReposOver(db: SQLiteDatabase): Result<UserRepos, string> {
  invariant(db.databasePath.length > 0, 'the user DB is open on a file');
  const executor = new ExpoSqlExecutor(db);
  const migrated = migrateUserDb(executor);
  if (!migrated.ok) {
    return err(migrated.error.message);
  }
  const repos = { trips: new SavedTripsRepo(executor), settings: new SettingsRepo(executor) };
  invariant(migrated.value.to === migrated.value.from + migrated.value.applied.length, 'the migration report adds up');
  return ok(repos);
}

/** Opens user.db in expo-sqlite's default directory; a SQLite failure (a damaged file) is an Err, any other throw a bug. */
export function openUserDb(): Result<UserRepos, string> {
  invariant(USER_DB_NAME.endsWith('.db'), 'the user DB is a .db file');
  let db: SQLiteDatabase;
  try {
    db = openDatabaseSync(USER_DB_NAME);
  } catch (error) {
    if (!isSqliteFailure(error)) {
      throw error;
    }
    return err(`user.db did not open: ${error.message}`);
  }
  const repos = userReposOver(db);
  invariant(repos.ok || repos.error.length > 0, 'a failure says why');
  return repos;
}

/** The provider's state for an opened (or failed) user DB, read afresh at `revision`. */
function userDbState(opened: Result<UserRepos, string>, revision: number, book: TripBook): UserDbState {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'a revision counts writes');
  if (!opened.ok) {
    return { kind: 'failed', message: opened.error };
  }
  const state: UserDbState = { kind: 'ready', trips: opened.value.trips.list(), settings: opened.value.settings.all(), book, revision };
  invariant(state.trips.every((trip) => trip.id.length > 0), 'every listed trip has an id');
  return state;
}

/** The user DB as the screens see it: closed (no provider), ready with the trips and settings, or failed with why. */
export function useUserDb(): UserDbState {
  const state = useContext(UserDbContext);
  invariant(state.kind === 'closed' || state.kind === 'ready' || state.kind === 'failed', 'the user DB state is known');
  invariant(state.kind !== 'failed' || state.message.length > 0, 'a failure says why');
  return state;
}

export type UserDbProviderProps = {
  readonly children: ReactNode;
  /** How the repos are opened (tests pass repos over an in-memory database); user.db on the phone by default. */
  readonly open?: () => Result<UserRepos, string>;
};

/** Opens the user DB once for everything inside it (mounted in the root layout). */
export function UserDbProvider({ children, open = openUserDb }: UserDbProviderProps) {
  const [opened] = useState(open);
  const [revision, setRevision] = useState(0);
  const save = useCallback((trip: SavedTrip) => written(opened, (repos) => repos.trips.create(trip), setRevision), [opened]);
  const remove = useCallback((tripId: string) => removed(opened, tripId, setRevision), [opened]);
  const book = useMemo(() => ({ save, remove }), [save, remove]);
  const state = useMemo(() => userDbState(opened, revision, book), [opened, revision, book]);
  invariant(opened.ok || state.kind === 'failed', 'a user DB that did not open is failed');
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'the writes are counted');
  return <UserDbContext.Provider value={state}>{children}</UserDbContext.Provider>;
}

type Bump = (next: (revision: number) => number) => void;

/** Runs a trip write; a successful one bumps the revision so the trips are read again. */
function written(opened: Result<UserRepos, string>, write: (repos: UserRepos) => Result<SavedTrip, SavedTripError>, bump: Bump): Result<SavedTrip, SavedTripError> {
  invariant(opened.ok, 'trips are written only through an open user DB');
  const outcome = write(opened.value);
  if (outcome.ok) {
    bump((revision) => revision + 1);
  }
  invariant(outcome.ok || outcome.error.message.length > 0, 'a refused write says why');
  return outcome;
}

/** Deletes a saved trip; true (and a new revision) if it existed. */
function removed(opened: Result<UserRepos, string>, tripId: string, bump: Bump): boolean {
  invariant(opened.ok, 'trips are removed only through an open user DB');
  invariant(tripId.length > 0, 'a trip is removed by id');
  const gone = opened.value.trips.remove(tripId);
  if (gone) {
    bump((revision) => revision + 1);
  }
  return gone;
}
