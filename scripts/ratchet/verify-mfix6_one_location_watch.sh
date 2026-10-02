#!/usr/bin/env bash
# mfix6_one_location_watch — ONE app-wide location watch (todo.miami_transit_one_location_watch, m7b builder report
# 2026-10-02): a UserLocationProvider at the root owns the permission ask and the single expo-location
# watchPositionAsync subscription; the map's blue dot / locate-me, the Stations list order, the hurry hook and the
# Now strip all read from it. Today the REAL app (root + tab layout + Map tab, on iOS 26 where react-native-screens
# mounts the BottomAccessory twice, 'regular' and 'inline') opens 4 watches and asks for permission 5 times
# (authoring probe on 5377e46, 2026-10-02).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below. Helpers read no
# variable that another gate set. Run one gate alone, from the repo root (sourcing defines lib.sh +
# the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix6_one_location_watch.sh
#
# TEST-NAME CONVENTION the jest gates rely on (verify-mfix3_map_feel.sh's): each acceptance case is its OWN
# passing jest test whose full name (describe titles + test title, joined by one space, compared
# case-insensitively) ENDS with the case's exact phrase, starting at a word boundary. Phrases are plain text.
# No phrase of this card ends with another, so one catch-all test proves at most one case.

# The CARD-WIDE universe of jest acceptance phrases. Helpers only read it; no gate sets it.
MFIX6_JEST_CASES=(
  'the real tab layout mounts the now strip in both accessory placements'
  'the real app opens exactly one location watch'
  'the real app asks for location permission once'
  'unmounting the real app removes its one location watch'
  'an undefined permission answer opens no watch, shows no dot and does not throw'
  'a denied permission answer opens no watch, shows no dot and does not throw'
  'useUserPosition outside the provider fails loud and opens no watch'
)
# The one test file that renders the REAL app (gates 1, 2, 4).
MFIX6_APP_TEST=src/ui/location/__tests__/one-watch.test.tsx
# The provider module this card adds.
MFIX6_PROVIDER=src/ui/location/UserLocationProvider.tsx

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied from verify-mfix3_map_feel.sh (only the card's universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX6_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix6_one_location_watch.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX6_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX6_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX6_JEST_CASES[@]}" || return 1
}


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


