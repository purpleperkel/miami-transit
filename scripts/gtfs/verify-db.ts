import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { LINE_CATALOG } from '../../src/domain/lines/line-catalog';
import { MAX_TERMINAL_OVERHANG_M } from '../../src/domain/schedule/shape-geometry';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { NodeSqlExecutor, sqlResult } from '../lib/node-sql-executor';
import { REPO_PATHS } from './paths';
import { columnsOf, declaredType, MODE_CODES, SCHEMA_VERSION, TABLE_NAMES, TABLES, type ColumnKind } from './schema';

/**
 * Plan §4 step 14 (M2.16): check a schedule DB before anything trusts it. The build runs this on
 * the new DB before it is installed; `npx tsx scripts/gtfs/verify-db.ts [db]` runs it on any file
 * (default assets/db/schedule.db) and exits 1 naming the first check that fails.
 *
 * The checks, in order (structure first, so a damaged file fails on the check that names the damage):
 * size < 6 MB · integrity_check · user_version · journal_mode · tables · catalog · references ·
 * ≥ 2 stop times per trip · monotone times · trips follow their pattern · stop distances ·
 * shape extension per end · service days. A SQLite error while checking (a corrupted page, "file is not a
 * database") fails the check that hit it.
 */

/** Plan §4: the bundled DB is ~2 MB; the build fails at 6 MB. */
export const MAX_DB_BYTES = 6_000_000;

type Check = (db: NodeSqlExecutor) => string | null;

const CHECKS = [
  ['integrity_check', integrityCheck],
  ['user_version = 1', userVersion],
  ['journal_mode = delete', journalMode],
  ['tables', tablesMatchSchema],
  ['every line is in the catalog', linesMatchCatalog],
  ['references', referencesResolve],
  ['every trip has ≥ 2 stop times', tripsHaveStopTimes],
  ['times are monotone', timesAreMonotone],
  ['trips follow their pattern', tripsFollowPatterns],
  ['stop distances', stopDistances],
  [`shape extension ≤ ${MAX_TERMINAL_OVERHANG_M} m per end`, shapeExtensions],
  ['service days', serviceDays],
] as const satisfies readonly (readonly [string, Check])[];

export type CheckName = 'open' | 'size < 6 MB' | (typeof CHECKS)[number][0];
export type VerifyError = { readonly kind: 'verify'; readonly check: CheckName; readonly message: string };
export type VerifySummary = { readonly path: string; readonly bytes: number; readonly checks: readonly CheckName[] };

export function verifyScheduleDb(path: string): Result<VerifySummary, VerifyError> {
  invariant(path.length > 0, 'verify-db checks a file');
  if (!existsSync(path)) {
    return err(failure('open', path, 'no such file'));
  }
  const bytes = statSync(path).size;
  if (bytes >= MAX_DB_BYTES) {
    return err(failure('size < 6 MB', path, `${bytes} bytes; the limit is ${MAX_DB_BYTES}`));
  }
  const opened = NodeSqlExecutor.open(path, 'read-only');
  if (!opened.ok) {
    return err(failure('open', path, opened.error.message));
  }
  try {
    for (const [name, check] of CHECKS) {
      const outcome = sqlResult(path, () => check(opened.value));
      const problem = outcome.ok ? outcome.value : outcome.error.message;
      if (problem !== null) {
        return err(failure(name, path, problem));
      }
    }
  } finally {
    opened.value.close();
  }
  const checks: CheckName[] = ['size < 6 MB', ...CHECKS.map(([name]) => name)];
  invariant(checks.length === CHECKS.length + 1, 'every check ran');
  return ok({ path, bytes, checks });
}

function failure(check: CheckName, path: string, problem: string): VerifyError {
  invariant(problem.length > 0, 'a failed check says what is wrong');
  const error: VerifyError = { kind: 'verify', check, message: `verify-db: FAIL [${check}] ${problem} (${path})` };
  invariant(error.message.includes(check), 'the message names the check');
  return error;
}

