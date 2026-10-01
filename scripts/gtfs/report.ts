import { resolve } from 'node:path';

import { lineById } from '../../src/domain/lines/line-catalog';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { NodeSqlExecutor, sqlResult, type SqlError } from '../lib/node-sql-executor';
import { REPO_PATHS } from './paths';

/**
 * M2.20: the derivation report — `npx tsx scripts/gtfs/report.ts [db]` (default
 * assets/db/schedule.db). It reads the BUILT DB (not the feed) and prints every pattern with the
 * line it was derived to, then re-checks the derivation independently of derive-line.ts (plan risk
 * R9, "stop patterns define lines"):
 *  - every ORANGE pattern includes Miami International Airport (the Orange-only station);
 *  - every GREEN pattern includes a Green-only station (one of the Green branch's sentinels);
 *  - at least one airport shuttle (MIA ↔ Earlington Heights) exists.
 * Exit 0 when all hold, 1 naming the failed check.
 */

export type PatternSummary = {
  readonly pattern_idx: number;
  readonly line_id: string;
  readonly variant: string;
  readonly route_id: string;
  readonly direction_id: number;
  readonly shape_id: string;
  readonly extended_m: number;
  readonly stop_count: number;
  readonly trips: number;
  readonly first_station: string;
  readonly last_station: string;
};

export type ReportCheck = { readonly name: string; readonly ok: boolean; readonly detail: string };
export type Report = { readonly lines: readonly string[]; readonly checks: readonly ReportCheck[]; readonly ok: boolean };

const MIA = 'rail:miami-international-airport';

const PATTERNS_SQL = `SELECT p.pattern_idx, p.line_id, p.variant, p.route_id, p.direction_id, sh.shape_id, sh.extended_m, p.stop_count,
    (SELECT count(*) FROM trip t WHERE t.pattern_idx = p.pattern_idx) AS trips,
    (SELECT st.name FROM pattern_stop ps JOIN stop s ON s.stop_idx = ps.stop_idx JOIN station st ON st.station_idx = s.station_idx
      WHERE ps.pattern_idx = p.pattern_idx ORDER BY ps.seq LIMIT 1) AS first_station,
    (SELECT st.name FROM station st WHERE st.station_idx = p.dest_station_idx) AS last_station
  FROM pattern p JOIN shape sh ON sh.shape_idx = p.shape_idx
  JOIN line l ON l.line_id = p.line_id ORDER BY l.sort, p.pattern_idx`;

/** Patterns of `lineId` none of whose stations is in `stationKeys`. */
const MISSING_STATION_SQL = `SELECT p.pattern_idx FROM pattern p WHERE p.line_id = ? AND NOT EXISTS (
    SELECT 1 FROM pattern_stop ps JOIN stop s ON s.stop_idx = ps.stop_idx JOIN station st ON st.station_idx = s.station_idx
    WHERE ps.pattern_idx = p.pattern_idx AND st.station_key IN (SELECT value FROM json_each(?)))
  ORDER BY p.pattern_idx`;

export function buildReport(path: string): Result<Report, SqlError> {
  invariant(path.length > 0, 'the report reads a DB file');
  const opened = NodeSqlExecutor.open(path, 'read-only');
  if (!opened.ok) {
    return opened;
  }
  const read = sqlResult(path, () => {
    const patterns = opened.value.all<PatternSummary>(PATTERNS_SQL);
    return { patterns, checks: derivationChecks(opened.value, patterns) };
  });
  opened.value.close();
  if (!read.ok) {
    return err(read.error);
  }
  const { patterns, checks } = read.value;
  const lines = [`Derivation report — ${path}`, ...patternTable(patterns), 'checks:', ...checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)];
  invariant(lines.length >= patterns.length + checks.length, 'every pattern and check is printed');
  return ok({ lines, checks, ok: checks.every((check) => check.ok) });
}

