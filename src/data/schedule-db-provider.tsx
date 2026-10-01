import { Directory, Paths } from 'expo-file-system';
import { SQLiteProvider, type SQLiteDatabase, useSQLiteContext } from 'expo-sqlite';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

import scheduleManifest from '@/assets/db/manifest.json';
import scheduleDbAsset from '@/assets/db/schedule.db';

import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import { ExpoSqlExecutor } from './expo-sql-executor';
import { type ScheduleDbError, ScheduleRepo } from './schedule-repo';

/**
 * Plan M3.8: the bundled schedule DB, opened on the phone and provided to the whole app.
 *
 * expo-sqlite (SDK 57) opens a bundled .db through SQLiteProvider's documented `assetSource` prop,
 * which copies the asset into place — but ONLY when no file of that name exists yet (expo-sqlite 57
 * ios/SQLiteModule.swift importAssetDatabaseAsync: an existing file wins unless forceOverwrite). So
 * the copy's NAME carries the data's identity: `schedule-<first 12 hex of the manifest's dbSha256>.db`.
 * Keyed on the DB's own hash, not the feed's (arbiter ruling 2026-10-01): a builder change rewrites
 * the DB over the same feed, and must still land on the phone as a fresh copy.
 *
 *  - The copies live in a directory of their own (`<documents>/schedule-db/`), handed to expo-sqlite
 *    and expo-file-system as the same URI, so cleanup can never reach another database.
 *  - Once the current copy is open (onInit), every other `schedule-<12 hex>.db` there is deleted with
 *    its -wal / -shm / -journal files, at most MAX_STALE_FILES_PER_LAUNCH per launch.
 *  - The open copy must be this bundle's data: ScheduleRepo checks schema and time zone, and the
 *    copy's meta.feed_sha256 must equal the manifest's.
 *
 * The provider never blanks the app: children always render, and `useScheduleDb()` reports the DB
 * as opening, ready (with its ScheduleRepo) or failed (with why).
 */

/** How many hex digits of dbSha256 name a copy (48 bits: a collision between two builds is not a concern). */
const NAME_SHA_HEX = 12;
/** A schedule copy (group 1), or one of its sidecar files. */
const SCHEDULE_FILE = /^(schedule-[0-9a-f]{12}\.db)(-wal|-shm|-journal)?$/;
/** Stale files removed per launch at most; any rest go on the next launch. */
export const MAX_STALE_FILES_PER_LAUNCH = 32;

export type ScheduleDbState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'ready'; readonly repo: ScheduleRepo }
  | { readonly kind: 'failed'; readonly message: string };

/** The copy's file name for a DB hash: `schedule-<first 12 hex>.db`. */
export function scheduleDbName(dbSha256: string): string {
  invariant(/^[0-9a-f]{64}$/.test(dbSha256), 'the manifest records the DB hash as 64 lowercase hex digits');
  const name = `schedule-${dbSha256.slice(0, NAME_SHA_HEX)}.db`;
  invariant(SCHEDULE_FILE.test(name), 'the name is one the cleanup recognises');
  return name;
}

/** This bundle's copy: named for the bundled DB's bytes. */
export const SCHEDULE_DB_NAME = scheduleDbName(scheduleManifest.dbSha256);
const SCHEDULE_DB_DIRECTORY = new Directory(Paths.document, 'schedule-db');
const ASSET_SOURCE = { assetId: scheduleDbAsset };
const OPENING: ScheduleDbState = { kind: 'opening' };
const ScheduleDbContext = createContext<ScheduleDbState>(OPENING);

/** The names among `names` that belong to a schedule copy other than `currentName`: old DBs and their sidecars. */
export function staleScheduleFiles(names: readonly string[], currentName: string): string[] {
  invariant(SCHEDULE_FILE.exec(currentName)?.[2] === undefined, `${currentName} is a schedule copy's own name, not a sidecar`);
  const stale = names.filter((name) => {
    const match = SCHEDULE_FILE.exec(name);
    return match !== null && match[1] !== currentName;
  });
  invariant(stale.every((name) => !name.startsWith(currentName)), 'the current copy and its sidecars are never stale');
  return stale;
}

