#!/usr/bin/env bash
# mfix4_mode_status — "is the Mover even running?" (Jamie 2026-10-01 23:03: "Not seeing any metro move
# cars"). The live feed had 0 Mover vehicles and the bundled timetable's last Mover trips ended 22:12;
# the county says "Metromover service hours are 5:30 a.m. to 10 p.m.". The app showed the truth but
# explained nothing. This card: a PURE mode-status function + ScheduleRepo.modeStatusAt(epoch) (per mode:
# running / closed until its next first trip / no bundled timetable), proven on the REAL schedule DB;
# a map chip ("Metromover closed · opens 5:30 AM", time via src/ui/format.ts) shown only while a mode
# has no running timetable trip AND no live vehicle; zero extra live API calls; guarded full gate + a
# --no-bytecode iOS export (no .hbc greps). Runs after mfix3_map_feel and m6b_sheets_stations.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below. Helpers read no
# variable that another gate set. Run one gate alone, from the repo root (sourcing defines lib.sh +
# the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix4_mode_status.sh
#
# TEST-NAME CONVENTION (same as mfix2/m6b): each acceptance case is its OWN passing test whose full name
# (describe titles + test title, joined by one space, matched case-insensitively) ENDS with the gate's
# exact phrase at a word boundary: every pin is '(^| )<phrase>$'. No phrase here is a suffix of another.
# Phrases use no regex metacharacters.

MFIX4_DOMAIN=src/domain/schedule/mode-status.ts
MFIX4_DOMAIN_TEST=src/domain/schedule/__tests__/mode-status.test.ts
MFIX4_REAL_TEST=scripts/gtfs/__tests__/mode-status-real.test.ts
MFIX4_CHIP=src/ui/map/ModeStatusChip.tsx
MFIX4_CHIP_TEST=src/ui/map/__tests__/ModeStatusChip.test.tsx
MFIX4_MAP_ROUTE='src/app/(tabs)/index.tsx'
# The card's OWN UI modules: src/ui/map files whose name contains mode-status / ModeStatus (case-insensitive).
MFIX4_OWN_UI='^src/ui/map/[^/]*(mode-status|modestatus)[^/]*\.tsx?$'

# ---- card helpers

