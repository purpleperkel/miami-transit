import type { SQLiteDatabase } from 'expo-sqlite';

import { InvariantError } from '../../lib/invariant';
import { ExpoSqlExecutor, toExpoParams } from '../expo-sql-executor';

/**
 * M3.1 / M7.3: the on-device executor's binding and delegation, for reads and writes.
 * expo-sqlite's native module cannot load under jest, and there is no simulator on this Mac, so
 * the database below is a stand-in; the real expo-sqlite path is exercised on the phone.
 */

type Method = 'getAllSync' | 'getFirstSync' | 'runSync' | 'execSync';
type Call = { readonly method: Method; readonly sql: string; readonly params?: unknown };

/**
 * test-time mock of native module: an expo-sqlite SQLiteDatabase stand-in that records each call.
 * `execSync` tracks BEGIN / COMMIT / ROLLBACK so `isInTransactionSync` answers like the real one.
 */
function recordingDatabase(rows: readonly object[], changes = 1): { db: SQLiteDatabase; calls: Call[] } {
  expect(Array.isArray(rows)).toBe(true);
  const calls: Call[] = [];
  let inTransaction = false;
  const db = {
    databasePath: '/data/SQLite/schedule-abc.db',
    getAllSync: (sql: string, params: unknown) => {
      calls.push({ method: 'getAllSync', sql, params });
      return [...rows];
    },
    getFirstSync: (sql: string, params: unknown) => {
      calls.push({ method: 'getFirstSync', sql, params });
      return rows[0] ?? null;
    },
    runSync: (sql: string, params: unknown) => {
      calls.push({ method: 'runSync', sql, params });
      return { changes, lastInsertRowId: 0 };
    },
    execSync: (sql: string) => {
      calls.push({ method: 'execSync', sql });
      inTransaction = sql === 'BEGIN' ? true : sql === 'COMMIT' || sql === 'ROLLBACK' ? false : inTransaction;
    },
    isInTransactionSync: () => inTransaction,
  } as unknown as SQLiteDatabase;
  expect(calls).toHaveLength(0);
  return { db, calls };
}

describe('expo-sqlite executor (M3.1)', () => {
  it('named parameters gain the ":" prefix sqlite3_bind_parameter_index needs; lists bind in order', () => {
    expect(toExpoParams({ station_key: 'rail:government-ctr', date: 20260930 })).toEqual({ ':station_key': 'rail:government-ctr', ':date': 20260930 });
    expect(toExpoParams(['a', 2, null])).toEqual(['a', 2, null]);
    expect(toExpoParams([])).toEqual([]);
  });

  it('a name already carrying a prefix is a caller error, not a silent mis-bind', () => {
    expect(() => toExpoParams({ ':date': 1 })).toThrow(InvariantError);
    expect(() => toExpoParams({ $date: 1 })).toThrow(/bare name/);
  });

  it('all() and get() run the SQL through getAllSync / getFirstSync with the converted parameters', () => {
    const { db, calls } = recordingDatabase([{ value: 'abc' }]);
    const executor = new ExpoSqlExecutor(db);
    expect(executor.all('SELECT value FROM meta WHERE key = :key', { key: 'feed_sha256' })).toEqual([{ value: 'abc' }]);
    expect(executor.get('SELECT value FROM meta WHERE key = ?', ['feed_sha256'])).toEqual({ value: 'abc' });
    expect(calls).toEqual([
      { method: 'getAllSync', sql: 'SELECT value FROM meta WHERE key = :key', params: { ':key': 'feed_sha256' } },
      { method: 'getFirstSync', sql: 'SELECT value FROM meta WHERE key = ?', params: ['feed_sha256'] },
    ]);
  });

  it('get() passes "no row" through as null', () => {
    const { db } = recordingDatabase([]);
    expect(new ExpoSqlExecutor(db).get('SELECT 1 WHERE 0')).toBeNull();
    expect(new ExpoSqlExecutor(db).all('SELECT 1 WHERE 0')).toEqual([]);
  });
});

describe('expo-sqlite executor, the write half (M7.3)', () => {
  it('user DB writes go through runSync with the converted parameters', () => {
    const { db, calls } = recordingDatabase([], 2);
    const executor = new ExpoSqlExecutor(db);
    expect(executor.run('UPDATE setting SET value = :value WHERE key = :key', { key: 'boardBufferS', value: 90 })).toBe(2);
    expect(executor.run('DELETE FROM saved_trip WHERE trip_id = ?', ['work'])).toBe(2);
    expect(calls).toEqual([
      { method: 'runSync', sql: 'UPDATE setting SET value = :value WHERE key = :key', params: { ':key': 'boardBufferS', ':value': 90 } },
      { method: 'runSync', sql: 'DELETE FROM saved_trip WHERE trip_id = ?', params: ['work'] },
    ]);
  });

  it('migration DDL goes through execSync, and a transaction commits around its work', () => {
    const { db, calls } = recordingDatabase([]);
    const executor = new ExpoSqlExecutor(db);
    executor.exec('CREATE TABLE t(x INTEGER)');
    expect(executor.transaction(() => executor.run('INSERT INTO t VALUES (?)', [1]))).toBe(1);
    expect(calls.map((c) => `${c.method} ${c.sql}`)).toEqual([
      'execSync CREATE TABLE t(x INTEGER)',
      'execSync BEGIN',
      'runSync INSERT INTO t VALUES (?)',
      'execSync COMMIT',
    ]);
    expect(db.isInTransactionSync()).toBe(false);
  });

  it('a transaction whose work throws rolls back and rethrows the same error', () => {
    const { db, calls } = recordingDatabase([]);
    const executor = new ExpoSqlExecutor(db);
    const failure = new Error('constraint failed');
    expect(() =>
      executor.transaction(() => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(db.isInTransactionSync()).toBe(false);
  });

  it('transactions do not nest', () => {
    const { db } = recordingDatabase([]);
    const executor = new ExpoSqlExecutor(db);
    expect(() => executor.transaction(() => executor.transaction(() => 1))).toThrow(/do not nest/);
    expect(db.isInTransactionSync()).toBe(false);
  });
});
