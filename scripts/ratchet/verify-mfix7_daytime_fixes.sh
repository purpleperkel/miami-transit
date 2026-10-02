#!/usr/bin/env bash
# mfix7_daytime_fixes — Jamie's 07:10 screen recordings (2026-10-02; arbiter diagnosis
# .cache/reseq-inputs/video-0702-diagnosis.md, binding), four fixes:
# (1) WALK-ONLY ANSWERS: when walking beats every train, Transitous answers only in `direct[]` (itineraries: 0) and the
#     app's parser drops it, so the sheet says "No route options" for an 8-minute walk. direct[] becomes walk-only
#     options (same Itinerary shape, WALK legs only, realTime false), listed and sorted by arrival with the transit
#     options; the unavailable state only when BOTH are empty (or the request failed); the walk's detail hands it to
#     Apple Maps walking directions (dirflg=w).
# (2) ADD-TRIP PICKERS: "Leaving from" nearest-first through the ONE location provider (mfix6) and m6b's orderStations;
#     "Going to" lists reachable destinations first and every unreachable one in ONE trailing "Needs a transfer" group.
# (3) STATIONS TAB: with a location, a "Nearby" section first — the 3 nearest stations of ANY mode, with distances and
#     inline next departures — then the mode groups as today; without one, unchanged; still zero live calls (m6b R7).
# (4) STATION SHEET HURRY (coordinator, from the Brickell City Centre recording): while a live key is saved and the
#     station's FIRST live predictions fetch is in flight, the hurry card says "Checking live times…" (no verdict, no
#     haptic) instead of flashing a timetable verdict that flips ~1 s later; live verdict on arrival; the scheduled
#     verdict (Scheduled badge) after LIVE_CHECK_TIMEOUT_MS (<= 4 s) or at once without a key.
# FIXTURE-ONLY: no gate calls the network. PUBLIC-REPO DATA RULE: the committed direct-only fixture carries no
# legGeometry and no step polyline (OSM-derived, ODbL) and a top-level _provenance, as m10a's fixture does.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not stop the
# script); compound checks live inside the card helpers below. Helpers read no variable that another gate set (the
# MFIX7_* values are fixed text). Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and
# stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix7_daytime_fixes.sh
#
# TEST-NAME CONVENTION (verify-mfix6's, verbatim): each acceptance case is its OWN passing jest test whose full name
# (describe titles + test title, joined by one space, compared case-insensitively) ENDS with the case's exact phrase,
# starting at a word boundary. Phrases are plain text. No phrase of this card ends with another (checked on every
# call), so one catch-all test proves at most one case.

# ---- fixed card data (read by helpers; no gate sets them) ----

# The CARD-WIDE universe of jest acceptance phrases.
MFIX7_JEST_CASES=(
  'a direct-only plan answer parses into a walk-only itinerary'
  'a walk-only option shows its walk minutes with no live badge and no hurry chip'
  'a mixed answer lists transit and walk-only options sorted by arrival'
  'route options are unavailable only when itineraries and direct are both empty'
  'a walk-only option detail opens apple maps walking directions with dirflg=w'
  'leaving from lists the nearest stations first when the location is known'
  'leaving from keeps the schedule order without a location'
  'going to lists every reachable destination before any unreachable one'
  'going to gathers every unreachable station in one trailing needs a transfer group'
  'with a location the stations tab opens on a nearby section of the 3 nearest stations of any mode'
  'nearby rows show their walking distance and next departures inline'
  'at a mixed point the nearby section lists both metromover and metrorail stations'
  'without a location the stations tab shows no nearby section'
  'with a location the stations list still makes no live prediction calls'
  'while the first live fetch is in flight the hurry card says checking live times and fires no haptic'
  'when live predictions arrive the hurry card shows the live verdict'
  'when live predictions miss the timeout the hurry card falls back to the scheduled verdict'
  'without a live key the hurry card shows the scheduled verdict at once'
)
# The test files this card adds (one per fix; fix 1 has a domain and a UI file) and its committed fixture.
MFIX7_DOMAIN_TEST=src/domain/routes/__tests__/transitous-direct.test.ts
MFIX7_ROUTES_TEST=src/ui/routes/__tests__/walk-only.test.tsx
MFIX7_PICKERS_TEST=src/ui/trips/__tests__/add-trip-pickers.test.tsx
MFIX7_NEARBY_TEST=src/ui/stations/__tests__/stations-nearby.test.tsx
MFIX7_CHECKING_TEST=src/ui/hurry/__tests__/checking-live.test.tsx
MFIX7_FIXTURE=src/domain/routes/__fixtures__/transitous-direct-only.json
# The fixture as the arbiter committed it with this card (built from the 08:15 direct-only capture, stripped).
MFIX7_FIXTURE_SHA=2f1ae3fa242a6859b0fe56ef8f45b026e9e02489c0a669726498eaade08e6b65
M10A_FIXTURE=src/domain/routes/__fixtures__/transitous-plan.json
# The hook that owns the station sheet's verdict (m7c) and the copy module the "Checking" line lives in.
MFIX7_HURRY_HOOK=src/ui/hurry/useHurryVerdict.ts
MFIX7_HURRY_COPY=src/ui/hurry/copy.ts
MFIX7_CHECKING_TEXT='Checking live times…'

# The REAL components a case's test file must value-import AND render (file#export; '#default' = the route's default
# export), and the provider it must render them inside ('-' = none). TypeScript AST: `import type`, a bare mention,
# comments and strings never count.
REAL_OPTIONS='src/ui/routes/RouteOptionsList.tsx#RouteOptionsList src/ui/routes/PlanScreen.tsx#PlanBody src/ui/routes/PlanScreen.tsx#PlanScreen src/app/plan.tsx#default'
REAL_SHEET='src/ui/routes/PlanScreen.tsx#PlanBody src/ui/routes/PlanScreen.tsx#PlanScreen src/app/plan.tsx#default'
REAL_DETAIL='src/ui/routes/ItineraryDetail.tsx#ItineraryDetail src/ui/routes/PlanScreen.tsx#PlanBody src/ui/routes/PlanScreen.tsx#PlanScreen src/app/plan.tsx#default'
REAL_FROM='src/ui/trips/add/AddTripSteps.tsx#FromStep src/app/trip/new/from.tsx#default'
REAL_TO='src/ui/trips/add/AddTripSteps.tsx#ToStep src/app/trip/new/to.tsx#default'
REAL_STATIONS='src/ui/stations/StationsScreen.tsx#StationsScreen src/app/(tabs)/stations/index.tsx#default'
REAL_HURRY='src/ui/hurry/StationHurry.tsx#StationHurry src/app/station/[stationKey].tsx#default'
IN_LOCATION='src/ui/location/UserLocationProvider.tsx#UserLocationProvider'
IN_LIVE='src/live/live-context.tsx#LiveValueProvider src/live/live-context.tsx#LiveDataProvider'

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied VERBATIM from verify-mfix6_one_location_watch.sh (only the card universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX7_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix7_daytime_fixes.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX7_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX7_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX7_JEST_CASES[@]}" || return 1
}


