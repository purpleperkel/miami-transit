import type { SQLiteDatabase } from 'expo-sqlite';

import { ExpoSqlExecutor } from '../../../data/expo-sql-executor';
import type { SavedTrip } from '../../../data/saved-trips-repo';
import { ScheduleRepo } from '../../../data/schedule-repo';
import { type UserRepos, userReposOver } from '../../../data/user-db-provider';
import type { Result } from '../../../lib/result';

/**
 * Shared by the trips and Now-strip tests (M7.5–M7.9): the app's REAL data code — ExpoSqlExecutor, the
 * schedule repo, migrateUserDb and the user repos — over Node's own SQLite standing in for expo-sqlite's
 * native database (a plain object with the sync methods the executor calls; no module is mocked):
 *
 *   realScheduleRepo()   the REAL committed assets/db/schedule.db, read-only, in place
 *   memoryUserRepos()    a fresh in-memory user.db, migrated by the app's own migrations
 *
 * Instants are New York wall-clock times with their offset; 2026-09-30 is a Wednesday.
 */

type NodeStatement = { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): { changes: number | bigint } };
type NodeDatabase = { prepare(sql: string): NodeStatement; exec(sql: string): void; readonly isTransaction: boolean; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options?: { readonly readOnly?: boolean }) => NodeDatabase };

/** 08:00 Wednesday 2026-09-30, New York (EDT). */
export const WED_0800 = Date.parse('2026-09-30T08:00:00-04:00') / 1000;
/** 01:30 Wednesday 2026-09-30: Tuesday's last train has gone (01:04) and Wednesday's first is hours off. */
export const WED_0130 = Date.parse('2026-09-30T01:30:00-04:00') / 1000;

const opened: NodeDatabase[] = [];

/** expo-sqlite's bind params as node:sqlite takes them: a list spreads; a `:name` object passes whole. */
function nodeParams(params: unknown): unknown[] {
  const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
  expect(Array.isArray(list)).toBe(true);
  expect(params === undefined || typeof params === 'object').toBe(true);
  return list;
}

/** An object shaped like expo-sqlite's SQLiteDatabase (the sync calls ExpoSqlExecutor makes), over node:sqlite. */
export function nodeBackedDatabase(path: string, readOnly: boolean): SQLiteDatabase {
  const { DatabaseSync } = jest.requireActual<NodeSqlite>('node:sqlite');
  const node = new DatabaseSync(path, { readOnly });
  opened.push(node);
  const db = {
    databasePath: path === ':memory:' ? 'file:///documents/SQLite/user.db' : `file://${path}`,
    getAllSync: (sql: string, p?: unknown) => node.prepare(sql).all(...nodeParams(p)),
    getFirstSync: (sql: string, p?: unknown) => node.prepare(sql).get(...nodeParams(p)) ?? null,
    runSync: (sql: string, p?: unknown) => ({ changes: Number(node.prepare(sql).run(...nodeParams(p)).changes), lastInsertRowId: 0 }),
    execSync: (sql: string) => node.exec(sql),
    isInTransactionSync: () => node.isTransaction,
  };
  expect(opened).toContain(node);
  expect(db.databasePath.length).toBeGreaterThan(0);
  return db as unknown as SQLiteDatabase;
}

/** Closes every database the helpers opened (call it in afterAll). */
export function closeTripDbs(): void {
  const all = opened.splice(0, opened.length);
  all.forEach((db) => db.close());
  expect(opened).toHaveLength(0);
  expect(all.every((db) => typeof db.close === 'function')).toBe(true);
}

/** The schedule repo over the REAL committed schedule DB, through the app's own executor. */
export function realScheduleRepo(): ScheduleRepo {
  const repo = ScheduleRepo.open(new ExpoSqlExecutor(nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true)));
  expect(repo.ok).toBe(true);
  expect(repo.ok ? repo.value.meta.timeZone : null).toBe('America/New_York');
  return (repo as Extract<typeof repo, { ok: true }>).value;
}

/** A fresh in-memory user DB, migrated, with its two repos — as the UserDbProvider's `open` returns them. */
export function memoryUserRepos(): Result<UserRepos, string> {
  const repos = userReposOver(nodeBackedDatabase(':memory:', false));
  expect(repos.ok).toBe(true);
  expect(repos.ok ? repos.value.trips.list() : null).toEqual([]);
  return repos;
}

/** A saved trip between two stations, with the given walk and reminder (ids are short and readable). */
export function savedTrip(id: string, from: string, to: string, extra: Partial<SavedTrip> = {}): SavedTrip {
  const trip: SavedTrip = { id, name: `${id} trip`, fromStationKey: from, toStationKey: to, start: null, walkOverrideMin: null, reminder: null, createdEpoch: 1_790_000_000, ...extra };
  expect(trip.fromStationKey).not.toBe(trip.toStationKey);
  expect(trip.id).toMatch(/^[A-Za-z0-9_-]+$/);
  return trip;
}