/** The first row a problem query returns, described by `describe`, or null when it returns none. */
function firstProblem<T extends object>(db: NodeSqlExecutor, sql: string, describe: (row: T) => string): string | null {
  invariant(/\bLIMIT 1\s*$/.test(sql), 'problem queries stop at the first offender');
  const row = db.get<T>(sql);
  const problem = row === null ? null : describe(row);
  invariant(problem === null || problem.length > 0, 'a problem is described');
  return problem;
}

function integrityCheck(db: NodeSqlExecutor): string | null {
  const results = db.all<{ integrity_check: string }>('PRAGMA integrity_check').map((row) => row.integrity_check);
  invariant(results.length >= 1, 'integrity_check always reports');
  const fine = results.length === 1 && results[0] === 'ok';
  invariant(fine || results.length > 0, 'a failure is reported in rows');
  return fine ? null : results.slice(0, 3).join('; ');
}

function userVersion(db: NodeSqlExecutor): string | null {
  const version = db.value('PRAGMA user_version');
  invariant(typeof version === 'number', 'user_version is a number');
  invariant(SCHEMA_VERSION >= 1, 'the schema is versioned');
  return version === SCHEMA_VERSION ? null : `user_version is ${version}, want ${SCHEMA_VERSION}`;
}

/** The bundled file must be self-contained: legacy (DELETE) journaling, never WAL with a sidecar. */
function journalMode(db: NodeSqlExecutor): string | null {
  const mode = db.value('PRAGMA journal_mode');
  invariant(typeof mode === 'string', 'journal_mode is a name');
  invariant(mode.length > 0, 'journal_mode is never empty');
  return mode === 'delete' ? null : `journal_mode is ${mode}, want delete`;
}