# need_files and mocks_native_only: copied VERBATIM from verify-mfix6_one_location_watch.sh (its own provenance below).
# need_files: copied VERBATIM from verify-mfix3_map_feel.sh (m5c's card helpers). mocks_native_only: mfix3's helper
# EXTENDED (never weakened): jest.setMock / jest.unstable_mockModule count as mocks, and jest.spyOn on an app module
# (its namespace/default import, a require()/jest.requireActual() of it, or the call inline) is refused.

# need_files <file>... — lib.sh's need_file for each.
need_files() {
  local f
  [ "$#" -ge 1 ] || { echo "ratchet: need_files needs at least one path"; return 1; }
  for f in "$@"; do need_file "$f" || return 1; done
}

# Every jest.mock / jest.doMock / jest.setMock / jest.unstable_mockModule in the tests targets a PACKAGE — never an app module ('@/…',
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
  const APP = /^(@\/|\.|src\/)/;
  // jest.spyOn(x, …) where x is an app module or an export of one: the module inline, or a binding (import * as /
  // default / named import, require / jest.requireActual).
  for (const m of text.matchAll(/\bjest\.spyOn\(\s*(?:(?:jest\.requireActual|require)\(\s*(['"`])([^'"`]*)\1|([A-Za-z_$][\w$]*))/g)) {
    const where = `${path.join(dir, rel)}:${text.slice(0, m.index).split("\n").length}`;
    const id = m[3] === undefined ? null : m[3].replace(/[$]/g, "\\$");
    const bound = id === null ? [m[2]] : [
      ...text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+${id}\\b|${id}\\b|[^;]*?\\{[^}]*\\b${id}\\b[^}]*\\})[^;]*?from\\s*(['"\`])([^'"\`]*)\\1`, "g")),
      ...text.matchAll(new RegExp(`\\b${id}\\s*=\\s*(?:jest\\.requireActual|require)\\(\\s*(['"\`])([^'"\`]*)\\1`, "g")),
    ].map((b) => b[2]);
    for (const mod of bound) if (APP.test(mod)) problems.push(`${where}: jest.spyOn on app module '${mod}' — only native modules may be mocked`);
  }
  for (const m of text.matchAll(/\bjest\.(?:mock|doMock|setMock|unstable_mockModule)\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    mocks += 1;
    const lineNo = text.slice(0, m.index).split("\n").length;
    const where = `${path.join(dir, rel)}:${lineNo}`;
    const mod = m[2];
    if (mod === undefined) {
      problems.push(`${where}: the jest.mock target is not a string literal`);
      continue;
    }
    if (APP.test(mod)) problems.push(`${where}: mocks app module '${mod}' — only native modules may be mocked`);
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

# _mfix7_ast <cmd> <args>... — checks over the TypeScript AST (comments are trivia, never nodes, so a comment naming a
# thing never satisfies them). verify-mfix6's _mfix6_ast pattern (parse, explicit-stack walk, resolveSpec), no recursion.
#   renders <test> <real-specs> <wrapper-specs|-> <phrase>...
#        <test> value-imports (default, named or namespace; never `import type`) at least one REAL component of
#        <real-specs> ("file#export" words, '#default' = the default export), and for EACH phrase an it()/test() whose
#        full name (describe titles + title) ends with it has, in its OWN code — its callback plus the local helper
#        functions it calls and local variables it reads, transitively — a JSX element of that component — with <wrapper-specs>, lexically INSIDE a JSX element of a
#        wrapper value-imported the same way. Another test of the file rendering it never counts (prover, 2026-10-02).
#   test_holds <test> <phrase> <lit|lit|...>
#        an it()/test() whose full name ends with <phrase> holds, in its own code (as for renders), a
#        string or numeric literal for every '|'-separated text (a leading '-' is the unary minus, matched on the number).
#   imports_value <dir> <export> <target>
#        some non-test .ts/.tsx under <dir> value-imports <export> from a specifier resolving to <target>.
#   file_imports <file> <export> <target>
#        <file> (a test file may be named) value-imports <export> from a specifier resolving to <target>.
#   exported_ms <file> <name> <max>
#        <file> holds `export const <name> = <numeric literal>` with 0 < value <= <max>.
#   has_string <file> <text>
#        <file>'s code holds a string literal (or a template without substitutions) whose text is exactly <text>.
_mfix7_ast() {
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, target, a, b, ...rest] = process.argv.slice(2);
if (!fs.existsSync(target)) fail(`missing ${target}`);
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function nodes(root) {
  const out = [], stack = [root];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (k) => { stack.push(k); }); }
  return out;
}
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolveSpec(from, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return spec;
  const hit = EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
  return hit === undefined ? null : path.relative(ROOT, hit).split(path.sep).join('/');
}
function appFiles(dir) {
  const files = [], todo = [dir];
  for (let g = 0; todo.length > 0 && g < 20000; g += 1) {
    const p = todo.pop();
    if (fs.statSync(p).isDirectory()) { if (path.basename(p) !== '__tests__') for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p.split(path.sep).join('/'));
  }
  return files;
}
// The JSX tag names under which <file> value-imports any of `specs` ("file#export" words): `X`, or `ns.export`.
function tagsFor(file, sf, specs) {
  const want = specs.split(/\s+/).filter(Boolean).map((w) => { const i = w.lastIndexOf('#'); return [w.slice(0, i), w.slice(i + 1)]; });
  if (want.length === 0 || want.some(([f, e]) => f === '' || e === '')) fail(`verify-script authoring error: bad spec list "${specs}"`);
  const tags = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    const to = resolveSpec(file, s.moduleSpecifier.text), c = s.importClause, nb = c.namedBindings;
    for (const [f, e] of want.filter(([f]) => f === to)) {
      if (c.name && e === 'default') tags.push(c.name.text);
      if (nb && ts.isNamespaceImport(nb)) tags.push(`${nb.name.text}.${e}`);
      if (nb && ts.isNamedImports(nb)) for (const x of nb.elements) if (!x.isTypeOnly && (x.propertyName ?? x.name).text === e) tags.push(x.name.text);
    }
  }
  return tags;
}
const isTag = (sf, n, tags) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && tags.includes(n.tagName.getText(sf));
if (cmd === 'renders' || cmd === 'test_holds') {
  const sf = parse(target), all = nodes(sf);
  const isBlock = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['describe', 'it', 'test'].includes(n.expression.text) && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0]);
  const fullName = (t) => { const parts = []; for (let p = t, g = 0; p !== undefined && g < 5000; p = p.parent, g += 1) if (isBlock(p)) parts.unshift(p.arguments[0].text); return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim(); };
  const testsFor = (phrase) => { const w = phrase.toLowerCase(); const hits = all.filter((n) => isBlock(n) && n.expression.text !== 'describe' && (fullName(n) === w || fullName(n).endsWith(` ${w}`))); if (hits.length === 0) fail(`${target} has no it()/test() (static title) whose full name ends with '${phrase}'`); return hits; };
  // The file's local bindings by name: function declarations, and variables with an initializer (a helper function, or
  // a const such as a test position) — what a test's own code may call or read. Bindings declared INSIDE an it()/test()
  // callback are that test's own code only (a sibling's `tree` must never count for another test of the same name).
  const inTest = (n) => { for (let p = n.parent, g = 0; p !== undefined && g < 5000; p = p.parent, g += 1) if (isBlock(p) && p.expression.text !== 'describe') return true; return false; };
  const defs = new Map();
  for (const n of all) {
    const d = inTest(n) ? null : ts.isFunctionDeclaration(n) && n.name ? [n.name.text, n] : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer ? [n.name.text, n.initializer] : null;
    if (d !== null) defs.set(d[0], [...(defs.get(d[0]) ?? []), d[1]]);
  }
  // A test's own code: its callback plus every local function it calls and local variable it reads, transitively
  // (bounded worklist), as nodes. Another test's code is never reached (tests are not named bindings).
  const ownCode = (t) => { const seen = new Set([t.arguments[t.arguments.length - 1]]), todo = [...seen]; for (let g = 0; todo.length > 0 && g < 2000; g += 1) for (const n of nodes(todo.pop())) if (ts.isIdentifier(n)) for (const f of defs.get(n.text) ?? []) if (!seen.has(f)) { seen.add(f); todo.push(f); } return [...seen].flatMap((body) => nodes(body)); };
  if (cmd === 'test_holds') {
    const lits = String(b ?? '').split('|').filter(Boolean);
    if (lits.length === 0) fail('verify-script authoring error: test_holds needs literals');
    const ok = testsFor(a).some((t) => { const seen = new Set(ownCode(t).filter((n) => ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)).map((n) => n.text)); return lits.every((l) => seen.has(l.replace(/^-/, ''))); });
    if (!ok) fail(`${target}: no test for '${a}' holds all of ${lits.join(', ')} in its own code (callback or local helpers it calls)`);
    console.log(`ratchet: ${target}: the test for '${a}' holds ${lits.join(', ')}`);
  } else {
    const real = tagsFor(target, sf, a);
    if (real.length === 0) fail(`${target} value-imports none of the real components (${a}) — the case must render what the app shows, not a look-alike`);
    const wrap = b === undefined || b === '-' ? null : tagsFor(target, sf, b);
    if (wrap !== null && wrap.length === 0) fail(`${target} value-imports no provider of ${b} — the real component must be rendered inside it`);
    if (rest.length === 0) fail('verify-script authoring error: renders needs at least one phrase');
    const inside = (n) => { if (wrap === null) return true; for (let p = n.parent, g = 0; p !== undefined && g < 5000; p = p.parent, g += 1) if (ts.isJsxElement(p) && isTag(sf, p.openingElement, wrap)) return true; return false; };
    for (const phrase of rest) {
      if (!testsFor(phrase).some((t) => ownCode(t).some((n) => isTag(sf, n, real) && inside(n)))) fail(`${target}: the test for '${phrase}' never renders <${real.join('>/<')}>${wrap === null ? '' : ` inside <${wrap.join('>/<')}>`} in its OWN callback or a local helper it calls — another test rendering it does not count`);
    }
    console.log(`ratchet: ${target}: each of ${rest.length} case(s) renders the real ${real.join('/')}${wrap === null ? '' : ' inside its provider'} in its own test`);
  }
} else if (cmd === 'imports_value') {
  if (!fs.existsSync(b)) fail(`missing ${b}`);
  const hits = appFiles(target).filter((f) => parse(f).statements.some((s) => ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly
    && resolveSpec(f, s.moduleSpecifier.text) === b && s.importClause.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some((x) => !x.isTypeOnly && (x.propertyName ?? x.name).text === a)));
  if (hits.length === 0) fail(`no non-test module under ${target} value-imports ${a} from ${b} (reuse it, do not re-implement it)`);
  console.log(`ratchet: ${hits.join(', ')} value-import(s) ${a} from ${b}`);
} else if (cmd === 'file_imports') {
  if (tagsFor(target, parse(target), `${b}#${a}`).length === 0) fail(`${target} does not value-import ${a} from ${b}`);
  console.log(`ratchet: ${target} value-imports ${a} from ${b}`);
} else if (cmd === 'exported_ms') {
  const sf = parse(target), max = Number(b);
  const decl = sf.statements.filter(ts.isVariableStatement).filter((s) => (s.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && (s.declarationList.flags & ts.NodeFlags.Const))
    .flatMap((s) => s.declarationList.declarations).find((d) => ts.isIdentifier(d.name) && d.name.text === a);
  const v = decl && decl.initializer && ts.isNumericLiteral(decl.initializer) ? Number(decl.initializer.text.replace(/_/g, '')) : NaN;
  if (!(v > 0 && v <= max)) fail(`${target} does not \`export const ${a} = <number>\` with 0 < value <= ${max} (got ${decl === undefined ? 'no such export' : decl.initializer ? decl.initializer.getText(sf) : 'no initializer'})`);
  console.log(`ratchet: ${target} exports ${a} = ${v}`);
} else if (cmd === 'has_string') {
  const sf = parse(target);
  if (!nodes(sf).some((n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === a)) fail(`${target} holds no string literal '${a}' in code`);
  console.log(`ratchet: ${target} holds '${a}'`);
} else fail(`unknown _mfix7_ast command '${cmd}'`);
NODE
}

# The card's own test files and fixture: the guard for every re-check and repo-wide gate (on the unbuilt tree they
# fail clean, naming the first missing test file).
card_files() {
  need_files "$MFIX7_DOMAIN_TEST" "$MFIX7_ROUTES_TEST" "$MFIX7_PICKERS_TEST" "$MFIX7_NEARBY_TEST" "$MFIX7_CHECKING_TEST" "$MFIX7_FIXTURE" || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built (m6b, m7c, mfix6) that this card's edits
# could break, run only WITH this card's files in the tree (verify-mfix6's after_card).
after_card() {
  [ "$#" -ge 1 ] || { echo "ratchet: after_card needs a gate to run"; return 1; }
  card_files || return 1
  "$@" || return 1
}

# rendered_cases <test> <real-specs> <wrapper-specs|-> <phrase>... — EACH phrase's own test renders one of the real
# components in its own callback or a local helper it calls (inside the named provider, if any; _mfix7_ast renders),
# then jest_cases over that one file: each phrase its own passing test there. So a case is proven on what the app
# draws, not on a standalone look-alike or a sibling test's render.
rendered_cases() {
  local test="$1" real="$2" wrap="$3"; shift 3
  need_file "$test" || return 1
  _mfix7_ast renders "$test" "$real" "$wrap" "$@" || return 1
  jest_cases "$test" "$@" || return 1
}

# mfix7_node <label> <js-body> — verify-mfix5's mfix5_node in shape: the body runs as an ES module with tsx loaded (it
# imports the app's .ts modules as the app does), from the repo root, after JS_PRELUDE; it prints
# 'ratchet: <label>: <reason>' and exits 1 on failure. Network-free: every fetch is the injected fake below.
mfix7_node() {
  local label="$1" body="$2" out
  need_files "$MFIX7_FIXTURE" "$M10A_FIXTURE" src/domain/routes/polite-client.ts src/ui/routes/route-options.ts || return 1
  [ -f node_modules/tsx/package.json ] || { echo "ratchet: tsx is not installed in node_modules"; return 1; }
  out=$(MFIX7_GATE="$label" MFIX7_DIRECT="$MFIX7_FIXTURE" MFIX7_M10A="$M10A_FIXTURE" \
    node --import tsx --input-type=module -e "$JS_PRELUDE"$'\n'"$body" 2>&1) \
    || { echo "$out" | tail -25; echo "ratchet: $label is red"; return 1; }
  echo "$out" | tail -3
}

# Shared by the walk-only checks: named failures; the two REAL bodies (the committed direct-only capture and m10a's
# Government Center -> Brickell answer); `answer(body)` asks the app's REAL polite client (src/domain/routes/
# polite-client.ts — what the sheet calls, whatever parser it uses inside) for the body's own trip with a fake fetch that
# serves `body` (HTTP 200), a fixed clock and an immediate sleep; `walkOnly(it)` = every leg WALK, no trip, not realtime,
# not live; `shifted(direct, s)` = a deep copy with every ISO instant moved by s seconds.
JS_PRELUDE=$(cat <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const E = process.env;
const fail = (m) => { console.log(`ratchet: ${E.MFIX7_GATE}: ${m}`); process.exit(1); };
const check = (cond, m) => { if (!cond) fail(m); };
const same = (got, want, m) => { try { assert.deepStrictEqual(got, want); } catch (e) { console.log(e.message.split('\n').slice(0, 18).join('\n')); fail(m); } };
const load = async (p, names) => {
  let m;
  try { m = await import(p); } catch (e) { return fail(`cannot import ${p}: ${e.message}`); }
  for (const n of names) check(m[n] !== undefined, `${p} does not export ${n}`);
  return m;
};
const DIRECT = JSON.parse(fs.readFileSync(E.MFIX7_DIRECT, 'utf8'));
const M10A = JSON.parse(fs.readFileSync(E.MFIX7_M10A, 'utf8'));
const { PolitePlanClient } = await load('./src/domain/routes/polite-client.ts', ['PolitePlanClient']);
const { parseItineraries } = await load('./src/domain/routes/transitous.ts', ['parseItineraries']);
const { routeOptions, NO_ROUTE_NETWORK } = await load('./src/ui/routes/route-options.ts', ['routeOptions', 'NO_ROUTE_NETWORK']);
const { HURRY_DEFAULTS } = await load('./src/domain/hurry/verdict.ts', ['HURRY_DEFAULTS']);
const PACE = { walkMps: HURRY_DEFAULTS.walkMps, jogMps: HURRY_DEFAULTS.jogMps };
const epochOf = (iso) => Date.parse(iso) / 1000;
async function answer(body) {
  const askS = epochOf((body.itineraries[0] ?? body.direct?.[0] ?? { startTime: '2026-10-02T18:00:00Z' }).startTime);
  const fetch = async () => ({ status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
  const client = new PolitePlanClient({ fetch, clock: () => askS * 1000, sleep: async () => undefined, appVersion: '1.0.0' });
  const q = { from: { latitude: body.from.lat, longitude: body.from.lon }, to: { latitude: body.to.lat, longitude: body.to.lon }, timeEpoch: askS, arriveBy: false };
  let out;
  try { out = await client.plan(q); } catch (e) { return fail(`the polite client threw ${e?.name ?? 'an error'}: ${e?.message ?? e}`); }
  check(out.kind === 'ok', `the polite client answered ${out.kind}${out.reason ? ` (${out.reason})` : ''} for an HTTP 200 /plan body`);
  return out.itineraries;
}
const walkOnly = (it) => it.legs.length > 0 && it.legs.every((l) => l.mode === 'WALK' && l.tripId === null && l.realTime === false && l.live === false);
function shifted(direct, s) {
  const copy = JSON.parse(JSON.stringify(direct)), stack = [copy];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const o = stack.pop();
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(o[k])) o[k] = new Date(Date.parse(o[k]) + s * 1000).toISOString().replace('.000Z', 'Z');
      else if (o[k] !== null && typeof o[k] === 'object') stack.push(o[k]);
    }
  }
  return copy;
}
JS
)

# direct_only_walks — the arbiter's real capture (itineraries: 0, direct: 1, WALK 8 min, 568 m): the polite client
# answers ok with one walk-only itinerary per direct[] entry carrying the walk's real times, duration and distance, and
# routeOptions makes each a walk-only option — no hurry verdict even with a start position, not live, no badges, 480 s
# on foot, no transfers. Today the client answers ok([]) and the sheet says "No route options".
direct_only_walks() {
  local body
  body=$(cat <<'JS'
check(DIRECT.itineraries.length === 0 && DIRECT.direct.length === 1, 'the committed fixture is no longer the direct-only capture');
const its = await answer(DIRECT);
check(its.length === DIRECT.direct.length, `the direct-only answer gave ${its.length} itinerary(ies); want one walk-only itinerary per direct[] entry (${DIRECT.direct.length})`);
check(its.every(walkOnly), 'a direct[] answer must parse into walk-only itineraries (every leg WALK, tripId null, realTime false, live false)');
const raw = DIRECT.direct[0], it = its[0], leg = it.legs[0];
same([it.startEpoch, it.endEpoch, it.durationS, it.transfers, it.legs.length], [epochOf(raw.startTime), epochOf(raw.endTime), 480, 0, 1], 'the walk keeps the capture start, end, 480 s duration, 0 transfers and its one leg');
same([leg.distanceM, leg.durationS, leg.from.latitude, leg.from.longitude, leg.to.latitude, leg.to.longitude], [568, 480, 25.7645, -80.1897, 25.766888, -80.192121], 'the walk leg keeps its 568 m, 480 s and both ends');
const opts = routeOptions(its, NO_ROUTE_NETWORK, { position: { latitude: 25.7645, longitude: -80.1897 }, nowS: it.startEpoch, pace: PACE });
same(opts.map((o) => [o.verdict, o.live, o.badges.length, o.walkS, o.transfers]), [[null, false, 0, 480, 0]], 'the walk-only option has no hurry verdict, is not live, has no badges, walks 480 s with no transfers');
console.log('ratchet: direct-only answer: 1 walk-only option, 8 min on foot, no verdict, not live');
JS
)
  mfix7_node 'direct-only answer' "$body" || return 1
}

# mixed_sorted — m10a's real answer (6 transit itineraries, direct: []) with the capture's walk moved to 18:15–18:23 UTC
# as its direct[]: the client answers 7 itineraries — m10a's six exactly as m10a's parser reads them alone, plus the walk —
# and routeOptions sorts the walk-only option by arrival BETWEEN the 18:21 and 18:24 transit options (index 1).
mixed_sorted() {
  local body
  body=$(cat <<'JS'
const mixed = { ...M10A, direct: shifted(DIRECT.direct, 6 * 3600) };
check(mixed.direct[0].startTime === '2026-10-02T18:15:00Z' && mixed.direct[0].endTime === '2026-10-02T18:23:00Z', 'authoring: the walk did not shift to 18:15–18:23');
const alone = parseItineraries(M10A);
check(alone.ok && alone.value.length === 6, 'the m10a fixture no longer parses into its 6 itineraries');
const its = await answer(mixed);
check(its.length === 7, `the mixed answer gave ${its.length} itineraries; want the 6 of m10a plus the 1 walk`);
same(its.filter((it) => !walkOnly(it)), alone.value, 'the transit itineraries of a mixed answer must be exactly what the m10a parser reads from the same body without direct[]');
same(its.filter(walkOnly).map((it) => [it.startEpoch, it.endEpoch]), [[epochOf('2026-10-02T18:15:00Z'), epochOf('2026-10-02T18:23:00Z')]], 'the mixed answer carries the one walk at its own times');
const askS = epochOf('2026-10-02T18:00:00Z');
const opts = routeOptions(its, NO_ROUTE_NETWORK, { position: null, nowS: askS, pace: PACE });
same(opts.map((o) => o.arriveEpoch - askS), [1260, 1380, 1440, 1560, 1680, 1860, 2160], 'the options are sorted by arrival, the walk (18:23) among the transit options');
same(opts.map((o) => walkOnly(o.itinerary)), [false, true, false, false, false, false, false], 'the walk-only option sits at index 1, between the 18:21 and 18:24 transit options');
console.log('ratchet: mixed answer: 7 options sorted by arrival, the walk second');
JS
)
  mfix7_node 'mixed answer' "$body" || return 1
}

# empty_or_absent — the unavailable state stays for an answer with NOTHING in it: a body with itineraries [] and direct []
# answers ok with zero itineraries (so the sheet shows its unavailable state), and a body WITHOUT a direct key (older
# MOTIS, or a hand-made test body) still reads as before — m10a's six, unchanged. A regression guard (it holds today),
# so it runs only once this card's files exist.
empty_or_absent() {
  local body
  body=$(cat <<'JS'
const none = await answer({ ...M10A, itineraries: [], direct: [] });
check(none.length === 0, `an answer with no itineraries and no direct walk gave ${none.length} itinerary(ies); want 0 (the sheet then says route options are unavailable)`);
const absent = { ...M10A };
delete absent.direct;
const alone = parseItineraries(M10A);
check(alone.ok && alone.value.length === 6, 'the m10a fixture no longer parses into its 6 itineraries');
same(await answer(absent), alone.value, 'a body without a direct key must still read as its itineraries alone');
console.log('ratchet: empty answer: 0 itineraries; no direct key: the 6 itineraries unchanged');
JS
)
  card_files || return 1
  mfix7_node 'empty or absent direct' "$body" || return 1
}

# fixture_clean — PUBLIC-REPO DATA RULE (plan §3, m10a's fixture rule): the committed direct-only fixture is byte-identical
# to the one the arbiter built from the 08:15 capture (sha256 pinned), carries a top-level _provenance (source, captured,
# license, stripped), holds NO legGeometry and NO polyline key at any depth (walking geometry is OSM-derived, ODbL), and is
# still the direct-only answer (itineraries [], direct: one WALK). Guarded on this card's files.
fixture_clean() {
  local got
  card_files || return 1
  got=$(shasum -a 256 "$MFIX7_FIXTURE" | cut -d' ' -f1) || { echo "ratchet: cannot hash $MFIX7_FIXTURE"; return 1; }
  [ "$got" = "$MFIX7_FIXTURE_SHA" ] || { echo "ratchet: $MFIX7_FIXTURE was edited (sha256 $got, expected $MFIX7_FIXTURE_SHA) — the committed capture stays as the arbiter stripped it"; return 1; }
  node - "$MFIX7_FIXTURE" <<'NODE' || return 1
const fx = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const fail = (m) => { console.log(`ratchet: ${process.argv[2]}: ${m}`); process.exit(1); };
const p = fx._provenance;
if (!p || ['source', 'captured', 'license'].some((k) => typeof p[k] !== 'string' || p[k].length < 10) || typeof p.stripped !== 'object') fail('no top-level _provenance with source, captured, license and stripped');
const stack = [fx], banned = [];
for (let g = 0; stack.length > 0 && g < 200000; g += 1) {
  const o = stack.pop();
  for (const [k, v] of Object.entries(o)) { if (k === 'legGeometry' || k === 'polyline') banned.push(k); if (v !== null && typeof v === 'object') stack.push(v); }
}
if (banned.length > 0) fail(`${banned.length} legGeometry/polyline key(s) — walking geometry is OSM-derived (ODbL) and must be stripped`);
if (!Array.isArray(fx.itineraries) || fx.itineraries.length !== 0 || !Array.isArray(fx.direct) || fx.direct.length !== 1 || !fx.direct[0].legs.every((l) => l.mode === 'WALK')) fail('it is no longer the direct-only answer (itineraries [], direct: one walk)');
console.log('ratchet: the direct-only fixture is pinned, has _provenance and no walking geometry');
NODE
}

# earlier_gate <script> <gate command>... — runs gates of an EARLIER card verbatim, through that card's own helpers
# (verify-m7b's closure_links pattern): a fresh bash sources the card's script by its repo-relative path from the repo
# root (this script has cd'd there), so its `dirname "$0"` resolves; each command must pass (|| exit 1).
earlier_gate() {
  local script="$1" cmds; shift
  need_file "$script" || return 1
  [ "$#" -ge 1 ] || { echo "ratchet: earlier_gate needs at least one gate command"; return 1; }
  cmds=$(printf '%s || exit 1\n' "$@")
  bash -c 'source "$0" || exit 1; eval "$1"' "$script" "$cmds" || { echo "ratchet: an earlier gate of $script is red after this card"; return 1; }
}

# stations_no_live — m6b's gates 24 and 25 (R7, REALTIME COST RULE), verbatim: the REAL Stations list makes zero live
# prediction calls (its own test), and nothing the Stations tab imports reaches the live HTTP layer, a live provider or the
# departures parser. The Nearby section must not change that. m6b's StationsScreen.test renders WITHOUT a location (no
# Nearby section), so a LOCATED case is added (prover, 2026-10-02): in the Nearby test, its own test renders the REAL list
# inside UserLocationProvider with a granted fix and, after the render, asserts the live transport spy was not called
# (m6b's _route_graph renders check, verbatim, on that file and phrase).
stations_no_live() {
  earlier_gate scripts/ratchet/verify-m6b_sheets_stations.sh list_makes_no_live_calls list_avoids_live || return 1
  rendered_cases "$MFIX7_NEARBY_TEST" "$REAL_STATIONS" "$IN_LOCATION" 'with a location the stations list still makes no live prediction calls' || return 1
  earlier_gate scripts/ratchet/verify-m6b_sheets_stations.sh "_route_graph renders '$MFIX7_NEARBY_TEST' 'with a location the stations list still makes no live prediction calls'" || return 1
}

# one_location_watch — mfix6's gate 3, verbatim: still exactly ONE module names watchPositionAsync (the provider), and only
# the root layout imports it — the pickers and the Nearby section read the one provider, never a second watch.
one_location_watch() {
  earlier_gate scripts/ratchet/verify-mfix6_one_location_watch.sh one_watch_site || return 1
}

# m7c_copy_still_green — m7c's gates 19–27, verbatim: the plan's hurry copy, byte-exact on the shipped copy and engine,
# the 14-character inline budget, the VoiceOver sentence, and the copy tests' literal strings. "Checking live times…" is
# an addition; no pinned string moves.
m7c_copy_still_green() {
  earlier_gate scripts/ratchet/verify-m7c_hurry_or_chill.sh 'copy_is chill' 'copy_is jog' 'copy_is not_worth_it' 'copy_is missed' \
    'copy_is no_service' 'copy_is inline_jog' 'copy_is inline_max14' 'copy_is sentence' \
    'need_lits src/ui/hurry/__tests__/copy.test.ts "${M7C_COPY_STRINGS[@]}"' || return 1
}

# m7c_hurry_tests_still_green — m7c's gates 37–46 and 69, verbatim: the JOG Warning haptic, HurryCard's named cases
# (badges, hero, label, haptics), labelled native mocks only (the new hurry test lives under src/ui/hurry/__tests__),
# `jest src/ui/hurry` green, and the station sheet route still reaches HurryCard and the hook.
m7c_hurry_tests_still_green() {
  earlier_gate scripts/ratchet/verify-m7c_hurry_or_chill.sh \
    "need_src src/ui/hurry \"from ['\\\"]expo-haptics['\\\"]\" 'NotificationFeedbackType\\.Warning'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'live verdict shows the Live badge'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'scheduled verdict shows the Scheduled badge'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'hero uses the hero variant'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'accessibility label is the VoiceOver sentence'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'JOG fires one Warning haptic per departure'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'JOG fires again for a new departure'" \
    "case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'CHILL fires no haptic'" \
    'native_mocks_labelled src/domain/hurry/__tests__ src/ui/hurry/__tests__' 'jest_nonempty src/ui/hurry' \
    "wired_into 'src/app/station/[stationKey].tsx' 'src/ui/hurry/HurryCard\\.tsx\$' 'src/ui/hurry/useHurryVerdict\\.ts\$'" || return 1
}

# nearby_cases — fix 3's cases (gate 12): rendered_cases over the Nearby test (the REAL StationsScreen or Stations tab route
# inside the one UserLocationProvider, in each case's own test), and the MIXED-point case's own code names the point and
# the three stations it must list (prover, 2026-10-02: at 25.7645,-80.1897 the 3 nearest are all Metromover, so a
# Mover-only Nearby would pass). At 25.7743,-80.1955 orderStations gives mover:government-center 184 m,
# rail:government-ctr 203 m, mover:miami-avenue 217 m (computed on assets/db/schedule.db, 2026-10-02).
nearby_cases() {
  rendered_cases "$MFIX7_NEARBY_TEST" "$REAL_STATIONS" "$IN_LOCATION" 'with a location the stations tab opens on a nearby section of the 3 nearest stations of any mode' \
    'nearby rows show their walking distance and next departures inline' 'at a mixed point the nearby section lists both metromover and metrorail stations' \
    'without a location the stations tab shows no nearby section' || return 1
  _mfix7_ast test_holds "$MFIX7_NEARBY_TEST" 'at a mixed point the nearby section lists both metromover and metrorail stations' \
    '25.7743|-80.1955|mover:government-center|rail:government-ctr|mover:miami-avenue' || return 1
}

# checking_wired — fix 4's shape (TypeScript AST): the hook exports `const LIVE_CHECK_TIMEOUT_MS = <n>` with 0 < n <= 4000
# (the coordinator's "short timeout, <= 4 s, exported constant"); the hurry copy module holds the literal
# 'Checking live times…' (U+2026); and the checking test value-imports LIVE_CHECK_TIMEOUT_MS from the hook, so its
# timeout case steps the app's real constant rather than a number of its own.
checking_wired() {
  _mfix7_ast exported_ms "$MFIX7_HURRY_HOOK" LIVE_CHECK_TIMEOUT_MS 4000 || return 1
  _mfix7_ast has_string "$MFIX7_HURRY_COPY" "$MFIX7_CHECKING_TEXT" || return 1
  need_file "$MFIX7_CHECKING_TEST" || return 1
  _mfix7_ast file_imports "$MFIX7_CHECKING_TEST" LIVE_CHECK_TIMEOUT_MS "$MFIX7_HURRY_HOOK" || return 1
}

# pickers_reuse_order — fix 2 reuses m6b's ONE ordering function: a non-test module of the add-trip flow
# (src/ui/trips/add) value-imports orderStations from src/domain/stations/order-stations.ts (AST), AND the "Leaving
# from" route's value-import closure reaches order-stations.ts (m6b's route_reaches, verbatim) — so an unused module that
# only re-exports it does not count (prover, 2026-10-02). Today neither holds.
pickers_reuse_order() {
  _mfix7_ast imports_value src/ui/trips/add orderStations src/domain/stations/order-stations.ts || return 1
  earlier_gate scripts/ratchet/verify-m6b_sheets_stations.sh "route_reaches src/app/trip/new/from.tsx 'order-stations\.ts\$'" || return 1
}

# card_full_gate — npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest — every existing test incl.
# m10a/m10b/mfix5's routes tests, m6b's Stations tests, m7c's hurry tests, mfix6's one-watch test — and node:test)
# green WITH this card's files in the tree.
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# card_export: verify-mfix6's card_export, verbatim (only the cache name adjusted) — guarded on this card's files, Metro
# bundles the app for iOS (lib.sh ios_export) on a PRIVATE Metro cache (TMPDIR; a shared-cache export registered only 4
# routes on a correct build — mfix2/m10b pattern). No .hbc grep.
card_export() {
  local metro_tmp="$PWD/.cache/metro-tmp-mfix7"
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
}

# card_mocks_native — mocks_native_only (mfix6's, verbatim above) over every test directory this card adds a file to:
# only labelled NATIVE packages are mocked (expo-location, expo-sqlite, expo-haptics, expo/fetch …), never an app module
# (the polite client, the schedule DB provider, the live context, the location provider are the wiring under test), and
# no jest.spyOn on an app module. Guarded on this card's files (the directories pass today).
card_mocks_native() {
  local d
  card_files || return 1
  for d in src/domain/routes/__tests__ src/ui/routes/__tests__ src/ui/trips/__tests__ src/ui/stations/__tests__ src/ui/hurry/__tests__; do
    mocks_native_only "$d" || return 1
  done
}


# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix7_daytime_fixes gate failed at verify script line $LINENO"' ERR

# --- Fix 1: walk-only answers (direct[]) ---
# 1. Through the app's REAL polite client (fake fetch serving the committed direct-only capture, HTTP 200): ok with one walk-only itinerary per direct[] entry (every leg WALK, tripId null, realTime false, live false) keeping the capture's times, 480 s, 0 transfers, 568 m and both ends; routeOptions makes it an option with no hurry verdict (even with a start position), not live, no badges, 480 s walk. Today: ok with 0 itineraries -> "No route options".
direct_only_walks
# 2. Mixed: m10a's real answer with the capture's walk moved to 18:15–18:23 UTC as its direct[] -> 7 itineraries: m10a's six exactly as the parser reads them without direct[], plus the walk; routeOptions sorts by arrival with the walk at index 1 (18:21 < 18:23 < 18:24).
mixed_sorted
# 3. One passing test in src/domain/routes/__tests__/transitous-direct.test.ts: the committed direct-only body parses into a walk-only itinerary.
jest_cases "$MFIX7_DOMAIN_TEST" 'a direct-only plan answer parses into a walk-only itinerary'
# 4. One passing test each in src/ui/routes/__tests__/walk-only.test.tsx, which value-imports and renders the REAL options list (RouteOptionsList, PlanBody / PlanScreen, or the plan route): a walk-only row shows its walk minutes with no Live badge and no hurry chip; a mixed answer's rows are transit and walk-only options sorted by arrival.
rendered_cases "$MFIX7_ROUTES_TEST" "$REAL_OPTIONS" - 'a walk-only option shows its walk minutes with no live badge and no hurry chip' 'a mixed answer lists transit and walk-only options sorted by arrival'
# 5. One passing test (same file, which renders the REAL sheet body: PlanBody / PlanScreen / the plan route): the unavailable state shows for an answer with no itineraries AND no direct walk, and never for the direct-only answer.
rendered_cases "$MFIX7_ROUTES_TEST" "$REAL_SHEET" - 'route options are unavailable only when itineraries and direct are both empty'
# 6. One passing test (same file, rendering the REAL ItineraryDetail or the sheet): the walk-only option's detail opens Apple Maps walking directions (maps://?daddr=…&dirflg=w; success = the openURL promise resolved).
rendered_cases "$MFIX7_ROUTES_TEST" "$REAL_DETAIL" - 'a walk-only option detail opens apple maps walking directions with dirflg=w'
# 7. (guarded on this card's files) Regression guard: an answer with itineraries [] and direct [] is ok with 0 itineraries (the sheet's unavailable state), and a body without a direct key still reads as its 6 itineraries.
after_card empty_or_absent
# 8. (guarded) PUBLIC-REPO DATA RULE: the committed direct-only fixture is sha256-pinned, has a top-level _provenance, no legGeometry and no polyline key at any depth, and is still the direct-only answer.
fixture_clean

# --- Fix 2: the add-trip pickers ---
# 9. One passing test each in src/ui/trips/__tests__/add-trip-pickers.test.tsx, which renders the REAL "Leaving from" step (FromStep or /trip/new/from) inside the one UserLocationProvider: with a location (expo-location a labelled native mock granting a fix) the stations come nearest first; without one (denied) in today's schedule order.
rendered_cases "$MFIX7_PICKERS_TEST" "$REAL_FROM" "$IN_LOCATION" 'leaving from lists the nearest stations first when the location is known' 'leaving from keeps the schedule order without a location'
# 10. One passing test each (same file, rendering the REAL "Going to" step: ToStep or /trip/new/to): every reachable destination is listed before any unreachable one; every unreachable station sits in ONE trailing "Needs a transfer" group (never interleaved), with the existing explanation.
rendered_cases "$MFIX7_PICKERS_TEST" "$REAL_TO" - 'going to lists every reachable destination before any unreachable one' 'going to gathers every unreachable station in one trailing needs a transfer group'
# 11. The add-trip flow reuses m6b's ordering: a non-test module under src/ui/trips/add value-imports orderStations from src/domain/stations/order-stations.ts (AST), and src/app/trip/new/from.tsx's import closure reaches order-stations.ts (m6b's route_reaches).
pickers_reuse_order

# --- Fix 3: the Stations tab's Nearby section ---
# 12. One passing test each in src/ui/stations/__tests__/stations-nearby.test.tsx, which renders the REAL StationsScreen (or the Stations tab route) inside the one UserLocationProvider over the REAL schedule DB: with a location, a "Nearby" section comes FIRST and lists the 3 nearest stations of ANY mode (a Metromover station first although Metrorail is the first mode group), then the mode groups as today; each Nearby row shows its walking distance and its next scheduled departures inline; at the MIXED point 25.7743,-80.1955 the Nearby section lists mover:government-center, rail:government-ctr and mover:miami-avenue — both modes (that case's own code names the point and the three keys); without a location there is no Nearby section (today's list).
nearby_cases
# 13. (guarded) m6b's gates 24 and 25, verbatim (R7, REALTIME COST RULE): the REAL Stations list makes zero live prediction calls, and the Stations tab's imports reach no live HTTP / provider / departures-parser module; PLUS a LOCATED case in the Nearby test (its own test renders the real list inside UserLocationProvider with a fix, then asserts the live spy not called — m6b's per-test render check), so the zero-calls rule covers the Nearby section.
after_card stations_no_live
# 14. (guarded) mfix6's gate 3, verbatim: exactly ONE module names watchPositionAsync (the provider), imported only by the root layout — the pickers and the Nearby section open no second watch.
after_card one_location_watch

# --- Fix 4: the station sheet's hurry card while live times load ---
# 15. One passing test each in src/ui/hurry/__tests__/checking-live.test.tsx, which renders the REAL StationHurry (or the station sheet route) inside a live provider (LiveValueProvider or LiveDataProvider) whose predictions it controls: with a live key saved and the station's FIRST predictions fetch in flight, the card says "Checking live times…" with no verdict and the JOG Warning haptic is NOT fired (although the timetable verdict would be JOG); predictions arriving -> the live verdict (Live badge); no predictions within LIVE_CHECK_TIMEOUT_MS -> the scheduled verdict (Scheduled badge); no live key -> the scheduled verdict at once.
rendered_cases "$MFIX7_CHECKING_TEST" "$REAL_HURRY" "$IN_LIVE" 'while the first live fetch is in flight the hurry card says checking live times and fires no haptic' 'when live predictions arrive the hurry card shows the live verdict' 'when live predictions miss the timeout the hurry card falls back to the scheduled verdict' 'without a live key the hurry card shows the scheduled verdict at once'
# 16. src/ui/hurry/useHurryVerdict.ts exports const LIVE_CHECK_TIMEOUT_MS (0 < n <= 4000); src/ui/hurry/copy.ts holds 'Checking live times…'; the checking test value-imports LIVE_CHECK_TIMEOUT_MS from the hook (AST).
checking_wired
# 17. (guarded) m7c's gates 19–27, verbatim: the plan's hurry copy byte-exact, the 14-character inline budget, the VoiceOver sentence, the copy tests' literal strings.
after_card m7c_copy_still_green
# 18. (guarded) m7c's gates 37–46 and 69, verbatim: the JOG Warning haptic, HurryCard's named cases, labelled native mocks, `jest src/ui/hurry` green, the station route reaches HurryCard and the hook.
after_card m7c_hurry_tests_still_green

# --- Repo-wide ---
# 19. (guarded) Every test directory this card adds to mocks only labelled native packages (no app module, no jest.spyOn on one).
card_mocks_native
# 20. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every existing test), node:test — all green.
card_full_gate
# 21. (guarded) Metro bundles the app for iOS on a private Metro cache (no .hbc grep).
card_export

echo "mfix7_daytime_fixes: all 21 gates green"
