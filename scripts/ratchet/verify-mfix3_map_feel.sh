#!/usr/bin/env bash
# mfix3_map_feel — the live map's feel (arbiter diagnosis 2026-10-01 20:10, five problems Jamie hit): Movers keep
# moving between polls (time-based clamp, hold at a station), eased corrections + position carried across a trip
# change, markers in their line's lane, the relative live/stale rule (pill and markers agree, new drop rule),
# station/line/vehicle tap names, a map legend, the user-location dot + a locate-me button.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below. Helpers read no
# variable that another gate set. Run one gate alone, from the repo root (sourcing defines lib.sh +
# the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix3_map_feel.sh
#
# TEST-NAME CONVENTION the jest gates rely on: each acceptance case is its OWN passing jest test whose
# full name (describe titles + test title, joined by one space, compared case-insensitively) ENDS with
# the case's exact phrase, starting at a word boundary (the name IS the phrase, or has a space before
# it). Phrases are plain text (no regex). No phrase of this card ends with another, and a test whose
# name ends with one phrase cannot end with a second, so one catch-all test proves at most one case.

# The CARD-WIDE universe of jest acceptance phrases (every phrase any jest_cases gate below names, spelled
# exactly as the gate passes it). Helpers only read it; no gate sets it.
MFIX3_JEST_CASES=(
  # §1 Mover freeze (gate 1)
  'a mover keeps moving every second for 60 s between polls'
  'the projection runs until 30 s after the next poll was due'
  'a projection that runs out holds at a station'
  # §2 teleport on a new poll (gate 2)
  'a 150 m correction eases in under 1.25 s'
  'a correction of 500 m or more snaps'
  'a 200 m backward correction holds the marker'
  'a trip change carries the marker without a jump'
  # §3 markers in their lane (gate 5)
  'g and o markers at one trunk place are at least 0.9 lane widths apart at every zoom bucket'
  'each trunk marker lies within 1 m of its own drawn line at every zoom bucket'
  'mover markers on shared track sit in their own lanes'
  'a marker on unshared track lies within 1 m of its own drawn line at every zoom bucket'
  # §4 relative staleness (gates 7, 8, 9)
  'transitland staleness lag 90 live 180 drop 300'
  'swiftly staleness lag 60 live 75 drop 150'
  'a 120 s old feed with vehicles 10 s behind stays live for the next 60 s'
  'a vehicle 136 s behind a 27 s old feed is stale and the others solid'
  'a vehicle 91 s behind a fresh feed is stale and one 90 s behind is solid'
  'a 200 s old feed reads live 3 min old and every marker is stale'
  'a 290 s old feed keeps its vehicles'
  'a feed over 300 s old or a vehicle over 300 s behind it is dropped'
  # §5 taps, legend, user location (gates 11, 12, 13)
  'a station tap shows the station name'
  'a station tap still reports the station'
  'a line tap shows the line name'
  'a shared trunk tap shows both line names'
  'a map press away from every line names no line'
  'a live vehicle tap shows line, destination and live age'
  'a scheduled vehicle tap says timetable estimate'
  'a vehicle tap still reports the vehicle'
  'the legend button opens the map legend'
  'the legend explains every marker kind'
  'the map shows the user location once permission is granted'
  'locate me centres the map on the user'
  'location denied shows no dot and one line of explanation'
  'a missing or failed location permission answer counts as denied'
)

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----

# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX3_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix3_map_feel.$(printf '%s' "$path" | tr '/' '_').json"
  rm -f "$report" || { echo "ratchet: cannot clear $report"; return 1; }
  out=$(local_bin jest --ci --json --outputFile="$report" "${sel[@]}" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest red (or not installed) under $path"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; echo "ratchet: jest wrote no JSON report for $path"; return 1; }
  node -e '
const [report, where, count, ...rest] = process.argv.slice(1);
const n = Number(count);
const wanted = rest.slice(0, n).map((s) => s.toLowerCase());
const universe = rest.slice(n).map((s) => s.toLowerCase());
const ends = (name, p) => name === p || name.endsWith(" " + p);
const authoring = [];
if (!(n >= 1) || universe.length === 0) authoring.push(`bad arguments (${n} phrase(s), ${universe.length} in the universe)`);
if (new Set(universe).size !== universe.length) authoring.push("MFIX3_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX3_JEST_CASES`);
if (authoring.length) { authoring.forEach((p) => console.log(`ratchet: verify-script authoring error: ${p}`)); process.exit(1); }
const r = JSON.parse(require("node:fs").readFileSync(report, "utf8"));
const all = r.testResults.flatMap((t) => t.assertionResults);
const passed = all.filter((a) => a.status === "passed").map((a) => a.fullName.toLowerCase().replace(/\s+/g, " ").trim());
if (r.success !== true || r.numFailedTests || r.numFailedTestSuites || r.numPendingTests || r.numTodoTests || passed.length === 0) {
  console.log(`ratchet: ${where}: ${passed.length} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, ${r.numTodoTests} todo — failing/skipped/todo tests are forbidden`);
  process.exit(1);
}
const problems = [];
for (const w of wanted) {
  const hits = passed.filter((name) => ends(name, w));
  const own = hits.filter((name) => universe.every((o) => o === w || !ends(name, o)));
  if (hits.length === 0) problems.push(`no PASSED test name ends with "${w}"`);
  else if (own.length === 0) problems.push(`every test ending with "${w}" also ends with another card phrase — give it its own test`);
}
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${where}: ${p}`)); process.exit(1); }
console.log(`ratchet: ${where}: ${passed.length} tests green; ${wanted.length} named case(s), each its own passing test`);
' "$report" "$path" "$#" "$@" "${MFIX3_JEST_CASES[@]}" || return 1
}

# need_files, src_imports and mocks_native_only: copied VERBATIM from verify-m5c_live_map.sh (m5c's card helpers).

# need_files <file>... — lib.sh's need_file for each.
need_files() {
  local f
  [ "$#" -ge 1 ] || { echo "ratchet: need_files needs at least one path"; return 1; }
  for f in "$@"; do need_file "$f" || return 1; done
}

# src_imports <specifier-suffix> <path>... — a NON-test .ts/.tsx file under the paths imports (or
# re-exports) a module whose specifier ends in the suffix ('@/ui/map/TransitMap' and './TransitMap'
# both end in '/TransitMap'): the module is wired in, not dead code.
src_imports() {
  local mod="$1" p rc=0; shift
  [ "$#" -ge 1 ] || { echo "ratchet: src_imports needs at least one path to scan"; return 1; }
  for p in "$@"; do
    [ -e "$p" ] || { echo "ratchet: missing $p — not built yet"; return 1; }
  done
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ "from ['\"][^'\"]*${mod}['\"]" "$@" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: no non-test module under $* imports a module ending in '${mod}' — it is not wired in"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning $* for imports of '${mod}'"; return 1
}

# Every jest.mock / jest.doMock in the map tests targets a PACKAGE — never an app module ('@/…',
# './…', '../…', 'src/…') — and carries the repo label '// test-time mock of native module' on the
# line above the call or within it up to the module-name line (CLAUDE.md: only native modules are
# mocked, in jest only, labelled).
# Mocking schedule-db-provider or live-context would stub the very wiring this card builds.
mocks_native_only() {
  local dir="$1"
  [ -d "$dir" ] || { echo "ratchet: missing $dir — the milestone's tests do not exist yet"; return 1; }
  node - "$dir" <<'NODE' || return 1
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const LABEL = "// test-time mock of native module";
const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
const problems = [];
let mocks = 0;
for (const rel of files) {
  const text = fs.readFileSync(path.join(dir, rel), "utf8");
  const lines = text.split("\n");
  for (const m of text.matchAll(/\bjest\.(?:mock|doMock)\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    mocks += 1;
    const lineNo = text.slice(0, m.index).split("\n").length;
    const where = `${path.join(dir, rel)}:${lineNo}`;
    const mod = m[2];
    if (mod === undefined) {
      problems.push(`${where}: the jest.mock target is not a string literal`);
      continue;
    }
    if (/^(@\/|\.|src\/)/.test(mod)) problems.push(`${where}: mocks app module '${mod}' — only native modules may be mocked`);
    // The label sits on the line above the call, or anywhere from `jest.mock(` to the end of the
    // line holding the module string (a multi-line call may carry it after the module name).
    const targetLineNo = text.slice(0, m.index + m[0].length).split("\n").length;
    const above = (lines[lineNo - 2] ?? "").trim();
    const span = lines.slice(lineNo - 1, targetLineNo).join("\n");
    if (!above.startsWith(LABEL) && !span.includes(LABEL)) problems.push(`${where}: jest.mock('${mod}') lacks the '${LABEL}' label`);
  }
}
if (files.length === 0) problems.push(`no test files under ${dir}`);
if (problems.length > 0) {
  for (const p of problems) console.log(`ratchet: ${p}`);
  process.exit(1);
}
console.log(`ratchet: ${mocks} jest.mock call(s) under ${dir}: all packages, all labelled`);
NODE
}

# frames_wired: copied VERBATIM from verify-m5c_live_map.sh (gate 8 there).
# M5.10 wiring: tickPlan.ts, reconcileLive.ts and useVehicleFrames.ts exist; each is imported by a
# non-test map module (src/ui/map) or the Map route; and nothing under src/ui or src/app moves markers
# with AnimatedRegion (§4: motion follows the track by frame ticks, never AnimatedRegion).
frames_wired() {
  local m hits rc=0
  need_files src/ui/map/tickPlan.ts src/ui/map/reconcileLive.ts src/ui/map/useVehicleFrames.ts || return 1
  for m in tickPlan reconcileLive useVehicleFrames; do
    src_imports "/$m" src/ui/map "src/app/(tabs)/index.tsx" || return 1
  done
  hits=$(grep -rlF --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ AnimatedRegion src/ui src/app) || rc=$?
  [ "$rc" -eq 1 ] && return 0
  [ "$rc" -eq 0 ] && { echo "ratchet: AnimatedRegion used in: $hits — §4: markers move along the shape by frame ticks, never AnimatedRegion"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning src/ui and src/app for AnimatedRegion"; return 1
}

# _mfix3_ast <cmd> <args>... — checks over the TypeScript AST (comments are trivia, never nodes, so a comment
# or a string naming a thing never satisfies them). Copied from verify-m7c_hurry_or_chill.sh's _m7c_ast (the
# house pattern; not sourced): `calls` verbatim; `invokes` is its `uses` plus a CALL. Explicit stacks, no recursion.
#   calls <dir|file> <name>            a NON-TEST .ts/.tsx under <dir> (or the file) calls name(…) or x.name(…)
#   invokes <file> <name> <spec-ERE>   <file> value-imports <name> (not `import type`, not a type-only element)
#                                      from a specifier matching ^ERE$ AND calls name(…) outside the import
_mfix3_ast() {
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, target, a, b] = process.argv.slice(2);
if (!fs.existsSync(target)) fail(`missing ${target}`);
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function nodes(root) {
  const out = [], stack = [root];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (k) => { stack.push(k); }); }
  return out;
}
if (cmd === 'calls') {
  const files = [], todo = [target];
  for (let g = 0; todo.length > 0 && g < 10000; g += 1) {
    const p = todo.pop();
    if (fs.statSync(p).isDirectory()) { if (path.basename(p) !== '__tests__') for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
  }
  const hit = files.find((f) => nodes(parse(f)).some((n) => ts.isCallExpression(n)
    && ((ts.isIdentifier(n.expression) && n.expression.text === a) || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === a))));
  if (hit === undefined) fail(`no non-test code under ${target} calls ${a}(…) (comments and strings do not count; searched ${files.length} files)`);
  console.log(`ratchet: ${hit} calls ${a}(…)`);
} else if (cmd === 'invokes') {
  const sf = parse(target), re = new RegExp(`^(${b})$`);
  const imp = sf.statements.find((s) => ts.isImportDeclaration(s) && !(s.importClause && s.importClause.isTypeOnly) && re.test(s.moduleSpecifier.text)
    && s.importClause && s.importClause.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some((e) => !e.isTypeOnly && e.name.text === a));
  if (imp === undefined) fail(`${target} does not value-import { ${a} } from /^(${b})$/ (an \`import type\` does not count)`);
  const calls = nodes(sf).filter((n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === a && !(n.pos >= imp.pos && n.end <= imp.end));
  if (calls.length === 0) fail(`${target} imports ${a} but never calls ${a}(…) — the cases must run it, not just name it`);
  console.log(`ratchet: ${target} imports ${a} and calls it ${calls.length} time(s)`);
} else fail(`unknown _mfix3_ast command '${cmd}'`);
NODE
}

# reaches: copied VERBATIM from verify-m7c_hurry_or_chill.sh (not sourced).
# reaches <entry> <ERE>... — the entry exists and its VALUE-import closure (TypeScript AST; `import type`
# is erased; ./ ../ and @/ specifiers followed to .ts/.tsx files, plus require()/import()) contains, for
# every ERE (case-insensitive), a repo path or an external package recorded as 'pkg:<specifier>'. An ERE
# written '!<ERE>' is the opposite: NO path in the closure may match it (an import-graph absence, so a
# comment naming the module neither fails it nor an aliased re-export slips past it).
# Walked with an explicit queue (no recursion).
reaches() {
  need_file "$1" || return 1
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [entry, ...patterns] = process.argv.slice(2);
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolveSpec(from, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && isFile(p));
  return hit === undefined ? null : hit;
}
function typeOnly(clause) {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return clause.name === undefined && named !== undefined && ts.isNamedImports(named)
    && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
}
function specsOf(abs) {
  const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const stack = [sf];
  for (let guard = 0; stack.length > 0 && guard < 200000; guard += 1) {
    const n = stack.pop();
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!typeOnly(n.importClause)) out.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, (k) => { stack.push(k); });
  }
  return out;
}
const start = path.resolve(ROOT, entry);
const queue = [start];
const seen = new Set(queue);
const found = new Set([rel(start)]);
for (let i = 0; i < queue.length && i < 5000; i += 1) {
  for (const spec of specsOf(queue[i])) {
    const next = resolveSpec(queue[i], spec);
    if (next === null) {
      if (!spec.startsWith('.') && !spec.startsWith('@/')) found.add(`pkg:${spec}`);
      continue;
    }
    if (!seen.has(next)) { seen.add(next); queue.push(next); found.add(rel(next)); }
  }
}
const all = [...found];
const wanted = patterns.filter((p) => !p.startsWith('!'));
const banned = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
const missing = wanted.filter((p) => !all.some((f) => new RegExp(p, 'i').test(f)));
if (missing.length > 0) {
  fail(`${entry} never imports (directly or transitively, value imports only) a module matching ${missing.map((p) => `/${p}/i`).join(', ')}; it reaches: ${all.filter((f) => f.startsWith('src/')).join(', ')}`);
}
const forbidden = all.filter((f) => banned.some((p) => new RegExp(p, 'i').test(f)));
if (forbidden.length > 0) fail(`${entry} must not reach ${banned.map((p) => `/${p}/i`).join(', ')}, but its value-import closure holds ${forbidden.join(', ')}`);
console.log(`ratchet: ${entry} reaches ${wanted.map((p) => `/${p}/i`).join(', ') || 'only allowed modules'}${banned.length > 0 ? ` and never ${banned.map((p) => `/${p}/i`).join(', ')}` : ''}`);
NODE
}