/** All 15 plan §4 tables, each with exactly the schema's columns, in order, of the declared types. */
function tablesMatchSchema(db: NodeSqlExecutor): string | null {
  invariant(TABLE_NAMES.length === 15, 'the plan §4 schema has 15 tables');
  for (const table of TABLE_NAMES) {
    const actual = db.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`).map((c) => `${c.name} ${c.type}`);
    const kinds: Readonly<Record<string, ColumnKind>> = TABLES[table];
    const wanted = columnsOf(table).map((column) => `${column} ${declaredType(kinds[column] ?? 'text')}`);
    if (actual.length === 0) {
      return `table ${table} is missing`;
    }
    if (actual.join(', ') !== wanted.join(', ')) {
      return `table ${table} has columns (${actual.join(', ')}), want (${wanted.join(', ')})`;
    }
  }
  invariant(TABLE_NAMES.includes('trip') && columnsOf('trip').includes('next_trip_idx'), 'trip.next_trip_idx is checked');
  return null;
}

/** The line table is exactly the catalog, and every pattern and drawn shape names a catalog line. */
function linesMatchCatalog(db: NodeSqlExecutor): string | null {
  invariant(LINE_CATALOG.length > 0, 'the catalog defines lines');
  const lines = db.all<{ line_id: string; mode: number; name: string }>('SELECT line_id, mode, name FROM line ORDER BY sort');
  const actual = lines.map((line) => `${line.line_id}/${line.mode}/${line.name}`).join(', ');
  const wanted = LINE_CATALOG.map((line) => `${line.id}/${MODE_CODES[line.mode]}/${line.name}`).join(', ');
  if (actual !== wanted) {
    return `the line table is (${actual}), the catalog is (${wanted})`;
  }
  const unknown = `SELECT 'pattern ' || pattern_idx AS what, line_id FROM pattern WHERE line_id NOT IN (SELECT line_id FROM line)
    UNION ALL SELECT 'line_shape row', line_id FROM line_shape WHERE line_id NOT IN (SELECT line_id FROM line) LIMIT 1`;
  const problem = firstProblem<{ what: string; line_id: string }>(db, unknown, (r) => `${r.what} is on line ${r.line_id}, which the catalog lacks`);
  invariant(problem === null || problem.includes('catalog'), 'a catalog problem names the catalog');
  return problem;
}

/** child.column → parent.key for every *_idx (NULL next_trip_idx means "the ride ends"). */
const REFERENCES: readonly (readonly [string, string, string, string])[] = [
  ['stop', 'station_idx', 'station', 'station_idx'],
  ['shape_point', 'shape_idx', 'shape', 'shape_idx'],
  ['line_shape', 'shape_idx', 'shape', 'shape_idx'],
  ['pattern', 'shape_idx', 'shape', 'shape_idx'],
  ['pattern', 'dest_station_idx', 'station', 'station_idx'],
  ['pattern_stop', 'pattern_idx', 'pattern', 'pattern_idx'],
  ['pattern_stop', 'stop_idx', 'stop', 'stop_idx'],
  ['service_day_active', 'date', 'service_day', 'date'],
  ['service_day_active', 'service_idx', 'service', 'service_idx'],
  ['trip', 'service_idx', 'service', 'service_idx'],
  ['trip', 'pattern_idx', 'pattern', 'pattern_idx'],
  ['trip', 'next_trip_idx', 'trip', 'trip_idx'],
  ['stop_time', 'trip_idx', 'trip', 'trip_idx'],
  ['stop_time', 'stop_idx', 'stop', 'stop_idx'],
  ['transfer', 'from_station_idx', 'station', 'station_idx'],
  ['transfer', 'to_station_idx', 'station', 'station_idx'],
];

function referencesResolve(db: NodeSqlExecutor): string | null {
  invariant(REFERENCES.length > 0, 'there are references to check');
  for (const [child, column, parent, key] of REFERENCES) {
    const sql = `SELECT c.${column} AS value FROM ${child} c WHERE c.${column} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${key} = c.${column}) LIMIT 1`;
    const problem = firstProblem<{ value: number }>(db, sql, (r) => `${child}.${column} = ${r.value} names no ${parent}.${key}`);
    if (problem !== null) {
      return problem;
    }
  }
  invariant(REFERENCES.every(([child]) => (TABLE_NAMES as readonly string[]).includes(child)), 'references name schema tables');
  return null;
}

function tripsHaveStopTimes(db: NodeSqlExecutor): string | null {
  const trips = db.value('SELECT count(*) FROM trip');
  invariant(typeof trips === 'number', 'a count is a number');
  if (trips === 0) {
    return 'the DB has no trips';
  }
  const sql = `SELECT t.trip_id, count(s.seq) AS n FROM trip t LEFT JOIN stop_time s ON s.trip_idx = t.trip_idx
    GROUP BY t.trip_idx HAVING n < 2 ORDER BY t.trip_idx LIMIT 1`;
  const problem = firstProblem<{ trip_id: string; n: number }>(db, sql, (r) => `trip ${r.trip_id} has ${r.n} stop time(s)`);
  invariant(problem === null || problem.includes('stop time'), 'the problem names the stop times');
  return problem;
}

/** At every stop: arrive no later than depart, and arrive no earlier than the previous departure. */
function timesAreMonotone(db: NodeSqlExecutor): string | null {
  const sql = `SELECT t.trip_id, s.seq, s.arr_s, s.dep_s, s.prev_dep FROM (
      SELECT trip_idx, seq, arr_s, dep_s, lag(dep_s) OVER (PARTITION BY trip_idx ORDER BY seq) AS prev_dep FROM stop_time
    ) s JOIN trip t ON t.trip_idx = s.trip_idx
    WHERE s.dep_s < s.arr_s OR s.arr_s < s.prev_dep ORDER BY s.trip_idx, s.seq LIMIT 1`;
  type Row = { trip_id: string; seq: number; arr_s: number; dep_s: number; prev_dep: number | null };
  const problem = firstProblem<Row>(db, sql, (r) =>
    r.dep_s < r.arr_s
      ? `trip ${r.trip_id} stop ${r.seq} departs (${r.dep_s} s) before it arrives (${r.arr_s} s)`
      : `trip ${r.trip_id} stop ${r.seq} arrives (${r.arr_s} s) before it left the previous stop (${String(r.prev_dep)} s)`,
  );
  invariant(problem === null || problem.startsWith('trip '), 'the problem names the trip');
  invariant(sql.includes('lag(dep_s)'), 'times are compared with the previous stop');
  return problem;
}

/** Each trip's stop times are its pattern's stops, numbered 0.., and its start/end are its first/last times. */
function tripsFollowPatterns(db: NodeSqlExecutor): string | null {
  const queries: readonly (readonly [string, (r: { trip_id: string }) => string])[] = [
    [
      `SELECT t.trip_id FROM trip t JOIN pattern p ON p.pattern_idx = t.pattern_idx
        WHERE p.stop_count != (SELECT count(*) FROM stop_time s WHERE s.trip_idx = t.trip_idx)
           OR (SELECT max(seq) FROM stop_time s WHERE s.trip_idx = t.trip_idx) != p.stop_count - 1 LIMIT 1`,
      (r) => `trip ${r.trip_id} does not have its pattern's stop count, numbered 0..n-1`,
    ],
    [
      `SELECT t.trip_id FROM stop_time s JOIN trip t ON t.trip_idx = s.trip_idx
        LEFT JOIN pattern_stop ps ON ps.pattern_idx = t.pattern_idx AND ps.seq = s.seq
        WHERE ps.stop_idx IS NULL OR ps.stop_idx != s.stop_idx LIMIT 1`,
      (r) => `trip ${r.trip_id} stops somewhere its pattern does not`,
    ],
    [
      `SELECT t.trip_id FROM trip t
        WHERE t.start_s != (SELECT dep_s FROM stop_time s WHERE s.trip_idx = t.trip_idx ORDER BY seq LIMIT 1)
           OR t.end_s != (SELECT arr_s FROM stop_time s WHERE s.trip_idx = t.trip_idx ORDER BY seq DESC LIMIT 1) LIMIT 1`,
      (r) => `trip ${r.trip_id} start_s/end_s are not its first departure and last arrival`,
    ],
  ];
  invariant(queries.length === 3, 'stop count, stops, and span');
  const problem = queries.map(([sql, describe]) => firstProblem(db, sql, describe)).find((p) => p !== null) ?? null;
  invariant(problem === null || problem.startsWith('trip '), 'the problem names the trip');
  return problem;
}

