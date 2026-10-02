import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import type { SqlParams, SqlRow, SqlValue, WritableSqlExecutor } from '../../src/data/sql-executor';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';

/**
 * The Mac-side SQL executor (plan §4 "src/data … sql-executor (expo + node impls)", M2.15): a thin,
 * checked wrapper over Node's built-in `node:sqlite`, used by the GTFS pipeline — the writer, the
 * verifier, the manifest and the report — and by their tests.
 *
 * It lives in scripts/lib and NEVER under src/: `node:sqlite` is a Node built-in Metro cannot
 * bundle, so no module the app imports may reach it. It implements the platform-neutral
 * `SqlExecutor` contract (src/data/sql-executor.ts, M3.1) — the same interface its on-device twin,
 * src/data/expo-sql-executor.ts, implements over expo-sqlite — so the schedule engine's node:test
 * suites query the real schedule DB through exactly the code the phone runs.
 *
 * Every method states its contract with invariants. SQLite failures (a missing file, "file is not
 * a database", a malformed page) are thrown by node:sqlite as Errors with code ERR_SQLITE_ERROR;
 * `sqlResult` turns exactly those into an Err for callers that expect damaged input (verify-db),
 * and rethrows anything else.
 */

/** The value, parameter and row types are the contract's (src/data/sql-executor.ts), re-exported for the pipeline. */
export type { SqlParams, SqlRow, SqlValue };

export type SqlError = { readonly kind: 'sqlite'; readonly path: string; readonly message: string };

export type OpenMode = 'read-only' | 'read-write';

/** The `path` an in-memory executor reports (SQLite's own spelling for "no file"). */
const IN_MEMORY = ':memory:';

export class NodeSqlExecutor implements WritableSqlExecutor {
  private readonly db: DatabaseSync;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string) {
    invariant(db.isOpen, 'an executor wraps an open database');
    invariant(path.length > 0, 'an executor knows its file');
    this.db = db;
    this.path = path;
  }

  /** Open (read-write creates the file) — an unopenable file is an Err, not a throw. */
  static open(path: string, mode: OpenMode): Result<NodeSqlExecutor, SqlError> {
    invariant(path.length > 0 && path !== ':memory:', 'the pipeline executor opens a file');
    invariant(mode === 'read-only' || mode === 'read-write', 'an open mode is named');
    return sqlResult(path, () => new NodeSqlExecutor(new DatabaseSync(path, { readOnly: mode === 'read-only' }), path));
  }

  /**
   * A fresh, empty, read-write in-memory database (M7.3's user-DB suite). It is a separate,
   * explicit constructor so `open` keeps refusing ':memory:' — a pipeline step handed that path by
   * mistake would otherwise "succeed" and lose everything it wrote.
   */
  static inMemory(): NodeSqlExecutor {
    const executor = new NodeSqlExecutor(new DatabaseSync(':memory:'), IN_MEMORY);
    invariant(executor.db.location() === null, 'an in-memory database has no file');
    invariant(executor.path === IN_MEMORY, 'the executor names itself in-memory');
    return executor;
  }

  /** Every row of a query (column names → values), in the order SQLite returns them. */
  all<T extends object = SqlRow>(sql: string, params: SqlParams = []): T[] {
    invariant(this.db.isOpen, `${this.path} is open`);
    invariant(sql.trim().length > 0, 'a query has SQL');
    return bind(this.db.prepare(sql), params, (statement, named, anonymous) => statement.all(named, ...anonymous)) as T[];
  }

  /** The first row of a query, or null when it returns none. */
  get<T extends object = SqlRow>(sql: string, params: SqlParams = []): T | null {
    invariant(this.db.isOpen, `${this.path} is open`);
    invariant(sql.trim().length > 0, 'a query has SQL');
    const row = bind(this.db.prepare(sql), params, (statement, named, anonymous) => statement.get(named, ...anonymous));
    return (row ?? null) as T | null;
  }

  /** The single value a one-column query returns (e.g. `PRAGMA user_version`, `SELECT count(*)`). */
  value(sql: string, params: SqlParams = []): SqlValue {
    const row = this.get(sql, params);
    invariant(row !== null, `"${sql}" returned a row`);
    const values = Object.values(row);
    invariant(values.length === 1, `"${sql}" returns exactly one column`);
    return values[0] ?? null;
  }

  /** Execute one statement that returns nothing; the number of rows it changed. */
  run(sql: string, params: SqlParams = []): number {
    invariant(this.db.isOpen, `${this.path} is open`);
    const { changes } = bind(this.db.prepare(sql), params, (statement, named, anonymous) => statement.run(named, ...anonymous));
    invariant(typeof changes === 'number' && changes >= 0, 'changes is a row count');
    return changes;
  }

  /** Execute SQL text that may hold several statements (DDL, PRAGMAs, BEGIN/COMMIT, VACUUM). */
  exec(sql: string): void {
    invariant(this.db.isOpen, `${this.path} is open`);
    invariant(sql.trim().length > 0, 'exec runs SQL');
    this.db.exec(sql);
  }

  /** One prepared INSERT run once per row (named parameters); every run must insert exactly one row. */
  insertAll(sql: string, rows: readonly Readonly<Record<string, SqlValue>>[]): number {
    invariant(this.db.isOpen, `${this.path} is open`);
    invariant(/^\s*INSERT\b/i.test(sql), 'insertAll runs an INSERT');
    const statement = this.db.prepare(sql);
    for (const row of rows) {
      const { changes } = statement.run(row as Record<string, SQLInputValue>);
      invariant(changes === 1, `one row inserted by ${sql.slice(0, 40)}…`);
    }
    return rows.length;
  }

  /** Run `work` inside BEGIN … COMMIT; any throw rolls the transaction back and is rethrown. */
  transaction<T>(work: () => T): T {
    invariant(this.db.isOpen, `${this.path} is open`);
    invariant(!this.db.isTransaction, 'transactions do not nest');
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw error;
    }
  }

  close(): void {
    invariant(this.db.isOpen, `${this.path} is closed once`);
    invariant(!this.db.isTransaction, 'no transaction is left open at close');
    this.db.close();
  }
}

/** Run a SQLite step; ERR_SQLITE_ERROR becomes an Err naming the file, every other throw is rethrown. */
export function sqlResult<T>(path: string, step: () => T): Result<T, SqlError> {
  invariant(path.length > 0, 'a SQLite step names its file');
  invariant(typeof step === 'function', 'a SQLite step is a function');
  try {
    return ok(step());
  } catch (error) {
    if (!isSqliteError(error)) {
      throw error;
    }
    return err({ kind: 'sqlite', path, message: `${path}: ${error.message}` });
  }
}

function isSqliteError(error: unknown): error is Error {
  const coded = error instanceof Error && (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR';
  invariant(!coded || error instanceof Error, 'a SQLite error is an Error');
  invariant(!coded || (error as Error).message.length > 0, 'a SQLite error explains itself');
  return coded;
}

type Call<R> = (statement: StatementSync, named: Record<string, SQLInputValue>, anonymous: SQLInputValue[]) => R;

/** Bind `params` the way node:sqlite takes them: a named-parameter object, then anonymous values. */
function bind<R>(statement: StatementSync, params: SqlParams, call: Call<R>): R {
  invariant(statement.sourceSQL.length > 0, 'a prepared statement has SQL');
  const anonymous = Array.isArray(params);
  invariant(anonymous || (typeof params === 'object' && params !== null), 'parameters are a list or an object');
  return anonymous ? call(statement, {}, [...(params as readonly SqlValue[])]) : call(statement, { ...params } as Record<string, SQLInputValue>, []);
}
