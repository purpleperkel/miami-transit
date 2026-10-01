import type { SQLiteDatabase } from 'expo-sqlite';

import { InvariantError } from '../../lib/invariant';
import { ExpoSqlExecutor, toExpoParams } from '../expo-sql-executor';

/**
 * M3.1: the on-device executor's binding and delegation. expo-sqlite's native module cannot load
 * under jest, and there is no simulator on this Mac, so the database below is a stand-in; the
 * real expo-sqlite path is exercised on the phone.
 */

type Call = { readonly method: 'getAllSync' | 'getFirstSync'; readonly sql: string; readonly params: unknown };

/** test-time mock of native module: an expo-sqlite SQLiteDatabase stand-in that records each call. */
function recordingDatabase(rows: readonly object[]): { db: SQLiteDatabase; calls: Call[] } {
  expect(Array.isArray(rows)).toBe(true);
  const calls: Call[] = [];
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