# _mfix4_ast <cmd> <args>... — one node program over the TypeScript AST (node_modules/typescript), walked
# with explicit stacks/queues (no recursion). Import closure = VALUE imports only (`import type` and
# type-only specifiers are erased), following ./ ../ and @/ (= src/) specifiers to .ts/.tsx files.
#   reaches <entry> <ERE>             a repo path in entry's closure matches ERE (case-insensitive)
#   renders <module> <export> <file>...  some <file> value-imports <export> from <module> and renders it as JSX
#   calls <module> <entry> <ERE>      entry (even a test) or a non-test file in its closure, path matching ERE, calls a
#                                     binding it value-imports from <module> (a mention or import alone fails)
#   method <entry> <ERE> <name>       a non-test file in entry's closure whose path matches ERE calls X.<name>(…)
#   ran <coverage-final.json> <module> <export> <file>...
#                                     some <file> renders <export> (value-imported from <module>) inside a function
#                                     whose istanbul hit count is > 0 (the innermost fnMap entry around the JSX)
#   literals <ERE> <file>...          NO string/template/numeric/JSX-text literal in the files matches ERE
#                                     (case-insensitive; comments are trivia, never literals)
#   maptest <file>                    <file> value-imports TransitMap (src/ui/map/TransitMap.tsx) or the Map
#                                     route (src/app/(tabs)/index.tsx) AND renders that binding as JSX
_mfix4_ast() {
  node - "$@" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, ...args] = process.argv.slice(2);
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
const rel = (p) => path.relative(ROOT, p);
const isTest = (p) => /(^|\/)__tests__\/|\.test\.tsx?$/.test(rel(p));
const abs = (p) => { const a = path.join(ROOT, p); if (!fs.existsSync(a)) fail(`missing ${p}`); return a; };
function resolveSpec(from, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
  return hit === undefined ? null : hit;
}
function parse(file) {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
/** Value bindings `file` imports from `target` (absolute path): local names, plus namespace names. */
function bindingsFrom(sf, file, target, only) {
  const names = [], spaces = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    if (resolveSpec(file, s.moduleSpecifier.text) !== target) continue;
    const c = s.importClause, nb = c.namedBindings;
    if (c.name && (!only || only === 'default')) names.push(c.name.text);
    if (nb && ts.isNamespaceImport(nb)) spaces.push(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) {
      const imported = (e.propertyName || e.name).text;
      if (!e.isTypeOnly && (!only || only === imported)) names.push(e.name.text);
    }
  }
  return { names, spaces };
}
/** Every node of a source file, iteratively. */
function nodes(sf) {
  const out = [], stack = [sf];
  for (let g = 0; stack.length > 0 && g < 2000000; g += 1) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (k) => { stack.push(k); }); }
  return out;
}
/** The value-import closure of `entry` (absolute paths), breadth-first, bounded. */
function closure(entry) {
  const seen = new Set([entry]), queue = [entry];
  for (let i = 0; i < queue.length && i < 5000; i += 1) {
    const file = queue[i], sf = parse(file);
    for (const n of nodes(sf)) {
      let spec = null;
      if (ts.isImportDeclaration(n) && !(n.importClause && n.importClause.isTypeOnly)) spec = n.moduleSpecifier.text;
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier && !n.isTypeOnly) spec = n.moduleSpecifier.text;
      else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) spec = n.arguments[0].text;
      const hit = spec === null ? null : resolveSpec(file, spec);
      if (hit !== null && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen];
}
const isJsxOf = (sf, n, names) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && names.includes(n.tagName.getText(sf));
function callsInto(sf, file, target) {
  const { names, spaces } = bindingsFrom(sf, file, target, null);
  return nodes(sf).some((n) => ts.isCallExpression(n) && (
    (ts.isIdentifier(n.expression) && names.includes(n.expression.text)) ||
    (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && spaces.includes(n.expression.expression.text))));
}
if (cmd === 'reaches') {
  const [entry, ere] = args, re = new RegExp(ere, 'i');
  const hit = closure(abs(entry)).map(rel).find((p) => re.test(p));
  if (hit === undefined) fail(`${entry} never value-imports (directly or through its imports) a module matching /${ere}/`);
  console.log(`ratchet: ${entry} reaches ${hit}`);
} else if (cmd === 'renders') {
  const [mod, exp, ...files] = args, target = abs(mod);
  const hit = files.find((f) => { const a = path.join(ROOT, f); if (!fs.existsSync(a)) return false; const sf = parse(a); const { names } = bindingsFrom(sf, a, target, exp); return names.length > 0 && nodes(sf).some((n) => isJsxOf(sf, n, names)); });
  if (hit === undefined) fail(`none of ${files.join(', ')} value-imports ${exp} from ${mod} AND renders it as a JSX element`);
  console.log(`ratchet: ${hit} renders <${exp}> from ${mod}`);
} else if (cmd === 'calls') {
  const [mod, entry, ere] = args, target = abs(mod), re = new RegExp(ere, 'i');
  const hit = closure(abs(entry)).filter((f) => (f === abs(entry) || !isTest(f)) && re.test(rel(f))).find((f) => callsInto(parse(f), f, target));
  if (hit === undefined) fail(`no non-test module matching /${ere}/ in ${entry}'s import closure calls a binding it value-imports from ${mod}`);
  console.log(`ratchet: ${rel(hit)} calls into ${mod}`);
} else if (cmd === 'maptest') {
  const file = abs(args[0]), sf = parse(file);
  const maps = [path.join(ROOT, 'src/ui/map/TransitMap.tsx'), path.join(ROOT, 'src/app/(tabs)/index.tsx')];
  const names = maps.flatMap((m) => bindingsFrom(sf, file, m, null).names);
  if (!nodes(sf).some((n) => isJsxOf(sf, n, names))) fail(`${args[0]} never value-imports AND renders (JSX) TransitMap or the Map route (src/app/(tabs)/index.tsx) — test what the Map tab mounts`);
  console.log(`ratchet: ${args[0]} renders what the Map tab mounts`);
} else if (cmd === 'ran') {
  const [cov, mod, exp, ...files] = args, target = abs(mod), data = JSON.parse(fs.readFileSync(cov, 'utf8'));
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
  const report = files.filter((f) => fs.existsSync(path.join(ROOT, f))).flatMap((f) => {
    const a = path.join(ROOT, f), sf = parse(a), { names } = bindingsFrom(sf, a, target, exp);
    const key = Object.keys(data).find((k) => k === a || k.endsWith(`/${f}`));
    return nodes(sf).filter((n) => isJsxOf(sf, n, names)).map((n) => {
      const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf)), at = { line: lc.line + 1, column: lc.character };
      if (key === undefined) return { f, at, hits: 0, fn: '(file never loaded by the suite)' };
      const { fnMap, f: counts } = data[key];
      const ids = Object.keys(fnMap).filter((i) => before(fnMap[i].loc.start, at) && before(at, fnMap[i].loc.end));
      const id = ids.reduce((best, i) => (best === null || before(fnMap[best].loc.start, fnMap[i].loc.start) ? i : best), null);
      return { f, at, hits: id === null ? 0 : counts[id], fn: id === null ? '(no enclosing function)' : fnMap[id].name };
    });
  });
  for (const r of report) console.log(`ratchet: ${r.f}:${r.at.line} <${exp}> — enclosing function ${r.fn} ran ${r.hits} time(s)`);
  if (!report.some((r) => r.hits > 0)) fail(`the suite never ran the function that renders <${exp}> (in ${files.join(' or ')}) — mount what the Map tab mounts`);
} else if (cmd === 'literals') {
  const [ere, ...files] = args, re = new RegExp(ere, 'i');
  const lit = (n) => ts.isLiteralKind(n.kind) || ts.isTemplateLiteralKind(n.kind);
  const hits = files.flatMap((f) => { const sf = parse(abs(f)); return nodes(sf).filter((n) => lit(n) && re.test(n.getText(sf))).map((n) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf)}`); });
  if (hits.length > 0) fail(`a literal in the card's code matches /${ere}/ (comments are ignored):\n  ${hits.join('\n  ')}`);
  console.log(`ratchet: no literal in ${files.length} file(s) matches /${ere}/`);
} else if (cmd === 'method') {
  const [entry, ere, name] = args, re = new RegExp(ere, 'i');
  const hit = closure(abs(entry)).filter((f) => !isTest(f) && re.test(rel(f))).find((f) => nodes(parse(f)).some((n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name));
  if (hit === undefined) fail(`no non-test module matching /${ere}/ in ${entry}'s import closure calls <something>.${name}(…)`);
  console.log(`ratchet: ${rel(hit)} calls .${name}(…)`);
} else fail(`_mfix4_ast: unknown command ${cmd}`);
NODE
}

need_files() {
  local f
  for f in "$@"; do need_file "$f" || return 1; done
}

# real_db_cases <node:test file> <phrase>... — the file runs green UNFILTERED (no fail/skip/todo), it
# opens the REAL committed assets/db/schedule.db (a node:sqlite probe imported before tsx logs every DB a
# test queries — m3a's DB_PROBE, verbatim), and each phrase has >= 1 passing leaf whose full name ends
# with it ('(^| )<phrase>$', lib's _nodetest_count). A fixture DB or a renamed empty test fails.
real_db_cases() {
  local file="$1" out phrase n real probe
  shift
  [ "$#" -ge 1 ] || { echo "ratchet: real_db_cases needs >= 1 phrase"; return 1; }
  need_file "$file" || return 1
  _no_argv_in_tests "$file" || return 1
  real="$(pwd -P)/assets/db/schedule.db"
  probe='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?String(db.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","createTagStore"]){const f=D.prototype[k];D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}'
  out=$(node --import "$probe" --import tsx --test --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file (unfiltered run)"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  echo "$out" | sed 's/^ *# //' | _qgrep -xF "ratchet-db-open: $real" \
    || { echo "$out" | grep 'ratchet-db-open' | head -5; echo "ratchet: $file never queried the real $real"; return 1; }
  for phrase in "$@"; do
    n=$(echo "$out" | _nodetest_count "(^| )${phrase}\$" "$file")
    [ "$n" -ge 1 ] || { echo "ratchet: no passing test in $file whose full name ends with '$phrase'"; return 1; }
  done
  echo "ratchet: $# real-DB case(s) passing in $file"
}

# jest_pin <path> <'(^| )phrase$'> — lib's jest_nonempty (an UNFILTERED run; the pin is matched on full
# names in-process) with a pin that must end in `$`, so the passing test is this case's own (mfix2's).
jest_pin() {
  case "$2" in *'$') ;; *) echo "ratchet: test-name pin '$2' must end in \$"; return 1 ;; esac
  jest_nonempty "$1" "$2" || return 1
}