# _mfix6_ast <cmd> <args>... — checks over the TypeScript AST (comments are trivia, never nodes, so a comment naming a
# thing never satisfies or fails them). The house pattern (verify-mfix3 _mfix3_ast); explicit stacks, no recursion.
#   watch_sites <dir>              prints the ONE non-test .ts/.tsx under <dir> whose code names watchPositionAsync
#                                  (an identifier, a property name, or a string such as Location['watchPositionAsync'],
#                                  so an alias or destructure counts); fails unless exactly one module does
#   importers <dir> <target>       prints every non-test .ts/.tsx under <dir> (not <target> itself) holding an import,
#                                  `export … from`, require() or import() whose specifier resolves to <target>, one per
#                                  line (type-only imports count too: no module but the allowed one may name it)
#   imports_renders <file> <name> <target> [<inner>]
#                                  <file> value-imports <name> (default or named, not type-only) from a specifier that
#                                  resolves to <target> (a repo .ts/.tsx path) or IS <target> (a package), and renders
#                                  <name> as a JSX element; with <inner>, a JSX <inner> element sits inside that element
#   real_app <test> <phrase>       <test> value-imports the default exports of the root layout, the (tabs) layout and the
#                                  Map route and inMemoryContext from expo-router; EVERY inMemoryContext call takes one
#                                  object literal mapping '_layout', '(tabs)/_layout' and '(tabs)/index' (once each, no
#                                  spread/computed keys) to exactly those imports; every <ExpoRoot> takes context= such a
#                                  call (or a const holding one); and the test whose full name ends with <phrase> asserts
#                                  inline expect(<query naming 'now-accessory'>).toHaveLength(2) (or toBe/toEqual 2)
_mfix6_ast() {
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, target, a, b, c] = process.argv.slice(2);
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
const NAME = 'watchPositionAsync';
const names = (n) => (ts.isIdentifier(n) && n.text === NAME) || (ts.isStringLiteralLike(n) && n.text === NAME);
function appFiles(dir) {
  const files = [], todo = [dir];
  for (let g = 0; todo.length > 0 && g < 20000; g += 1) {
    const p = todo.pop();
    if (fs.statSync(p).isDirectory()) { if (path.basename(p) !== '__tests__') for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p.split(path.sep).join('/'));
  }
  return files;
}
const specs = (f) => nodes(parse(f)).flatMap((n) => {
  if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) return [n.moduleSpecifier.text];
  if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])
    && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) return [n.arguments[0].text];
  return [];
});
if (cmd === 'importers') {
  if (!fs.existsSync(a)) fail(`missing ${a}`);
  const hits = appFiles(target).filter((f) => f !== a && specs(f).some((s) => resolveSpec(f, s) === a)).sort();
  hits.forEach((h) => console.log(h));
} else if (cmd === 'watch_sites') {
  const files = appFiles(target);
  const hits = files.filter((f) => nodes(parse(f)).some(names)).sort();
  if (hits.length !== 1) fail(`${hits.length} non-test modules under ${target} name ${NAME} (need exactly ONE — the provider's watch): ${hits.join(', ') || '(none)'}`);
  console.log(hits[0]);
} else if (cmd === 'imports_renders') {
  const sf = parse(target);
  const imp = sf.statements.find((s) => ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly && resolveSpec(target, s.moduleSpecifier.text) === b
    && ((s.importClause.name && s.importClause.name.text === a) || (s.importClause.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      && s.importClause.namedBindings.elements.some((e) => !e.isTypeOnly && e.name.text === a))));
  if (imp === undefined) fail(`${target} does not value-import ${a} from ${b} (an \`import type\` does not count)`);
  const tag = (n, t) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === t;
  const outer = nodes(sf).filter((n) => tag(n, a));
  if (outer.length === 0) fail(`${target} imports ${a} but never renders <${a}> as a JSX element`);
  if (c !== undefined && !outer.some((o) => ts.isJsxOpeningElement(o) && nodes(o.parent).some((n) => tag(n, c)))) fail(`${target} renders <${a}> but no <${c}> sits inside it`);
  console.log(`ratchet: ${target} value-imports ${a} from ${b} and renders <${a}>${c === undefined ? '' : ` around <${c}>`}`);
} else if (cmd === 'real_app') {
  const sf = parse(target), all = nodes(sf), phrase = String(a).toLowerCase();
  const WANT = { _layout: 'src/app/_layout.tsx', '(tabs)/_layout': 'src/app/(tabs)/_layout.tsx', '(tabs)/index': 'src/app/(tabs)/index.tsx' };
  const local = {}, ctxNames = [], rootNames = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    const to = resolveSpec(target, s.moduleSpecifier.text), nb = s.importClause.namedBindings;
    for (const [k, w] of Object.entries(WANT)) if (to === w && s.importClause.name) local[k] = s.importClause.name.text;
    if (/^expo-router(\/|$)/.test(s.moduleSpecifier.text) && nb && ts.isNamedImports(nb)) for (const e of nb.elements) {
      if (!e.isTypeOnly && (e.propertyName ?? e.name).text === 'inMemoryContext') ctxNames.push(e.name.text);
      if (!e.isTypeOnly && (e.propertyName ?? e.name).text === 'ExpoRoot') rootNames.push(e.name.text);
    }
  }
  const missing = Object.keys(WANT).filter((k) => local[k] === undefined);
  if (missing.length) fail(`${target} does not value-import the default export of ${missing.map((k) => WANT[k]).join(', ')} — the cases must render the REAL app`);
  if (ctxNames.length === 0) fail(`${target} does not value-import inMemoryContext from expo-router`);
  const at = (n) => `${target}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const isCtx = (n) => n !== undefined && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ctxNames.includes(n.expression.text);
  const decls = (name) => all.filter((n) => (ts.isVariableDeclaration(n) || ts.isParameter(n)) && ts.isIdentifier(n.name) && n.name.text === name);
  const constOf = (name, ok) => decls(name).length > 0 && decls(name).every((d) => ts.isVariableDeclaration(d) && (d.parent.flags & ts.NodeFlags.Const) && ok(d.initializer));
  const calls = all.filter(isCtx);
  if (calls.length === 0) fail(`${target} never calls inMemoryContext — the cases must render the real routes`);
  for (const c of calls) {
    const obj = c.arguments[0];
    if (c.arguments.length !== 1 || !ts.isObjectLiteralExpression(obj)) fail(`${at(c)}: inMemoryContext takes ONE object literal of routes`);
    for (const p of obj.properties) if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) || !(ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))) fail(`${at(p)}: the routes object holds only plain 'key': Component entries (no spread, method or computed key)`);
    for (const [k, w] of Object.entries(WANT)) {
      const hits = obj.properties.filter((p) => p.name.text === k);
      const v = hits.length !== 1 ? null : ts.isShorthandPropertyAssignment(hits[0]) ? hits[0].name : hits[0].initializer;
      if (v === null || !ts.isIdentifier(v) || v.text !== local[k]) fail(`${at(c)}: route '${k}' must map, once, to ${local[k]} (the default export of ${w})`);
    }
  }
  const roots = all.filter((n) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && rootNames.includes(n.tagName.getText(sf)));
  for (const r of roots) {
    const attrs = r.attributes.properties, ctx = attrs.find((x) => ts.isJsxAttribute(x) && x.name.getText(sf) === 'context');
    const e = ctx && ctx.initializer && ts.isJsxExpression(ctx.initializer) ? ctx.initializer.expression : undefined;
    if (attrs.some(ts.isJsxSpreadAttribute) || !(isCtx(e) || (e !== undefined && ts.isIdentifier(e) && constOf(e.text, isCtx)))) fail(`${at(r)}: <ExpoRoot> must take context={inMemoryContext(...)} (or a const holding that call), no spread props`);
  }
  const isBlock = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['describe', 'it', 'test'].includes(n.expression.text) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0]);
  const fullName = (n) => { const t = []; for (let p = n.parent, g = 0; p !== undefined && g < 2000; p = p.parent, g += 1) if (isBlock(p)) t.unshift(p.arguments[0].text); return t.join(' ').toLowerCase().replace(/\s+/g, ' ').trim(); };
  const isAcc = (k) => (ts.isStringLiteralLike(k) && k.text === 'now-accessory') || (ts.isIdentifier(k) && constOf(k.text, (i) => i !== undefined && ts.isStringLiteralLike(i) && i.text === 'now-accessory'));
  const two = all.some((n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['toHaveLength', 'toBe', 'toEqual', 'toStrictEqual'].includes(n.expression.name.text)
    && n.arguments.length === 1 && ts.isNumericLiteral(n.arguments[0]) && n.arguments[0].text === '2' && ts.isCallExpression(n.expression.expression)
    && ts.isIdentifier(n.expression.expression.expression) && n.expression.expression.expression.text === 'expect' && nodes(n.expression.expression).some(isAcc)
    && (fullName(n) === phrase || fullName(n).endsWith(` ${phrase}`)));
  if (!two) fail(`${target}: the test ending '${a}' never asserts, inline, expect(<a query naming testID 'now-accessory'>).toHaveLength(2) (or toBe/toEqual 2) — both accessory placements must be proven rendered`);
  console.log(`ratchet: ${target} renders the real root layout, tab layout and Map route through inMemoryContext and asserts both accessory placements`);
} else fail(`unknown _mfix6_ast command '${cmd}'`);
NODE
}

# one_watch_site — gate 3: the ONE non-test module under src naming watchPositionAsync (AST) IS
# src/ui/location/UserLocationProvider.tsx — not a helper beside it, so no other module holds a watch function another
# screen could call under an alias — and the only non-test module that imports, re-exports or require()s
# UserLocationProvider.tsx is src/app/_layout.tsx, so no screen can nest a second provider (and its second watch).
# Consumers read the one fix through the context hook (useUserPosition / useUserLocation), never the provider module.
one_watch_site() {
  local site others
  need_file "$MFIX6_PROVIDER" || return 1
  site=$(_mfix6_ast watch_sites src) || { echo "$site"; return 1; }
  [ "$site" = "$MFIX6_PROVIDER" ] || { echo "ratchet: the one non-test module naming watchPositionAsync is $site — it must be $MFIX6_PROVIDER itself (the provider calls expo-location's watch; no helper module may hold a watch another screen can call)"; return 1; }
  others=$(_mfix6_ast importers src "$MFIX6_PROVIDER") || { echo "$others"; return 1; }
  others=$(printf '%s\n' "$others" | grep -vx 'src/app/_layout.tsx' | grep -v '^$' || true)
  [ -z "$others" ] || { echo "ratchet: outside tests only src/app/_layout.tsx may import / re-export / require $MFIX6_PROVIDER (one provider, at the root); also: $(printf '%s' "$others" | tr '\n' ' ')"; return 1; }
  echo "ratchet: the one location watch lives in $MFIX6_PROVIDER, which only src/app/_layout.tsx imports"
}

# provider_at_root — the root layout (src/app/_layout.tsx) value-imports UserLocationProvider from the card's module
# and renders it AROUND the root <Stack>, so every screen (tabs, the accessory, pushed sheets, trip/[tripId]) reads
# the one provider.
provider_at_root() {
  _mfix6_ast imports_renders src/app/_layout.tsx UserLocationProvider "$MFIX6_PROVIDER" Stack || return 1
}

# app_test_wired — the real-app test renders the REAL app: <ExpoRoot> from expo-router over inMemoryContext routes that
# map the root layout, the (tabs) layout and the Map route to their imported default exports (no stand-in routes), and
# its non-vacuity case asserts BOTH accessory placements rendered (TypeScript AST; a type import or a mention does not
# count). Without the count-2 assertion an app that never mounts the accessory would make "one watch" vacuous.
app_test_wired() {
  need_file "$MFIX6_APP_TEST" || return 1
  _mfix6_ast imports_renders "$MFIX6_APP_TEST" ExpoRoot expo-router || return 1
  _mfix6_ast real_app "$MFIX6_APP_TEST" 'the real tab layout mounts the now strip in both accessory placements' || return 1
}

# app_cases <phrase>... — the real-app cases: jest_cases over the real-app test file, which renders the REAL app.
app_cases() {
  app_test_wired || return 1
  jest_cases "$MFIX6_APP_TEST" "$@" || return 1
}

# The card's own module and test file: the guard for the repo-wide gates (a bare full_gate is green on the unbuilt
# tree, so it runs only once every file this card adds exists).
card_files() {
  need_files "$MFIX6_PROVIDER" "$MFIX6_APP_TEST" || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built (mfix3, m5c) that this card's edits could
# break, run only WITH this card's files in the tree: on the unbuilt tree it fails clean.
after_card() {
  [ "$#" -ge 1 ] || { echo "ratchet: after_card needs a gate to run"; return 1; }
  card_files || return 1
  "$@" || return 1
}

# card_full_gate — npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest — every existing test,
# incl. mfix3/m6b/m7c/m7b's location tests — and node:test) green WITH this card's files in the tree.
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# card_export — guarded on this card's files: Metro bundles the app for iOS (lib.sh ios_export) on a PRIVATE Metro
# cache (TMPDIR; a shared-cache export registered only 4 routes on a correct build — mfix2/m10b pattern). No .hbc grep.
card_export() {
  local metro_tmp="$PWD/.cache/metro-tmp-mfix6"
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
}

# transitmap_tests_untouched: copied VERBATIM from verify-mfix3_map_feel.sh (its guard is this card's card_files).
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
trap 'echo "ratchet: mfix6_one_location_watch gate failed at verify script line $LINENO"' ERR

# --- The real app opens ONE watch ---
# 1. One passing test each in src/ui/location/__tests__/one-watch.test.tsx, which renders the REAL app — expo-router's <ExpoRoot> over inMemoryContext({ _layout: RootLayout, '(tabs)/_layout': TabsLayout, '(tabs)/index': MapScreen }) with the default exports of src/app/_layout.tsx, src/app/(tabs)/_layout.tsx and src/app/(tabs)/index.tsx — on iOS 26 (a labelled native mock of react-native/Libraries/Utilities/NativePlatformConstantsIOS reporting osVersion '26.0', so react-native-screens mounts the BottomAccessory in BOTH its 'regular' and 'inline' placements), with expo-location a labelled native mock granting a fix: two now-accessory hosts are mounted (non-vacuity: without them the count below proves nothing about the Now strip); after the app settles watchPositionAsync has been called EXACTLY once (today: 4 — two accessories x the hurry hook + the home context); requestForegroundPermissionsAsync EXACTLY once (today: 5 — the map's own ask + one per watch: the map's dot reads the provider's answer).
app_cases 'the real tab layout mounts the now strip in both accessory placements' 'the real app opens exactly one location watch' 'the real app asks for location permission once'
# 2. One passing test (same file): unmounting the real app calls the one subscription's remove() exactly once (summed over every subscription handed out), and no new watch starts after the unmount.
app_cases 'unmounting the real app removes its one location watch'
# 3. Non-test code names watchPositionAsync in exactly ONE module (TypeScript AST; aliases, destructures and Location['watchPositionAsync'] count, comments do not), and that module IS src/ui/location/UserLocationProvider.tsx; outside tests only src/app/_layout.tsx imports / re-exports / require()s that module (no screen nests a second provider or calls a second watch).
one_watch_site
# 4. The root layout (src/app/_layout.tsx) value-imports UserLocationProvider from src/ui/location/UserLocationProvider.tsx and renders it around the root <Stack> (AST), so tabs, the accessory and pushed screens all read the one provider.
provider_at_root

# --- Denied / undefined answers, and no hidden second watch ---
# 5. Two passing tests (real-app file), one per answer: requestForegroundPermissionsAsync resolving undefined (jest-expo's automatic expo-location mock), and resolving { granted: false }, each start NO watch, leave no MapView with showsUserLocation, and throw nothing (the rendered tree still holds both accessories).
app_cases 'an undefined permission answer opens no watch, shows no dot and does not throw' 'a denied permission answer opens no watch, shows no dot and does not throw'
# 6. One passing test under src/ui/location/__tests__: a component calling useUserPosition() rendered WITHOUT UserLocationProvider fails loud (an invariant names the provider) and watchPositionAsync is never called — no consumer can silently open a second watch.
jest_cases src/ui/location/__tests__ 'useUserPosition outside the provider fails loud and opens no watch'
# 7. The location tests mock only native packages, each labelled '// test-time mock of native module' (m5c's helper).
mocks_native_only src/ui/location/__tests__
# 8. (guarded on this card's files) mfix3's denied cases stay green: location denied -> no dot, one line of explanation; a missing or failed answer counts as denied.
after_card jest_nonempty src/ui/map 'location denied shows no dot and one line of explanation$'
after_card jest_nonempty src/ui/map 'a missing or failed location permission answer counts as denied$'
# 9. (guarded on this card's files) m5c's TransitMap.test.tsx is byte-identical to da31592 (mfix3 gate 20's pin, re-checked: the map's location state still treats an undefined answer as denied without a provider in that test).
transitmap_tests_untouched

# --- Repo-wide ---
# 10. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every existing test, incl. mfix3/m6b/m7c/m7b's location tests), node:test — all green.
card_full_gate
# 11. (guarded on this card's files) Metro bundles the app for iOS on a private Metro cache.
card_export

echo "mfix6_one_location_watch: all 12 gate lines green"