/** Shape points start at 0 and climb to length_m; pattern stops climb along their shape within [0, length_m]. */
function stopDistances(db: NodeSqlExecutor): string | null {
  const shapes = `SELECT sh.shape_id AS what FROM shape sh WHERE
      (SELECT dist_m FROM shape_point WHERE shape_idx = sh.shape_idx ORDER BY seq LIMIT 1) != 0
      OR abs((SELECT dist_m FROM shape_point WHERE shape_idx = sh.shape_idx ORDER BY seq DESC LIMIT 1) - sh.length_m) > 1e-6
      OR EXISTS (SELECT 1 FROM (SELECT dist_m, lag(dist_m) OVER (ORDER BY seq) AS prev FROM shape_point WHERE shape_idx = sh.shape_idx) WHERE dist_m < prev)
    LIMIT 1`;
  const stops = `SELECT 'pattern ' || s.pattern_idx || ' stop ' || s.seq AS what FROM (
      SELECT ps.pattern_idx, ps.seq, ps.dist_m, sh.length_m, lag(ps.dist_m) OVER (PARTITION BY ps.pattern_idx ORDER BY ps.seq) AS prev
      FROM pattern_stop ps JOIN pattern p ON p.pattern_idx = ps.pattern_idx JOIN shape sh ON sh.shape_idx = p.shape_idx
    ) s WHERE s.dist_m < 0 OR s.dist_m > s.length_m OR s.dist_m < s.prev LIMIT 1`;
  const problem =
    firstProblem<{ what: string }>(db, shapes, (r) => `shape ${r.what}: point distances do not run 0 → length_m`) ??
    firstProblem<{ what: string }>(db, stops, (r) => `${r.what}: distance is off its shape or goes backwards`);
  invariant(problem === null || problem.length > 0, 'a distance problem is described');
  invariant(shapes.includes('length_m') && stops.includes('length_m'), 'distances are bounded by the shape length');
  return problem;
}