# §3: the marker lane module computes trip-track lanes THE SAME WAY as the drawn lines' lanes — its
# VALUE-import closure holds src/ui/map/lineLayout.ts (m5b's lane layout; `import type` does not count) —
# and the Map route's value-import closure holds markerLanes.ts, so the shift reaches the drawn markers (an
# importer nobody mounts does not count).
lanes_wired() {
  need_files src/ui/map/markerLanes.ts src/ui/map/lineLayout.ts || return 1
  reaches src/ui/map/markerLanes.ts 'src/ui/map/lineLayout\.ts$' || return 1
  reaches 'src/app/(tabs)/index.tsx' 'src/ui/map/markerLanes\.ts$' || return 1
}

# §5 user location: non-test src/ui/map code CALLS requestForegroundPermissionsAsync (the existing
# expo-location flow, as src/ui/diagnostics/device-probes.ts does — AST, so a comment naming it does not
# count); src/ui/map/use-user-location.ts value-imports expo-location; and the Map route's value-import
# closure holds use-user-location.ts (an importer nobody mounts does not count).
location_wired() {
  need_file src/ui/map/use-user-location.ts || return 1
  _mfix3_ast calls src/ui/map requestForegroundPermissionsAsync || return 1
  reaches src/ui/map/use-user-location.ts '^pkg:expo-location$' || return 1
  reaches 'src/app/(tabs)/index.tsx' 'src/ui/map/use-user-location\.ts$' || return 1
}

