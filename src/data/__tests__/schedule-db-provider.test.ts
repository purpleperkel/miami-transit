import type { Directory, File } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import manifest from '../../../assets/db/manifest.json';
import { InvariantError } from '../../lib/invariant';
import {
  MAX_STALE_FILES_PER_LAUNCH,
  openScheduleRepo,
  removeStaleCopies,
  SCHEDULE_DB_NAME,
  scheduleDbName,
  staleScheduleFiles,
} from '../schedule-db-provider';

/**
 * M3.8: the schedule DB provider's logic. expo-sqlite and expo-file-system are native modules that
 * cannot load under jest (and there is no simulator on this Mac), so the database and directory
 * below are stand-ins; the provider component itself runs on the phone.
 */

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: jest.fn(), useSQLiteContext: jest.fn() }));
// test-time mock of native module
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), Paths: { document: 'file:///documents/' } }));

const OLD = 'schedule-0123456789ab.db';
const OLDER = 'schedule-ba9876543210.db';

/** test-time mock of native module: a directory of named files; deleting one removes it. */
function fakeDirectory(names: readonly string[]): { directory: Directory; files: Set<string> } {
  const files = new Set(names);
  const directory = { exists: true, list: () => [...files].map((name) => fakeEntry(name, files)) } as unknown as Directory;
  expect(directory.list()).toHaveLength(names.length);
  expect(files.size).toBe(names.length);
  return { directory, files };
}

/** test-time mock of native module: one listed file, which a delete takes out of `files`. */
function fakeEntry(name: string, files: Set<string>): File {
  const entry = { name, exists: files.has(name), delete: jest.fn() };
  entry.delete.mockImplementation(() => {
    files.delete(name);
    entry.exists = false;
  });
  expect(entry.exists).toBe(true);
  expect(entry.delete).not.toHaveBeenCalled();
  return entry as unknown as File;
}

const BOUNDS = { first_date: 20231113, first_base: 1_699_851_600, last_date: 20261231, last_base: 1_798_693_200, span_s: 90_240 };

/** test-time mock of native module: an open schedule copy answering its meta and calendar, or failing as given. */
function fakeScheduleDb(meta: Readonly<Record<string, string>>, failure: Error | null = null): SQLiteDatabase {
  const rows = Object.entries(meta).map(([key, value]) => ({ key, value }));
  const getAllSync = jest.fn(() => rows);
  if (failure !== null) {
    getAllSync.mockImplementation(() => {
      throw failure;
    });
  }
  const db = { databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`, getAllSync, getFirstSync: jest.fn(() => BOUNDS) };
  expect(db.databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
  return db as unknown as SQLiteDatabase;
}

const TRUE_META = {
  builder_version: String(manifest.builderVersion),
  feed_sha256: manifest.feedSha256,
  schema_version: String(manifest.schemaVersion),
  time_zone: 'America/New_York',
};

describe('schedule DB provider (M3.8)', () => {
  it('names the copy for the bundled DB’s own bytes: schedule-<first 12 hex of dbSha256>.db, never the feed hash', () => {
    expect(SCHEDULE_DB_NAME).toBe(`schedule-${manifest.dbSha256.slice(0, 12)}.db`);
    expect(SCHEDULE_DB_NAME).not.toContain(manifest.feedSha256.slice(0, 12));
  });

  it('a builder-only rebuild (same feed, new DB bytes) gets a new name, so it lands as a fresh copy', () => {
    const rebuilt = `${'7'.repeat(12)}${manifest.dbSha256.slice(12)}`;
    expect(scheduleDbName(rebuilt)).toBe('schedule-777777777777.db');
    expect(() => scheduleDbName(manifest.feedSha256.toUpperCase())).toThrow(InvariantError);
  });

  it('stale files: older copies with their -wal/-shm/-journal go; the current copy, its sidecars and other files stay', () => {
    const names = [SCHEDULE_DB_NAME, `${SCHEDULE_DB_NAME}-wal`, OLD, `${OLD}-wal`, `${OLD}-shm`, `${OLDER}-journal`, 'user.db', 'schedule-notes.txt'];
    expect(staleScheduleFiles(names, SCHEDULE_DB_NAME)).toEqual([OLD, `${OLD}-wal`, `${OLD}-shm`, `${OLDER}-journal`]);
    expect(() => staleScheduleFiles(names, `${SCHEDULE_DB_NAME}-wal`)).toThrow(InvariantError);
  });

  it('removeStaleCopies deletes exactly the stale files and leaves the open copy', () => {
    const { directory, files } = fakeDirectory([SCHEDULE_DB_NAME, `${SCHEDULE_DB_NAME}-shm`, OLD, `${OLD}-wal`, 'user.db']);
    expect(removeStaleCopies(directory, SCHEDULE_DB_NAME)).toEqual([OLD, `${OLD}-wal`]);
    expect([...files].sort()).toEqual([SCHEDULE_DB_NAME, `${SCHEDULE_DB_NAME}-shm`, 'user.db']);
  });

  it('the cleanup loop is bounded: at most 32 stale files per launch, the rest on the next', () => {
    const stale = Array.from({ length: 40 }, (_, i) => `schedule-${i.toString(16).padStart(12, '0')}.db`);
    const { directory, files } = fakeDirectory([SCHEDULE_DB_NAME, ...stale]);
    expect(removeStaleCopies(directory, SCHEDULE_DB_NAME)).toHaveLength(MAX_STALE_FILES_PER_LAUNCH);
    expect(removeStaleCopies(directory, SCHEDULE_DB_NAME)).toHaveLength(40 - MAX_STALE_FILES_PER_LAUNCH);
    expect(removeStaleCopies(directory, SCHEDULE_DB_NAME)).toEqual([]);
    expect([...files]).toEqual([SCHEDULE_DB_NAME]);
  });

  it('a directory that does not exist yet has nothing to clean', () => {
    const list = jest.fn();
    expect(removeStaleCopies({ exists: false, list } as unknown as Directory, SCHEDULE_DB_NAME)).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('the open copy serves when its meta is this bundle’s feed and schema', () => {
    const opened = openScheduleRepo(fakeScheduleDb(TRUE_META));
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.value.meta.feedSha256).toBe(manifest.feedSha256);
  });

  it('a copy holding another feed is refused, naming both hashes', () => {
    const opened = openScheduleRepo(fakeScheduleDb({ ...TRUE_META, feed_sha256: 'f'.repeat(64) }));
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toBe(`the schedule DB copy holds feed ffffffff; this bundle's manifest says ${manifest.feedSha256.slice(0, 8)}`);
  });

  it('a damaged copy (expo-sqlite ERR_INTERNAL_SQLITE_ERROR) is an Err, not a crash; any other throw is a bug and is rethrown', () => {
    const malformed = Object.assign(new Error('database disk image is malformed'), { code: 'ERR_INTERNAL_SQLITE_ERROR' });
    const opened = openScheduleRepo(fakeScheduleDb(TRUE_META, malformed));
    expect(!opened.ok && opened.error).toBe('the schedule DB copy cannot be read: database disk image is malformed');
    expect(() => openScheduleRepo(fakeScheduleDb(TRUE_META, new TypeError('a bug')))).toThrow(TypeError);
  });
});
