import type { SQLiteDatabase } from 'expo-sqlite';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * A test-time stand-in for the NATIVE module expo-sqlite, for tests that render the REAL ScheduleDbProvider over
 * the REAL committed assets/db/schedule.db (mfix7; StationsScreen.test's pattern, shared): SQLiteProvider "opens"
 * the database it is named, and useSQLiteContext hands back that copy, read through Node's own SQLite. A test file
 * installs it with its labelled native mock —
 *
 *   // test-time mock of native module
 *   jest.mock('expo-sqlite', () => jest.requireActual('../../../data/__tests__/schedule-sqlite-fake').scheduleSqliteModule());
 *
 * — and calls closeScheduleCopy() in afterAll. No app module is mocked: the provider, the executor and the repo
 * are the app's own.
 */

type NodeStatement = { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type NodeDatabase = { prepare(sql: string): NodeStatement; close(): void };
type NodeSqlite = { DatabaseSync: new (path: string, options: { readonly readOnly: boolean }) => NodeDatabase };

const OpenCopy = createContext<SQLiteDatabase | null>(null);
const open: { node: NodeDatabase | null; copy: SQLiteDatabase | null } = { node: null, copy: null };

/** expo-sqlite's bind params as node:sqlite takes them: a list spreads; a `:name` object passes whole. */
function nodeParams(params: unknown): unknown[] {
  expect(params === undefined || typeof params === 'object').toBe(true);
  const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
  expect(Array.isArray(list)).toBe(true);
  return list;
}

/** The open copy named `databaseName`: the committed schedule DB, opened once (a stable object, as expo-sqlite's is). */
function scheduleCopy(databaseName: string): SQLiteDatabase {
  expect(databaseName).toMatch(/\.db$/);
  if (open.copy === null) {
    const { DatabaseSync } = jest.requireActual<NodeSqlite>('node:sqlite');
    const node = new DatabaseSync(`${process.cwd()}/assets/db/schedule.db`, { readOnly: true });
    open.node = node;
    open.copy = {
      databasePath: `file:///documents/schedule-db/${databaseName}`,
      getAllSync: (sql: string, params?: unknown) => node.prepare(sql).all(...nodeParams(params)),
      getFirstSync: (sql: string, params?: unknown) => node.prepare(sql).get(...nodeParams(params)) ?? null,
    } as unknown as SQLiteDatabase;
  }
  expect(open.copy.databasePath.endsWith(`/${databaseName}`)).toBe(true);
  return open.copy;
}

/** expo-sqlite's provider: the named database is open for everything inside it. */
function SQLiteProvider({ databaseName, children }: { readonly databaseName: string; readonly children?: ReactNode }) {
  const copy = scheduleCopy(databaseName);
  expect(children).toBeDefined();
  expect(copy.databasePath.endsWith(`/${databaseName}`)).toBe(true);
  return <OpenCopy.Provider value={copy}>{children}</OpenCopy.Provider>;
}

/** expo-sqlite's hook: the database the provider above opened. */
function useSQLiteContext(): SQLiteDatabase {
  const copy = useContext(OpenCopy);
  expect(copy).not.toBeNull();
  expect(copy).toBe(open.copy);
  return copy as SQLiteDatabase;
}

/** The module the labelled jest.mock('expo-sqlite', …) returns. */
export function scheduleSqliteModule(): { readonly SQLiteProvider: typeof SQLiteProvider; readonly useSQLiteContext: typeof useSQLiteContext } {
  const module = { SQLiteProvider, useSQLiteContext };
  expect(typeof module.SQLiteProvider).toBe('function');
  expect(typeof module.useSQLiteContext).toBe('function');
  return module;
}

/** Closes the copy (call it in afterAll). */
export function closeScheduleCopy(): void {
  const node = open.node;
  open.node = null;
  open.copy = null;
  node?.close();
  expect(open.node).toBeNull();
  expect(open.copy).toBeNull();
}