# §5 legend: src/ui/map/MapLegend.tsx exists and is reached from the map (a src/ui/map module, the Map
# route, or a route under src/app that presents it, e.g. a legend sheet).
legend_wired() {
  need_file src/ui/map/MapLegend.tsx || return 1
  src_imports '/MapLegend' src/ui/map src/app || return 1
}

# §1/§2: the motion cases run through the frames module the map runs — vehicleMotion.test.ts value-imports
# AND calls planFrames and framesAt from src/ui/map/vehicleFrames (AST: a type-only import or a mere mention
# does not count).
motion_test_wired() {
  local t=src/ui/map/__tests__/vehicleMotion.test.ts spec='\.\./vehicleFrames|@/ui/map/vehicleFrames'
  _mfix3_ast invokes "$t" planFrames "$spec" || return 1
  _mfix3_ast invokes "$t" framesAt "$spec" || return 1
}

# §4: the staleness cases run through the modules the map runs — liveStaleness.test.ts value-imports AND
# calls the pill's statusConditions + statusFace (src/ui/dataStatus), planFrames (the §4 merge, which drops)
# + framesAt (the frames the markers draw) from src/ui/map/vehicleFrames, and vehicleVisual
# (src/ui/map/vehicleVisual: the drawn stale look) — so "pill and markers agree" is judged on the real path.
staleness_test_wired() {
  local t=src/ui/map/__tests__/liveStaleness.test.ts
  _mfix3_ast invokes "$t" statusConditions '\.\./\.\./dataStatus|@/ui/dataStatus' || return 1
  _mfix3_ast invokes "$t" statusFace '\.\./\.\./dataStatus|@/ui/dataStatus' || return 1
  _mfix3_ast invokes "$t" planFrames '\.\./vehicleFrames|@/ui/map/vehicleFrames' || return 1
  _mfix3_ast invokes "$t" framesAt '\.\./vehicleFrames|@/ui/map/vehicleFrames' || return 1
  _mfix3_ast invokes "$t" vehicleVisual '\.\./vehicleVisual|@/ui/map/vehicleVisual' || return 1
}