/** The M2.11 ruling, checked at EACH end: neither end of a shape was extended more than MAX_TERMINAL_OVERHANG_M. */
function shapeExtensions(db: NodeSqlExecutor): string | null {
  invariant(MAX_TERMINAL_OVERHANG_M === 150, 'the ruling caps a terminal extension at 150 m');
  const max = MAX_TERMINAL_OVERHANG_M;
  const sql = `SELECT shape_id, 'start' AS end_name, extended_start_m AS metres FROM shape WHERE extended_start_m NOT BETWEEN 0 AND ${max}
    UNION ALL SELECT shape_id, 'end', extended_end_m FROM shape WHERE extended_end_m NOT BETWEEN 0 AND ${max} LIMIT 1`;
  const problem = firstProblem<{ shape_id: string; end_name: string; metres: number }>(
    db,
    sql,
    (r) => `shape ${r.shape_id} was extended ${r.metres.toFixed(1)} m at its ${r.end_name} (max ${max} m per end)`,
  );
  invariant(problem === null || problem.startsWith('shape '), 'the problem names the shape');
  return problem;
}

/** Service days exist, their base epochs climb by a day (23–25 h), and every service runs on some day. */
function serviceDays(db: NodeSqlExecutor): string | null {
  const days = db.value('SELECT count(*) FROM service_day');
  invariant(typeof days === 'number', 'a count is a number');
  if (days === 0) {
    return 'the DB has no service days';
  }
  const steps = `SELECT date AS what FROM (SELECT date, base_epoch - lag(base_epoch) OVER (ORDER BY date) AS step FROM service_day)
    WHERE step NOT BETWEEN 82800 AND 90000 LIMIT 1`;
  const idle = `SELECT 'service ' || service_id AS what FROM service s
    WHERE NOT EXISTS (SELECT 1 FROM service_day_active a WHERE a.service_idx = s.service_idx) LIMIT 1`;
  const problem =
    firstProblem<{ what: string }>(db, steps, (r) => `service day ${r.what} does not start one day after the previous one`) ??
    firstProblem<{ what: string }>(db, idle, (r) => `${r.what} runs on no service day`);
  invariant(problem === null || problem.length > 0, 'a service-day problem is described');
  return problem;
}

/** CLI: `npx tsx scripts/gtfs/verify-db.ts [path]` — exit 0 when every check passes, 1 naming the first failure. */
function main(argv: readonly string[]): number {
  invariant(Array.isArray(argv), 'the CLI reads its arguments');
  if (argv.length > 1) {
    console.error('usage: tsx scripts/gtfs/verify-db.ts [path/to/schedule.db]');
    return 2;
  }
  const path = resolve(argv[0] ?? REPO_PATHS.scheduleDb);
  const result = verifyScheduleDb(path);
  if (!result.ok) {
    console.error(result.error.message);
    return 1;
  }
  console.log(`verify-db: OK ${path} (${result.value.bytes} bytes) — ${result.value.checks.length} checks passed: ${result.value.checks.join(' · ')}`);
  invariant(result.value.checks.length === CHECKS.length + 1, 'every check is reported');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