/** The three R9 checks, each over the DB's own stations (not derive-line's logic). */
function derivationChecks(db: NodeSqlExecutor, patterns: readonly PatternSummary[]): ReportCheck[] {
  invariant(lineById('ORANGE').sentinels.includes(MIA), 'Miami International Airport is the Orange-only station');
  const shuttles = patterns.filter((p) => p.variant === 'airport_shuttle').length;
  const checks = [
    stationCheck('every ORANGE pattern includes Miami International Airport', patterns, 'ORANGE', patternsLacking(db, 'ORANGE', [MIA])),
    stationCheck('every GREEN pattern includes a Green-only station', patterns, 'GREEN', patternsLacking(db, 'GREEN', lineById('GREEN').sentinels)),
    { name: 'at least one airport shuttle', ok: shuttles >= 1, detail: `${shuttles} airport_shuttle pattern(s)` },
  ];
  invariant(checks.length === 3, 'the report runs the three M2.20 checks');
  return checks;
}

/** The patterns of `lineId` that visit none of `stationKeys`. */
function patternsLacking(db: NodeSqlExecutor, lineId: string, stationKeys: readonly string[]): number[] {
  invariant(stationKeys.length > 0, 'a required station is named');
  const lacking = db.all<{ pattern_idx: number }>(MISSING_STATION_SQL, [lineId, JSON.stringify(stationKeys)]).map((row) => row.pattern_idx);
  invariant(lacking.every(Number.isInteger), 'pattern indices are integers');
  return lacking;
}

/** A line must have patterns, and none of them may lack the required station. */
function stationCheck(name: string, patterns: readonly PatternSummary[], lineId: string, lacking: readonly number[]): ReportCheck {
  const patternCount = patterns.filter((p) => p.line_id === lineId).length;
  invariant(patternCount >= lacking.length, 'the lacking patterns are among the line’s patterns');
  const ok = patternCount > 0 && lacking.length === 0;
  const detail = patternCount === 0 ? 'the DB has no such pattern' : ok ? `${patternCount} pattern(s)` : `pattern(s) ${lacking.join(', ')} lack it`;
  invariant(detail.length > 0, 'a check says what it found');
  return { name, ok, detail };
}

const COLUMNS = ['idx', 'line', 'variant', 'route', 'dir', 'shape', 'ext_m', 'stops', 'trips', 'from → to'] as const;

/** One table row's cells, in COLUMNS order. */
function patternCells(p: PatternSummary): string[] {
  const cells = [p.pattern_idx, p.line_id, p.variant, p.route_id, p.direction_id, p.shape_id, p.extended_m.toFixed(1), p.stop_count, p.trips];
  invariant(cells.length === COLUMNS.length - 1, 'a cell per column before the route');
  const row = [...cells.map(String), `${p.first_station} → ${p.last_station}`];
  invariant(row.length === COLUMNS.length, 'a cell per column');
  return row;
}

/** The pattern table: a header, then one aligned row per pattern (catalog line order). */
function patternTable(patterns: readonly PatternSummary[]): string[] {
  invariant(patterns.length > 0, 'a built DB has patterns');
  const rows = [[...COLUMNS], ...patterns.map(patternCells)];
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  const table = rows.map((row) => `  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ')}`);
  invariant(table.length === patterns.length + 1, 'one header and one row per pattern');
  return table;
}

function main(argv: readonly string[]): number {
  invariant(Array.isArray(argv), 'the CLI reads its arguments');
  if (argv.length > 1) {
    console.error('usage: tsx scripts/gtfs/report.ts [path/to/schedule.db]');
    return 2;
  }
  const report = buildReport(resolve(argv[0] ?? REPO_PATHS.scheduleDb));
  if (!report.ok) {
    console.error(`report: ${report.error.message}`);
    return 1;
  }
  console.log(report.value.lines.join('\n'));
  invariant(report.value.checks.length > 0, 'the report checked something');
  return report.value.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