# map_cases <dir> <phrase>... — jest_cases over <dir>, then (from the same run's JSON report) each phrase's
# own passing test lives in a test file that value-imports the map the app mounts — TransitMap
# (src/ui/map/TransitMap.tsx) or the Map route (src/app/(tabs)/index.tsx) — and RENDERS that binding as a JSX
# element (TypeScript AST: `import type`, a bare mention like expect(TransitMap), comments and strings do not count). So the tap / legend /
# location cases test what the Map tab mounts, not an unmounted look-alike component.
map_cases() {
  local dir="$1" report
  jest_cases "$@" || return 1
  report="$PWD/.cache/ratchet/mfix3_map_feel.$(printf '%s' "$dir" | tr '/' '_').json"
  shift
  node - "$report" "$#" "$@" "${MFIX3_JEST_CASES[@]}" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [report, count, ...rest] = process.argv.slice(2);
const wanted = rest.slice(0, Number(count)).map((s) => s.toLowerCase());
const universe = rest.slice(Number(count)).map((s) => s.toLowerCase());
const ends = (name, p) => name === p || name.endsWith(' ' + p);
const MAPS = [path.join(ROOT, 'src/ui/map/TransitMap.tsx'), path.join(ROOT, 'src/app/(tabs)/index.tsx')];
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolveSpec(from, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
  return hit === undefined ? null : hit;
}
function mountsMap(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly || !MAPS.includes(resolveSpec(file, s.moduleSpecifier.text))) continue;
    const c = s.importClause, nb = c.namedBindings;
    if (c.name) names.push(c.name.text);
    if (nb && ts.isNamespaceImport(nb)) names.push(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) names.push(e.name.text);
  }
  const stack = [sf];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) {
    const n = stack.pop();
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && names.includes(n.tagName.getText(sf))) return true;
    ts.forEachChild(n, (k) => { stack.push(k); });
  }
  return false;
}
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const problems = [];
for (const w of wanted) {
  const files = r.testResults.filter((t) => t.assertionResults.some((a) => {
    const name = a.fullName.toLowerCase().replace(/\s+/g, ' ').trim();
    return a.status === 'passed' && ends(name, w) && universe.every((o) => o === w || !ends(name, o));
  })).map((t) => t.name);
  if (!files.some(mountsMap)) problems.push(`"${w}" is proven only in ${files.map((f) => path.relative(ROOT, f)).join(', ') || '(no file)'}, which never value-imports AND renders (<TransitMap …/> or <MapScreen …/>) TransitMap or the Map route (src/app/(tabs)/index.tsx)`);
}
if (problems.length > 0) { problems.forEach((p) => console.log(`ratchet: ${p}`)); fail('the tap / legend / location cases must test what the Map tab mounts'); }
console.log(`ratchet: ${wanted.length} case(s), each proven in a test file that renders TransitMap or the Map route`);
NODE
}