# mode_status_probe — behaviour, independent of any test the builder writes: the gate itself opens the
# REAL schedule DB through m3a's scripts/gtfs/__tests__/real-schedule.ts (openRealScheduleDb, openRealRepo),
# calls ScheduleRepo.modeStatusAt(epoch), and compares with ground truth the gate computes in SQL
# (node:sqlite on the same DB). Contract (the note's): an outcome { kind: 'mode-status', rail, mover }
# (or the CalendarGap outside the calendar); each mode is { kind: 'running' } | { kind: 'closed',
# nextStart: { epoch, serviceDate, serviceSec } } | { kind: 'no-timetable' } (no trip of that mode from
# then to the bundled calendar's end — NOT "closed"). A first trip within the starting-soon window
# (>= 5 min, < 15 min) counts as running. A previous service day's 24:xx trips count: Fri 00:30 is probed
# while Thursday's rail still runs (premise asserted from SQL).
mode_status_probe() {
  need_files "$MFIX4_DOMAIN" src/data/schedule-repo.ts scripts/gtfs/__tests__/real-schedule.ts || return 1
  node --import tsx - <<'NODE' || { echo "ratchet: ScheduleRepo.modeStatusAt disagrees with the real timetable"; return 1; }
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
(async () => {
  const real = await import(path.join(process.cwd(), 'scripts/gtfs/__tests__/real-schedule.ts'));
  const db = real.openRealScheduleDb(), repo = real.openRealRepo(db);
  const sql = new DatabaseSync(path.join(process.cwd(), 'assets/db/schedule.db'), { readOnly: true });
  const TRIPS = 'FROM trip t JOIN pattern p USING(pattern_idx) JOIN line l USING(line_id) JOIN service_day_active a ON a.service_idx = t.service_idx WHERE a.date = ? AND l.mode = ?';
  const MODE = { rail: 0, mover: 1 };
  const base = (date) => sql.prepare('SELECT base_epoch AS b FROM service_day WHERE date = ?').get(date).b;
  const first = (date, mode) => sql.prepare(`SELECT min(t.start_s) AS s ${TRIPS}`).get(date, MODE[mode]).s;
  const runningN = (date, mode, at) => sql.prepare(`SELECT count(*) AS n ${TRIPS} AND t.start_s <= ? AND t.end_s >= ?`).get(date, MODE[mode], at - base(date), at - base(date)).n;
  const ny = (iso) => Date.parse(iso) / 1000;
  const next = (date, mode) => ({ kind: 'closed', nextStart: { epoch: base(date) + first(date, mode), serviceDate: date, serviceSec: first(date, mode) } });
  const pick = (s) => (s && s.kind === 'closed' ? { kind: s.kind, nextStart: { epoch: s.nextStart.epoch, serviceDate: s.nextStart.serviceDate, serviceSec: s.nextStart.serviceSec } } : { kind: s && s.kind });
  const check = (label, at, want) => {
    assert.equal(typeof repo.modeStatusAt, 'function', 'ScheduleRepo has no modeStatusAt(epoch) method');
    const got = repo.modeStatusAt(at);
    assert.equal(got.kind, 'mode-status', `${label}: expected a mode-status outcome, got ${JSON.stringify(got)}`);
    for (const mode of ['rail', 'mover']) assert.deepEqual(pick(got[mode]), want[mode], `${label}: ${mode}`);
    console.log(`ratchet: ${label} — rail ${want.rail.kind}, mover ${want.mover.kind}${want.mover.nextStart ? ' until ' + want.mover.nextStart.serviceSec + ' s' : ''}`);
  };
  const thu2303 = ny('2026-10-01T23:03:00-04:00'), F = base(20261002) + first(20261002, 'mover');
  assert.ok(runningN(20261001, 'mover', thu2303) === 0 && runningN(20261001, 'rail', thu2303) > 0, 'premise: Thu 23:03 the timetable runs rail and no Mover');
  assert.ok(first(20261002, 'mover') >= 5 * 3600 && first(20261002, 'mover') < 6 * 3600, 'premise: the Friday Mover starts between 5 and 6 AM');
  check('Thu 2026-10-01 23:03', thu2303, { rail: { kind: 'running' }, mover: next(20261002, 'mover') });
  check('Thu 2026-10-01 12:00', ny('2026-10-01T12:00:00-04:00'), { rail: { kind: 'running' }, mover: { kind: 'running' } });
  // The previous service day's 24:xx trips: Thursday's rail runs past midnight (to ~01:04), so Fri 00:30 is NOT closed.
  const fri0030 = ny('2026-10-02T00:30:00-04:00');
  assert.ok(runningN(20261001, 'rail', fri0030) > 0, 'premise: Thursday service-day rail trips (24:xx) run at Fri 00:30');
  assert.ok(runningN(20261001, 'mover', fri0030) === 0 && runningN(20261002, 'mover', fri0030) === 0, 'premise: no Mover trip runs at Fri 00:30');
  check('Fri 2026-10-02 00:30 (Thu 24:xx rail)', fri0030, { rail: { kind: 'running' }, mover: next(20261002, 'mover') });
  check('Fri 2026-10-02 02:00 (rail night gap)', ny('2026-10-02T02:00:00-04:00'), { rail: next(20261002, 'rail'), mover: next(20261002, 'mover') });
  check('5 min before the first Friday Mover (starting soon)', F - 300, { rail: { kind: 'running' }, mover: { kind: 'running' } });
  check('15 min before the first Friday Mover', F - 900, { rail: { kind: 'running' }, mover: next(20261002, 'mover') });
  check('Mon 2026-11-23 12:00 (past the bundled rail timetable)', ny('2026-11-23T12:00:00-05:00'), { rail: { kind: 'no-timetable' }, mover: { kind: 'running' } });
  const gap = repo.modeStatusAt(ny('2027-01-05T12:00:00-05:00'));
  assert.notEqual(gap.kind, 'mode-status', 'past the calendar the outcome is the CalendarGap');
  console.log(`ratchet: past the calendar → ${gap.kind}`);
  db.close(); sql.close();
})().catch((e) => { console.log(`ratchet: ${e.message}`); process.exit(1); });
NODE
}