/** Deletes the stale schedule files in `directory`, at most MAX_STALE_FILES_PER_LAUNCH, in name order; the names removed. */
export function removeStaleCopies(directory: Directory, currentName: string): string[] {
  invariant(SCHEDULE_FILE.test(currentName), `${currentName} is a schedule copy name`);
  if (!directory.exists) {
    return [];
  }
  const entries = [...directory.list()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const stale = new Set(staleScheduleFiles(entries.map((entry) => entry.name), currentName));
  const doomed = entries.filter((entry) => stale.has(entry.name)).slice(0, MAX_STALE_FILES_PER_LAUNCH);
  for (const entry of doomed) {
    entry.delete();
  }
  invariant(doomed.every((entry) => !entry.exists), 'every stale file removed is gone');
  return doomed.map((entry) => entry.name);
}

/** expo-sqlite's native failures (expo-sqlite 57 ios/Exceptions.swift): a damaged or foreign file, not a bug here. */
const SQLITE_FAILURE_CODES: ReadonlySet<string> = new Set(['ERR_INTERNAL_SQLITE_ERROR', 'E_SQLITE_OPEN_DATABASE']);

function isSqliteFailure(error: unknown): error is Error {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  invariant(code === undefined || error instanceof Error, 'a coded failure is an Error');
  invariant(typeof code !== 'string' || code.length > 0, 'a failure code is never empty');
  return typeof code === 'string' && SQLITE_FAILURE_CODES.has(code);
}

/**
 * The schedule engine over the open copy, checked against this bundle's manifest — or why it cannot
 * serve. SQLite failures (a damaged copy) become an Err; any other throw is a bug and is rethrown.
 */
export function openScheduleRepo(db: SQLiteDatabase): Result<ScheduleRepo, string> {
  invariant(db.databasePath.length > 0, 'the schedule DB is open on a file');
  let opened: Result<ScheduleRepo, ScheduleDbError>;
  try {
    opened = ScheduleRepo.open(new ExpoSqlExecutor(db));
  } catch (error) {
    if (!isSqliteFailure(error)) {
      throw error;
    }
    return err(`the schedule DB copy cannot be read: ${error.message}`);
  }
  if (!opened.ok) {
    return err(`the schedule DB copy is not one this app reads: ${opened.error.message}`);
  }
  const feed = opened.value.meta.feedSha256;
  if (feed !== scheduleManifest.feedSha256) {
    return err(`the schedule DB copy holds feed ${feed.slice(0, 8)}; this bundle's manifest says ${scheduleManifest.feedSha256.slice(0, 8)}`);
  }
  invariant(opened.value.meta.schemaVersion === scheduleManifest.schemaVersion, 'the copy has the schema the manifest records');
  return ok(opened.value);
}

/**
 * SQLiteProvider's onInit: the current copy is open, so every older copy can go. Synchronous work in
 * a Promise-returning hook: expo-sqlite awaits it inside its async open, so a throw still fails the open.
 */
function removeOlderCopies(db: SQLiteDatabase): Promise<void> {
  invariant(db.databasePath.endsWith(`/${SCHEDULE_DB_NAME}`), `the provider opened ${SCHEDULE_DB_NAME}`);
  const removed = removeStaleCopies(SCHEDULE_DB_DIRECTORY, SCHEDULE_DB_NAME);
  invariant(!removed.includes(SCHEDULE_DB_NAME), 'the open copy is never removed');
  return Promise.resolve();
}

function failed(message: string): ScheduleDbState {
  invariant(message.length > 0, 'a failure says why');
  const state: ScheduleDbState = { kind: 'failed', message };
  invariant(state.kind === 'failed', 'a failed state');
  return state;
}

/** The schedule DB as the app sees it: opening, ready with its repo, or failed with why. */
export function useScheduleDb(): ScheduleDbState {
  const state = useContext(ScheduleDbContext);
  invariant(state.kind === 'opening' || state.kind === 'ready' || state.kind === 'failed', 'the schedule DB state is known');
  invariant(state.kind !== 'failed' || state.message.length > 0, 'a failure says why');
  return state;
}

/** Opens this bundle's schedule DB for everything inside it (mounted once, in the root layout). */
export function ScheduleDbProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ScheduleDbState>(OPENING);
  invariant(typeof ASSET_SOURCE.assetId === 'number', 'the schedule DB is bundled as a Metro asset (metro.config.js)');
  invariant(SCHEDULE_DB_DIRECTORY.uri.length > 0, 'the copies have a directory');
  // expo-sqlite 57 calls onError while rendering (src/hooks.tsx), so the state update waits for that render to finish.
  const onError = useCallback((error: Error) => queueMicrotask(() => setState(failed(`the schedule DB did not open: ${error.message}`))), []);
  return (
    <ScheduleDbContext.Provider value={state}>
      <SQLiteProvider
        databaseName={SCHEDULE_DB_NAME}
        directory={SCHEDULE_DB_DIRECTORY.uri}
        assetSource={ASSET_SOURCE}
        onInit={removeOlderCopies}
        onError={onError}>
        <PublishScheduleRepo onState={setState} />
      </SQLiteProvider>
      {children}
    </ScheduleDbContext.Provider>
  );
}

/** Rendered by SQLiteProvider only once the copy is open: reads it as a ScheduleRepo and publishes the outcome. */
function PublishScheduleRepo({ onState }: { readonly onState: (state: ScheduleDbState) => void }) {
  const db = useSQLiteContext();
  invariant(db.databasePath.endsWith(`/${SCHEDULE_DB_NAME}`), `the context holds ${SCHEDULE_DB_NAME}`);
  invariant(typeof onState === 'function', 'the provider listens for the outcome');
  useEffect(() => {
    const opened = openScheduleRepo(db);
    onState(opened.ok ? { kind: 'ready', repo: opened.value } : failed(opened.error));
    return () => onState(OPENING);
  }, [db, onState]);
  return null;
}