# The card's own modules and test files: the guard for the repo-wide gates (a bare full_gate is green on
# the unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files src/ui/map/markerLanes.ts src/ui/map/MapLegend.tsx src/ui/map/use-user-location.ts \
    src/ui/map/__tests__/vehicleMotion.test.ts src/ui/map/__tests__/markerLanes.test.ts \
    src/ui/map/__tests__/liveStaleness.test.ts || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built (m5c) that this card's
# edits could break, run only WITH this card's files in the tree: on the unbuilt tree it fails clean
# (every gate of a card must), and once built it guards m5c's wiring against this card's changes.
after_card() {
  [ "$#" -ge 1 ] || { echo "ratchet: after_card needs a gate to run"; return 1; }
  card_files || return 1
  "$@" || return 1
}

# card_full_gate — npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest, node:test)
# green WITH this card's files in the tree.
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# export_carries <text> — guarded on this card's files: Metro bundles the app for iOS (lib.sh ios_export,
# the plan's Hermes export) AND a --no-bytecode export of the same app carries the text, proof the legend
# is reachable from a route. Never grepped in the Hermes .hbc: its string table packs strings back to
# back, so bytes can appear across unrelated strings (m5b/m5c finding, 2026-10-01; verify-m5c gate 23).
# Both exports run on a PRIVATE Metro cache (TMPDIR): a shared-cache export registered only 4 routes on a
# correct build in mfix2's gate (arbiter, 2026-10-01; the m10b/mfix2 pattern).
export_carries() {
  local text="$1" dir=.cache/export-mfix3-js metro_tmp="$PWD/.cache/metro-tmp-mfix3" out rc=0
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  grep -rqF -- "$text" "$dir/_expo/static/js/ios" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: the iOS JS bundle does not contain \"$text\" — the map legend is not reachable from a route (dead code) or lost its row"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1
}

