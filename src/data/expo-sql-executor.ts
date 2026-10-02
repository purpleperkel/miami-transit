import type { SQLiteBindParams, SQLiteDatabase } from 'expo-sqlite';

import { invariant } from '../lib/invariant';
import type { SqlParams, SqlRow, SqlValue, WritableSqlExecutor } from './sql-executor';

/**
 * The on-device SQL executor (M3.1): the SqlExecutor contract over an open expo-sqlite database,
 * using its synchronous API (`getAllSync` / `getFirstSync`, expo-sqlite 57). It is the twin of the
 * Mac's scripts/lib/node-sql-executor.ts; the schedule engine cannot tell them apart.
 *
 * It also carries the write half (`WritableSqlExecutor`, M7.3) over `runSync` / `execSync`, for the
 * user DB (saved trips, settings). The read-only schedule DB never calls it; the write methods
 * check, when called, that the wrapped database can write.
 *
 * It wraps a database the caller has opened — the schedule-DB provider (M3.8) imports the bundled
 * asset and opens it — and leaves the connection's lifetime to that owner. Only expo-sqlite's
 * TYPES are imported here, so loading this module never loads the native module.
 *
 * Binding: the contract passes named parameters by BARE name for `:name` placeholders; expo-sqlite
 * resolves each object key with `sqlite3_bind_parameter_index` (expo-sqlite 57
 * ios/SQLiteModule.swift `getBindParamIndex`), which needs the placeholder's full spelling, so
 * `toExpoParams` adds the `:` prefix. Lists bind in order, unchanged.
 */

/** A bare SQL parameter name (no `:` / `@` / `$` prefix). */
const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ExpoSqlExecutor implements WritableSqlExecutor {
  private readonly db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    invariant(typeof db.getAllSync === 'function' && typeof db.getFirstSync === 'function', 'the executor wraps an expo-sqlite database');
    invariant(db.databasePath.length > 0, 'the wrapped database is opened on a file');
    this.db = db;
  }

  all<T extends object = SqlRow>(sql: string, params: SqlParams = []): T[] {
    invariant(sql.trim().length > 0, 'a query has SQL');
    const rows = this.db.getAllSync<T>(sql, toExpoParams(params));
    invariant(Array.isArray(rows), 'getAllSync returns a row list');
    return rows;
  }

  get<T extends object = SqlRow>(sql: string, params: SqlParams = []): T | null {
    invariant(sql.trim().length > 0, 'a query has SQL');
    const row = this.db.getFirstSync<T>(sql, toExpoParams(params));
    invariant(row === null || typeof row === 'object', 'getFirstSync returns a row or null');
    return row;
  }

  run(sql: string, params: SqlParams = []): number {
    invariant(sql.trim().length > 0, 'a statement has SQL');
    invariant(typeof this.db.runSync === 'function', 'the wrapped database can write (runSync)');
    const { changes } = this.db.runSync(sql, toExpoParams(params));
    invariant(Number.isSafeInteger(changes) && changes >= 0, 'runSync reports a row count');
    return changes;
  }

  exec(sql: string): void {
    invariant(sql.trim().length > 0, 'exec runs SQL');
    invariant(typeof this.db.execSync === 'function', 'the wrapped database can write (execSync)');
    this.db.execSync(sql);
  }

  /** BEGIN … COMMIT through execSync, like the Mac twin: a throw rolls back (if still open) and is rethrown. */
  transaction<T>(work: () => T): T {
    invariant(typeof work === 'function', 'a transaction runs a function');
    invariant(!this.db.isInTransactionSync(), 'transactions do not nest');
    this.db.execSync('BEGIN');
    try {
      const result = work();
      this.db.execSync('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isInTransactionSync()) {
        this.db.execSync('ROLLBACK');
      }
      throw error;
    }
  }
}

/** The contract's parameters in expo-sqlite's binding form: lists in order; names gain their `:` prefix. */
export function toExpoParams(params: SqlParams): SQLiteBindParams {
  invariant(typeof params === 'object' && params !== null, 'parameters are a list or an object');
  if (isParamList(params)) {
    return [...params];
  }
  const named: Record<string, SqlValue> = {};
  for (const [name, value] of Object.entries(params)) {
    invariant(BARE_NAME.test(name), `named parameter "${name}" must be passed by bare name (the SQL spells it :${name})`);
    named[`:${name}`] = value;
  }
  invariant(Object.keys(named).length === Object.keys(params).length, 'every named parameter is bound');
  return named;
}

function isParamList(params: SqlParams): params is readonly SqlValue[] {
  invariant(typeof params === 'object' && params !== null, 'parameters are a list or an object');
  const list = Array.isArray(params);
  invariant(list || Object.getPrototypeOf(params) === Object.prototype || Object.getPrototypeOf(params) === null, 'named parameters are a plain object');
  return list;
}
