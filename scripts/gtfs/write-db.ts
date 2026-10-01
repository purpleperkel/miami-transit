import { existsSync, renameSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { removeTemp, tempPathOf } from '../lib/atomic-file';
import { NodeSqlExecutor, sqlResult } from '../lib/node-sql-executor';
import { insertSql, SCHEMA_DDL, SCHEMA_VERSION, TABLE_NAMES, type ScheduleRows, type TableName } from './schema';

/**
 * Plan §4 step 13 (M2.15): write the schedule DB with node:sqlite.
 *
 *  1. A fresh `<db>.tmp` beside the destination (a leftover from a crashed run is removed first).
 *  2. journal_mode DELETE — one self-contained file, no WAL sidecar to lose when it is bundled.
 *  3. ONE transaction: the schema DDL, every table's rows (in the rows' fixed order), user_version 1.
 *  4. VACUUM (packed pages, no free list), then PRAGMA integrity_check must say "ok".
 *  5. The caller's check (the build passes verify-db) runs on the CLOSED temp file.
 *  6. Only then is the temp file renamed over the destination — rename(2) is atomic, so the
 *     destination is never half-written, and a DB that fails its checks never replaces a good one.
 *
 * Nothing written depends on a clock or on hash order: the same rows give the same bytes.
 */

export type WriteError = {
  readonly kind: 'write';
  readonly step: 'sqlite' | 'integrity_check' | 'check';
  readonly message: string;
};

export type WriteSummary = { readonly path: string; readonly rows: Readonly<Record<TableName, number>> };

/** A check of the finished temp file before it is renamed into place (the build runs verify-db). */
export type TempCheck = (tempPath: string) => Result<unknown, { readonly message: string }>;

export function writeScheduleDb(rows: ScheduleRows, destination: string, check: TempCheck | null = null): Result<WriteSummary, WriteError> {
  invariant(isAbsolute(destination), `the DB destination is an absolute path, got "${destination}"`);
  invariant(existsSync(dirname(destination)), `the DB directory ${dirname(destination)} exists`);
  const temp = tempPathOf(destination);
  removeTemp(temp);
  const filled = fillDatabase(rows, temp);
  if (!filled.ok) {
    removeTemp(temp);
    return filled;
  }
  const checked = check === null ? ok(null) : check(temp);
  if (!checked.ok) {
    removeTemp(temp);
    return err({ kind: 'write', step: 'check', message: `the new DB failed its check and was not installed: ${checked.error.message}` });
  }
  renameSync(temp, destination);
  invariant(!existsSync(temp) && existsSync(destination), 'the temp DB was renamed into place');
  return ok({ path: destination, rows: filled.value });
}

/** Steps 2–4 on the temp file; the connection is closed whatever happens. */
function fillDatabase(rows: ScheduleRows, temp: string): Result<Record<TableName, number>, WriteError> {
  invariant(!existsSync(temp), 'the temp DB starts from nothing');
  const opened = NodeSqlExecutor.open(temp, 'read-write');
  if (!opened.ok) {
    return err({ kind: 'write', step: 'sqlite', message: opened.error.message });
  }
  const db = opened.value;
  try {
    const written = sqlResult(temp, () => writeTables(db, rows));
    if (!written.ok) {
      return err({ kind: 'write', step: 'sqlite', message: written.error.message });
    }
    const integrity = db.value('PRAGMA integrity_check');
    if (integrity !== 'ok') {
      return err({ kind: 'write', step: 'integrity_check', message: `integrity_check on the new DB: ${String(integrity)}` });
    }
    invariant(db.value('PRAGMA user_version') === SCHEMA_VERSION, 'the schema version is stamped');
    return written;
  } finally {
    db.close();
  }
}

/** Schema + every row + user_version in one transaction, then VACUUM; the row count per table. */
function writeTables(db: NodeSqlExecutor, rows: ScheduleRows): Record<TableName, number> {
  invariant(TABLE_NAMES.length === 15, 'the plan §4 schema has 15 tables');
  invariant(TABLE_NAMES.every((table) => Array.isArray(rows[table])), 'there is a row list for every table');
  db.exec('PRAGMA journal_mode = DELETE');
  const counts = db.transaction(() => insertEverything(db, rows));
  db.exec('VACUUM');
  return counts;
}

/** Inside the one transaction: the DDL, each table's rows in TABLE_NAMES order, the schema version. */
function insertEverything(db: NodeSqlExecutor, rows: ScheduleRows): Record<TableName, number> {
  db.exec(SCHEMA_DDL);
  const inserted = Object.fromEntries(TABLE_NAMES.map((table) => [table, db.insertAll(insertSql(table), rows[table])]));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  invariant(TABLE_NAMES.every((table) => inserted[table] === rows[table].length), 'every row of every table was inserted');
  invariant(db.value('PRAGMA user_version') === SCHEMA_VERSION, 'the schema version is stamped inside the transaction');
  return inserted as Record<TableName, number>;
}