# transitmap_tests_untouched — m5c's TransitMap.test.tsx must stay byte-identical (the note: "must stay green
# UNEDITED" — the location hook has to treat jest-expo's undefined permission answer as denied rather than
# the test being bent to suit it). Pinned to its sha256 at da31592 (arbiter, 2026-10-01).
transitmap_tests_untouched() {
  local f=src/ui/map/__tests__/TransitMap.test.tsx want=2ae0d1d19cdef24acb79e21090dfa13012f1191463cfb4b78c2fe6acbba9b694 got
  card_files || return 1
  need_file "$f" || return 1
  got=$(shasum -a 256 "$f" | cut -d' ' -f1) || { echo "ratchet: cannot hash $f"; return 1; }
  [ "$got" = "$want" ] || { echo "ratchet: $f was edited (sha256 $got, expected $want) — m5c's TransitMap tests must stay green unedited"; return 1; }
  echo "ratchet: $f is unedited"
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix3_map_feel gate failed at verify script line $LINENO"' ERR

# --- §1 Mover freeze: a time-based clamp, and a projection that runs out holds AT a station ---
# 1. One passing test each (vehicleMotion.test.ts), on the REAL no-dwell Mover trip 4829149 from assets/db/schedule.db (arr = dep, stops 60 s apart: 48 m @0 s, 499 m @60 s, 875 m @120 s, 1200 m @180 s, 1454 m @240 s): an on-time fix half-way 499->875 m, aged 10 s at fetch -> framesAt sampled every 1 s with no new poll, its place strictly increases every second for 60 s (today it freezes mid-track 20 s past 875 m); Transitland, a rail leg whose next stop the timetable reaches at fetchedAt + 89.5 s and the following one at + 150 s -> still advancing at fetchedAt + 89 s, within 1 m of that stop from + 90 s on and not past it at + 120 s (the clamp is fetchedAt + cadence + 30 s; today it coasts 20 s past the stop); trip 4829149, on-time fix AT 499 m aged 10 s -> from fetchedAt + 50 s (875 m reached) to + 120 s the marker is within 1 m of 875 m: the clamp (+ 90 s) ran out mid-leg, so it holds at the last stop reached, never mid-track (today frozen near 624 m).
jest_cases src/ui/map/__tests__/vehicleMotion.test.ts 'a mover keeps moving every second for 60 s between polls' 'the projection runs until 30 s after the next poll was due' 'a projection that runs out holds at a station'

# --- §2 Teleport on a new poll: eased corrections, position carried across a trip change ---
# 2. One passing test each (vehicleMotion.test.ts): marker at X, a new fix projecting to X+150 m -> the first 250 ms tick moves it less than 150 m and it is within 1 m of the target by 1.25 s; a correction of 500 m or more snaps (a GUARD: it already passes on today's >= 50 m snap); marker at X, a new fix projecting to X-200 m -> no tick moves it backward, it holds at X until the new projection passes X and then moves on with it (today: snaps 200 m back); when the plan re-matches the vehicle to its next trip, the first frame on the new trip is within 10 m of the last frame on the old one (today: placed afresh, 189 m jump seen on Inner Loop car 51).
jest_cases src/ui/map/__tests__/vehicleMotion.test.ts 'a 150 m correction eases in under 1.25 s' 'a correction of 500 m or more snaps' 'a 200 m backward correction holds the marker' 'a trip change carries the marker without a jump'
# 3. The motion cases run through the frames module the map runs: vehicleMotion.test.ts value-imports AND calls planFrames and framesAt from src/ui/map/vehicleFrames (AST; a type-only import or a mention does not count), not only a reconcile helper.
motion_test_wired
# 4. (guarded on this card's files) Easing stays frame-tick motion along the track: tickPlan/reconcileLive/useVehicleFrames still wired, and no AnimatedRegion under src/ui or src/app (m5c's frames_wired, re-checked).
after_card frames_wired

# --- §3 Markers in their line's lane ---
# 5. One passing test each (markerLanes.test.ts): G and O at the same trunk place, per zoom bucket -> at least 0.9 lane widths apart and each within 1 m of its own drawn line (today 0.0 m apart, each halfway between the drawn lines); the same for Mover lines on shared track downtown; a marker on UNSHARED track (a G train north of the trunk, where only G is drawn) lies within 1 m of its own drawn line at every zoom bucket (kills a fixed per-line offset: the drawn line there has no lane shift).
jest_cases src/ui/map/__tests__/markerLanes.test.ts 'g and o markers at one trunk place are at least 0.9 lane widths apart at every zoom bucket' 'each trunk marker lies within 1 m of its own drawn line at every zoom bucket' 'mover markers on shared track sit in their own lanes' 'a marker on unshared track lies within 1 m of its own drawn line at every zoom bucket'
# 6. src/ui/map/markerLanes.ts computes trip-track lanes with the lines' own lane layout (its value-import closure holds src/ui/map/lineLayout.ts) and the Map route's value-import closure holds markerLanes.ts (an unmounted importer does not count).
lanes_wired

# --- §4 "Sometimes live": the arbiter's RELATIVE staleness rule (diagnosis §4, binding) ---
# 7. The rule's numbers live in src/domain/live/constants.ts, one passing test each (constants.test.ts): Transitland — a vehicle is stale when it lags its own feed header by > 90 s; the feed (pill) is Live while the header is <= 180 s old; drop only when the feed is > 300 s old or the vehicle lags it by > 300 s. Swiftly, same rule — lag 60 s, feed live 75 s, drop 150 s.
jest_cases src/domain/live/__tests__/constants.test.ts 'transitland staleness lag 90 live 180 drop 300' 'swiftly staleness lag 60 live 75 drop 150'
# 8. Pill and markers agree, one passing test each (liveStaleness.test.ts): (a) header 120 s old, vehicles 10 s behind it, judged over the next 60 s -> no marker stale, none dropped, pill "Live"; (b) one vehicle 136 s behind a 27 s old header -> that marker stale, the others solid; (b2) 91 s behind a fresh header -> stale, 90 s behind -> solid (today both solid: absolute ages under 150 s); (c) header 200 s old, vehicles 20 s behind it -> pill "Live · 3 min old" AND every vehicle still drawn AND every marker stale (today they are dropped at 210 s).
jest_cases src/ui/map/__tests__/liveStaleness.test.ts 'a 120 s old feed with vehicles 10 s behind stays live for the next 60 s' 'a vehicle 136 s behind a 27 s old feed is stale and the others solid' 'a vehicle 91 s behind a fresh feed is stale and one 90 s behind is solid' 'a 200 s old feed reads live 3 min old and every marker is stale'
# 9. The new drop rule, one passing test each (liveStaleness.test.ts): a 290 s old feed with vehicles 5 s behind keeps every vehicle (drawn, stale; today dropped past 210 s); a feed over 300 s old drops its vehicles, and a vehicle over 300 s behind a fresh feed is dropped while one exactly 300 s behind is kept.
jest_cases src/ui/map/__tests__/liveStaleness.test.ts 'a 290 s old feed keeps its vehicles' 'a feed over 300 s old or a vehicle over 300 s behind it is dropped'
# 10. The staleness cases judge the pill and the markers through the modules the map runs: liveStaleness.test.ts value-imports AND calls statusConditions + statusFace (src/ui/dataStatus: the pill), planFrames + framesAt (src/ui/map/vehicleFrames: the §4 merge that drops, the frames the markers draw) and vehicleVisual (src/ui/map/vehicleVisual: the drawn stale look) — AST, so a type-only import or a stub that never runs them fails.
staleness_test_wired

# --- §5 Taps name things; a legend; you-are-here ---
# 11. One passing test each under src/ui/map, each in a test file that value-imports and RENDERS (JSX) TransitMap or the Map route (src/app/(tabs)/index.tsx): a station tap shows the station's name at once (e.g. the Marker's title callout or a glass label) AND still reports the station key to onPress (m6b opens the station sheet on that same tap); a line tap shows its name ("Green Line", "Metromover Omni") and a tap on the shared trunk shows both names — both driven through the MapView's onPress with a coordinate (Apple Maps: our own hit test of the drawn lines within the tap tolerance; react-native-maps 1.27.2 fires a Polyline's onPress only for the ONE nearest line within 10 px and `tappable` is Google-Maps-only on iOS); a map press farther than the tolerance from every drawn line names no line; a live vehicle tap shows e.g. "Green Line train to Dadeland South · live, 40 s ago"; a scheduled one says "timetable estimate"; a vehicle tap still reports the vehicle to onPress (m6b's vehicle sheet).
map_cases src/ui/map 'a station tap shows the station name' 'a station tap still reports the station' 'a line tap shows the line name' 'a shared trunk tap shows both line names' 'a map press away from every line names no line' 'a live vehicle tap shows line, destination and live age' 'a scheduled vehicle tap says timetable estimate' 'a vehicle tap still reports the vehicle'
# 12. One passing test each under src/ui/map, each in a test file that value-imports and RENDERS (JSX) TransitMap or the Map route: the control stack's legend (ⓘ) button opens the map legend; the legend explains every marker kind (lettered squares = Metrorail trains G Green / O Orange, dots = Metromover cars by loop colour, solid = live, hollow = timetable estimate, faded with a clock = last seen a while ago).
map_cases src/ui/map 'the legend button opens the map legend' 'the legend explains every marker kind'
# 13. One passing test each under src/ui/map, each in a test file that value-imports and RENDERS (JSX) TransitMap or the Map route: granted -> the MapView gets showsUserLocation; the control stack's locate-me button moves the camera to the user's fix (MapView ref: animateCamera/animateToRegion — showsMyLocationButton is Google-only on iOS in react-native-maps 1.27.2); denied -> no dot, one line of explanation, no throw; a permission request that resolves undefined (jest-expo's automatic expo-location mock) or rejects counts as denied: no dot, no throw.
map_cases src/ui/map 'the map shows the user location once permission is granted' 'locate me centres the map on the user' 'location denied shows no dot and one line of explanation' 'a missing or failed location permission answer counts as denied'
# 14. The legend is a real module reached from the map: src/ui/map/MapLegend.tsx, imported by a map module or a route.
legend_wired
# 15. The user location comes through the existing expo-location foreground-permission flow: non-test src/ui/map code CALLS requestForegroundPermissionsAsync (AST — a comment naming it does not count), src/ui/map/use-user-location.ts value-imports expo-location, and the Map route's value-import closure holds use-user-location.ts (an unmounted importer does not count).
location_wired
# 16. (guarded on this card's files) The Layers button still opens the Layers sheet (m5c gate 11's pin, re-checked: this card adds buttons to the control stack).
after_card jest_nonempty src/ui/map 'MapControlStack.*layers button opens the layers sheet$'
# 17. (guarded on this card's files) The map tests mock only native packages, each labelled '// test-time mock of native module' (m5c's helper; expo-location joins react-native-maps).
after_card mocks_native_only src/ui/map/__tests__

# --- Repo-wide ---
# 18. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test — all green.
card_full_gate
# 19. Metro bundles the app for iOS and its --no-bytecode JS carries the legend row "Last seen a while ago" (the legend is reachable from a route).
export_carries 'Last seen a while ago'
# 20. (guarded on this card's files) m5c's TransitMap.test.tsx is byte-identical to da31592 (it stays green unedited).
transitmap_tests_untouched

echo "mfix3_map_feel: all 20 gates green"