# repo_wires_domain — ScheduleRepo (src/data/schedule-repo.ts) CALLS the pure function: it value-imports a
# binding from src/domain/schedule/mode-status.ts and calls it (SQL in the repo, the decision in the domain).
repo_wires_domain() {
  need_file "$MFIX4_DOMAIN" || return 1
  _mfix4_ast calls "$MFIX4_DOMAIN" src/data/schedule-repo.ts '^src/data/schedule-repo\.ts$' || return 1
}

# domain_test_drives — the pure suite value-imports AND calls a mode-status.ts export (an `import type`, a
# mention or a test that never runs the function fails), then runs green with >= 1 test.
domain_test_drives() {
  need_file "$MFIX4_DOMAIN_TEST" || return 1
  _mfix4_ast calls "$MFIX4_DOMAIN" "$MFIX4_DOMAIN_TEST" '__tests__/mode-status\.test\.ts$' || return 1
  jest_nonempty "$MFIX4_DOMAIN_TEST" || return 1
}

# chip_mounted — the Map tab mounts the chip: the Map route (src/app/(tabs)/index.tsx) or TransitMap
# value-imports ModeStatusChip from src/ui/map/ModeStatusChip.tsx and renders <ModeStatusChip …/>.
chip_mounted() {
  need_file "$MFIX4_CHIP" || return 1
  _mfix4_ast renders "$MFIX4_CHIP" ModeStatusChip "$MFIX4_MAP_ROUTE" src/ui/map/TransitMap.tsx || return 1
}

