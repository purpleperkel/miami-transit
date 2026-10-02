/**
 * The platform-neutral SQL executor contract (plan §4 "src/data … sql-executor (expo + node
 * impls)", M3.1). The schedule engine (schedule-queries.ts, schedule-repo.ts) reads the schedule
 * DB through THIS interface only, so the same code runs:
 *   - on the phone, over expo-sqlite      → src/data/expo-sql-executor.ts
 *   - on the Mac, over Node's node:sqlite → scripts/lib/node-sql-executor.ts (the GTFS pipeline's
 *     executor, M2.15), which is how the node:test suites query the real assets/db/schedule.db.
 *
 * This module is types only: no runtime import, so it loads under Metro, jest and Node alike.
 *
 * `WritableSqlExecutor` (below) adds the write path the user DB needs; both twins implement it.
 *
 * The contract is SYNCHRONOUS because the node:sqlite executor is, and the schedule reads are
 * small indexed lookups on a ~2 MB read-only DB (one station's stop times for one or two service
 * days); expo-sqlite's `getAllSync` / `getFirstSync` serve them on the phone.
 *
 * Parameters: anonymous `?` placeholders take a list in order; named placeholders are written
 * `:name` in the SQL and passed by BARE name (`{ name: value }`). Each implementation maps that
 * to its driver's binding form (node:sqlite binds bare names; expo-sqlite wants the `:` prefix).
 */

/** A value SQLite stores or binds, on every platform the contract serves. */
export type SqlValue = null | number | string | Uint8Array;

/** Anonymous (`?`) parameters in order, or named (`:name`) parameters by bare name. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/** One result row: column name → value. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlExecutor {
  /** Every row of a query (column names → values), in the order SQLite returns them. */
  all<T extends object = SqlRow>(sql: string, params?: SqlParams): T[];
  /** The first row of a query, or null when it returns none. */
  get<T extends object = SqlRow>(sql: string, params?: SqlParams): T | null;
}

/**
 * The write half of the contract (M7.3): the user DB (src/data/user-db.ts — saved trips, settings)
 * is the one database the app writes. Same twins, same synchronous rule:
 *   - on the phone, expo-sqlite's `runSync` / `execSync` → src/data/expo-sql-executor.ts
 *   - on the Mac, node:sqlite's `run` / `exec`           → scripts/lib/node-sql-executor.ts
 * The schedule DB is only ever read, so its code keeps taking the read-only `SqlExecutor`.
 */
export interface WritableSqlExecutor extends SqlExecutor {
  /** Execute one statement that returns no rows (INSERT / UPDATE / DELETE); the number of rows it changed. */
  run(sql: string, params?: SqlParams): number;
  /** Execute SQL text that may hold several statements (a migration's DDL, PRAGMAs). Takes no parameters. */
  exec(sql: string): void;
  /** Run `work` inside BEGIN … COMMIT and return its result; a throw rolls back and is rethrown. Never nested. */
  transaction<T>(work: () => T): T;
}