# chip_reads_timetable_and_live — the chip's status comes from ScheduleRepo.modeStatusAt (a src/ui/map
# module it reaches calls .modeStatusAt(…)); its live-vehicle check from the app's ONE live runtime (one of
# the card's own modules — $MFIX4_OWN_UI: the chip or use-mode-status.ts — CALLS a binding it value-imports
# from src/live/live-context.tsx, i.e. useLive; an import alone, or reaching it through use-live-map.ts,
# fails); its opening time is formatted by src/ui/format.ts (one of the card's own modules calls a
# format.ts export — TransitMap's or the pill's formatting does not count).
chip_reads_timetable_and_live() {
  need_file "$MFIX4_CHIP" || return 1
  _mfix4_ast method "$MFIX4_CHIP" '^src/ui/map/' modeStatusAt || return 1
  _mfix4_ast calls src/live/live-context.tsx "$MFIX4_CHIP" "$MFIX4_OWN_UI" || return 1
  _mfix4_ast calls src/ui/format.ts "$MFIX4_CHIP" "$MFIX4_OWN_UI" || return 1
}

# chip_modules_clean — the card's own UI modules (every non-test src/ui/map file whose name contains
# "mode-status"/"ModeStatus", the chip at least):
#  * REALTIME COST RULE: start no realtime work — no watchStations( / fetch( / .start( / .resume( call. The
#    status is the timetable + the already-polled vehicles.
#  * hardcode no opening time: no string/template/numeric/JSX-text literal (comments are ignored) matches
#    18000 / 19800 / 18_000 / 19_800 (5:00 / 5:30 AM in service seconds) or a clock time like "5:30 AM" — the
#    time shown is ModeStatus.nextStart.serviceSec formatted by src/ui/format.ts.
chip_modules_clean() {
  local f files hits rc
  need_file "$MFIX4_CHIP" || return 1
  files=$(find src/ui/map -maxdepth 1 -type f \( -iname '*mode-status*' -o -iname '*modestatus*' \) -name '*.ts*') \
    || { echo "ratchet: find failed under src/ui/map"; return 1; }
  [ -n "$files" ] || { echo "ratchet: no mode-status module under src/ui/map"; return 1; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rc=0
    hits=$(grep -nE '\b(watchStations|fetch)\(|\.(start|resume)\(' "$f") || rc=$?
    [ "$rc" -le 1 ] || { echo "ratchet: grep failed (rc=$rc) on $f"; return 1; }
    [ -z "$hits" ] || { echo "$hits"; echo "ratchet: $f starts realtime work — the mode status reads the timetable and useLive().state only"; return 1; }
  done <<LIST
$files
LIST
  echo "ratchet: the chip's modules start no realtime work ($(echo "$files" | wc -l | tr -d ' ') file(s))"
  # $files is newline-separated paths without spaces (find under src/ui/map, name-filtered): split on newlines only.
  local IFS=$'\n'
  _mfix4_ast literals '\b(18000|19800|18_000|19_800)\b|[0-9]:[0-9]{2} ?[AP]M' $files || return 1
}

# chip_suite_mounts_map — the chip's suite really RUNS what the Map tab mounts: one unfiltered jest run of
# $MFIX4_CHIP_TEST with coverage (json reporter, private dir), then the function that renders
# <ModeStatusChip …/> in the Map route or TransitMap (the innermost istanbul fnMap entry around the JSX — e.g.
# MapScreen) has a hit count > 0. A <TransitMap/> inside a test arrow that never runs, or a chip mounted
# inside a never-called helper, reads 0.
chip_suite_mounts_map() {
  local dir out
  need_files "$MFIX4_CHIP" "$MFIX4_CHIP_TEST" || return 1
  _no_argv_in_tests "$MFIX4_CHIP_TEST" || return 1
  dir=$(mktemp -d -t ratchet-mfix4-cov.XXXXXX) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(local_bin jest --ci --runTestsByPath "$MFIX4_CHIP_TEST" --coverage --coverageReporters=json --coverageDirectory="$dir" 2>&1) \
    || { echo "$out" | tail -30; rm -rf "$dir"; echo "ratchet: the chip suite is red (coverage run)"; return 1; }
  [ -f "$dir/coverage-final.json" ] || { rm -rf "$dir"; echo "ratchet: jest wrote no coverage-final.json"; return 1; }
  _mfix4_ast ran "$dir/coverage-final.json" "$MFIX4_CHIP" ModeStatusChip "$MFIX4_MAP_ROUTE" src/ui/map/TransitMap.tsx \
    || { rm -rf "$dir"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot remove $dir"; return 1; }
}

# chip_case <phrase> — the chip's suite tests what the Map tab mounts (it value-imports AND renders
# TransitMap or the Map route as JSX — _mfix4_ast maptest; that it RUNS it is chip_suite_mounts_map), then
# the phrase's own test passes in an unfiltered run ('(^| )<phrase>$').
chip_case() {
  need_file "$MFIX4_CHIP_TEST" || return 1
  _mfix4_ast maptest "$MFIX4_CHIP_TEST" || return 1
  jest_pin "$MFIX4_CHIP_TEST" "(^| )$1\$" || return 1
}

# card_files — every file this card creates: the guard for the repo-wide gates (a bare full_gate is green
# on the unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files "$MFIX4_DOMAIN" "$MFIX4_DOMAIN_TEST" "$MFIX4_REAL_TEST" "$MFIX4_CHIP" "$MFIX4_CHIP_TEST" || return 1
}

# card_full_gate — tsc, eslint --max-warnings 0, standards, jest, node:test: green WITH this card's files.
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# export_carries_chip — Metro exports the iOS bundle (Hermes, the plan's gate), then a --no-bytecode export's
# JS carries the chip text's static part "closed · opens" (U+00B7; a minifier may escape it as \u00b7 or
# \xb7). Never greps the .hbc. Both exports run on a Metro cache private to THIS tree (TMPDIR ->
# .cache/metro-tmp-mfix4), copied from verify-mfix2_ui_shell.sh export_registers_stacks: Metro's shared
# cache, keyed by project-relative path + content, let a symlinked-node_modules tree reuse another tree's
# modules (proven 2026-10-01). The private cache never writes into the shared one.
export_carries_chip() {
  local dir=.cache/export-mfix4-js metro_tmp="$PWD/.cache/metro-tmp-mfix4" out rc
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  rc=0
  grep -rqF -e 'closed · opens' -e 'closed \u00b7 opens' -e 'closed \xb7 opens' "$dir/_expo/static/js/ios" || rc=$?
  [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle does not carry the chip text 'closed · opens'"; return 1; }
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  echo "ratchet: the iOS JS bundle carries the mode-status chip text"
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix4_mode_status gate failed at verify script line $LINENO"' ERR

# ---- gates

# --- (a) Is each mode running? A pure function + ScheduleRepo.modeStatusAt(epoch), on the REAL timetable ---
# 1. The pure decision lives in the domain.
need_file src/domain/schedule/mode-status.ts
# 2. ScheduleRepo calls it (value-imports AND calls a mode-status.ts export).
repo_wires_domain
# 3. The pure suite value-imports AND calls a mode-status.ts export, and runs green.
domain_test_drives
# 4. Behaviour probe on the real DB, ground truth from SQL: Thu 2026-10-01 23:03 rail running + Mover closed until Fri's first Mover trip (5–6 AM); Thu 12:00 both running; Fri 00:30 rail running (Thursday's 24:xx trips) + Mover closed until Fri's first Mover trip; Fri 02:00 both closed until their first Friday trips; 5 min before the first Mover = running (starting soon), 15 min before = closed; Mon 2026-11-23 rail 'no-timetable' (past its bundled schedule) + Mover running; 2027-01-05 = the CalendarGap.
mode_status_probe
# 5. N: Thu 2026-10-01 23:03 the Mover is closed and its next start is Fri 2026-10-02's first Mover trip (the hour asserted from the DB) — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'thu 23:03 the mover is closed until its first friday trip'
# 6. N: Thu 23:03 rail is running — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'thu 23:03 rail is running'
# 7. N: Thu 12:00 rail and the Mover are both running — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'thu 12:00 rail and the mover are both running'
# 8. N: Fri 02:00 rail is closed (its night gap) with its next start at Fri's first rail trip — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'fri 02:00 rail is closed in its night gap until its first friday trip'
# 9. N: a first trip that starts inside the starting-soon window counts as running — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'a first trip inside the starting soon window counts as running'
# 10. N: past the bundled rail timetable (Mon 2026-11-23) rail is 'no-timetable', never "closed" — its own real-DB test.
real_db_cases scripts/gtfs/__tests__/mode-status-real.test.ts 'past the bundled rail timetable rail has no timetable rather than closed'

# --- (b) The map says so ---
# 11. The chip is its own component.
need_file src/ui/map/ModeStatusChip.tsx
# 12. The Map tab mounts it: the Map route (or TransitMap) value-imports and renders <ModeStatusChip …/>.
chip_mounted
# 13. Its status comes from ScheduleRepo.modeStatusAt; one of the card's own modules (mode-status/ModeStatus under src/ui/map) CALLS useLive (src/live/live-context.tsx) and CALLS a src/ui/format.ts export.
chip_reads_timetable_and_live
# 14. The chip's own modules start no realtime work (REALTIME COST RULE: no watchStations/fetch/start/resume call) and hardcode no opening time (no 18000/19800/"5:30 AM"-style literal outside comments).
chip_modules_clean
# 15. The chip suite RUNS what the Map tab mounts: one jest coverage run; the function rendering <ModeStatusChip …/> (Map route or TransitMap) has > 0 hits.
chip_suite_mounts_map
# 16. J: Thu 23:03 with no live Mover the map reads "Metromover closed · opens 5:30 AM" (time via format.ts) — its own test, rendering the Map route or TransitMap.
chip_case 'thu 23:03 with no live mover the map says metromover closed and when it opens'
# 17. J: Fri 02:00 the map reads "Metrorail closed · opens <Fri first rail time>" — its own test.
chip_case 'fri 02:00 the map says metrorail closed and when it opens'
# 18. J: Thu 12:00 (both modes running) no chip is shown — its own test.
chip_case 'the chip is hidden while both modes run'
# 19. J: Thu 23:03 with a LIVE Mover vehicle in useLive().state the Mover chip is hidden — its own test.
chip_case 'the chip is hidden while the closed mode has live vehicles'
# 20. J: Mon 2026-11-23 (rail 'no-timetable') no "Metrorail closed" chip — the status pill owns schedule expiry — its own test.
chip_case 'the chip is hidden for a mode past its bundled timetable'
# 21. J: with the map left open across the Mover's last trip end (fake timers, no remount) the chip appears — its own test.
chip_case 'the chip appears when the last mover trip ends without a remount'
# 22. J: mounting and updating the chip makes zero live API calls (the fake server's request count is unchanged) — its own test.
chip_case 'showing the mode status makes no live calls'

# --- (c) Full gate + iOS export ---
# 23. The card's files exist, then tsc, eslint --max-warnings 0, standards, jest, node:test — all green with them.
card_full_gate
# 24. Metro exports the iOS bundle, and a --no-bytecode export carries the chip text "closed · opens" (private Metro cache).
export_carries_chip

echo "mfix4_mode_status: all 24 gates green"
