#!/usr/bin/env bash
# m10b_routes_ui — Route options UI (plan M10b.1–M10b.2): the "Route options" plan sheet, the options list
# (sorted by arrival, line badges, Live badge, the first leg's hurry-or-chill chip, "Routes by Transitous"),
# itinerary detail with walk-leg Apple Maps directions (dirflg=w; success = openURL resolved), and the
# unavailable state's "Open in Apple Maps" (dirflg=r), recent places persisted in expo-sqlite/kv-store (ruling R6)
# and the Trips tab empty state's "Plan a route" (R6). Builds on m10a (Transitous client, polite client,
# live overlay + firstLegVerdict), m7c (hurry verdict + copy), m5a (tokens/primitives), m6a (LineBadge), m6b (station route)
# and m4b (live context).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below, and no gate reads a
# variable or a file another gate created (the M10B_* arrays are fixed text). Run one gate alone, from
# the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-m10b_routes_ui.sh
#
# TEST-NAME CONVENTION the named-test gates rely on: each acceptance case is its OWN passing jest test
# whose full name (describe titles + test title, joined by one space, case-insensitive) ENDS with the
# exact phrase in M10B_CASES, starting at a word boundary — the same as a '(^| )<phrase>$' pin, matched
# as a literal (no regex). No phrase is a suffix of another (an authoring check below enforces it), so a
# name can end only one way: one catch-all test satisfies at most one case, in this gate or any other.
# An outer describe in front of the phrase is fine. jest-expo's fetch never reaches the network
# (probed 2026-10-01: fetch() resolves at once with no status), so these tests run on fixtures only.

# ---- fixed card data (read by helpers; no gate sets them) ----

# The card-wide universe of named jest cases (gates 8, 13 and 14, plus the full-gate guard).
M10B_CASES=(
  'route options are sorted by arrival'
  'route option shows depart and arrive times, duration, transfers and walk minutes'
  'route option shows the first leg hurry chip'
  'route option with a live leg shows the Live badge'
  'footer credits Routes by Transitous with a link to its sources'
  'a planned destination goes first in recent places without duplicates'
  'walk leg Directions opens Apple Maps walking with dirflg=w'
  'walk leg Directions counts openURL resolving undefined as opened'
  'walk leg Directions shows the failure when openURL rejects'
  'transit leg shows its stations, line badge and Live or Scheduled'
  'unavailable routes offer Open in Apple Maps with dirflg=r'
  'Trips tab empty state offers Plan a route linking /plan'
)
# The card's own modules: the guards in front of every repo-wide gate.
M10B_FILES=(
  src/app/plan.tsx
  src/ui/routes/route-options.ts
  src/ui/routes/leg-actions.ts
  src/ui/routes/RouteOptionsList.tsx
  src/ui/routes/ItineraryDetail.tsx
  src/ui/routes/PlanUnavailable.tsx
  src/ui/routes/recent-places.ts
)
M10B_TESTS=src/ui/routes/__tests__

# ---- card helpers (lib.sh has no multi-case literal pin, import graph, route title, engine spy or
#      openURL oracle; everything else comes from lib.sh). Each fails loud with a named reason. ----

# m10b_cases <path> <phrase>... — ONE unfiltered jest run over the path with a JSON report: jest green,
# >= 1 test, nothing failed/skipped/todo; then every <phrase> must be in M10B_CASES and be ended by the
# full name of >= 1 PASSED test that ends with no other M10B_CASES phrase.
m10b_cases() {
  local path="$1" report out rc=0; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: m10b_cases needs at least one case"; return 1; }
  _no_argv_in_tests "$path" || return 1
  report=$(mktemp -t ratchet-m10b.XXXXXX) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(local_bin jest --ci --json --outputFile="$report" "$path" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$report" ]; then
    echo "$out" | tail -30; rm -f "$report"; echo "ratchet: jest is red (exit $rc) under $path"; return 1
  fi
  node - "$report" "$path" "$#" "$@" "${M10B_CASES[@]}" <<'NODE' || rc=1
const fs = require('node:fs');
const [report, where, count, ...rest] = process.argv.slice(2);
const n = Number(count);
const wanted = rest.slice(0, n).map((s) => s.toLowerCase());
const universe = rest.slice(n).map((s) => s.toLowerCase());
const authoring = [];
if (!(n >= 1) || universe.length === 0) authoring.push(`bad arguments (${n} case(s), ${universe.length} in M10B_CASES)`);
if (new Set(universe).size !== universe.length) authoring.push('M10B_CASES lists a phrase twice');
for (const a of universe) for (const b of universe) {
  if (a !== b && b.endsWith(` ${a}`)) authoring.push(`"${a}" is a suffix of "${b}"`);
}
wanted.filter((w) => !universe.includes(w)).forEach((w) => authoring.push(`"${w}" is not in M10B_CASES`));
if (authoring.length > 0) {
  authoring.forEach((p) => console.log(`ratchet: verify-script authoring error: ${p}`));
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const all = r.testResults.flatMap((t) => t.assertionResults);
const notPassed = all.filter((a) => a.status !== 'passed');
if (r.success !== true || r.numFailedTestSuites > 0 || r.numRuntimeErrorTestSuites > 0 || notPassed.length > 0 || all.length === 0) {
  console.log(`ratchet: ${where}: ${all.length - notPassed.length} passed; not passed: ${notPassed.map((a) => `${a.status}: ${a.fullName}`).slice(0, 5).join('; ') || 'none'} — failing/skipped/todo tests are forbidden`);
  process.exit(1);
}
const ends = (name, phrase) => name === phrase || name.endsWith(` ${phrase}`);
const problems = [];
for (const w of wanted) {
  const hits = all.filter((a) => ends(a.fullName.toLowerCase(), w));
  const own = hits.filter((a) => universe.every((o) => o === w || !ends(a.fullName.toLowerCase(), o)));
  if (hits.length === 0) problems.push(`no passing test's full name ends with "${w}"`);
  else if (own.length === 0) problems.push(`"${w}" only ends tests that also end with another card phrase — give it its own test`);
}
if (problems.length > 0) {
  problems.forEach((p) => console.log(`ratchet: ${where}: ${p}`));
  console.log(`passed tests: ${all.map((a) => a.fullName).join('  ;  ')}`);
  process.exit(1);
}
console.log(`ratchet: ${where}: ${all.length} tests green; ${wanted.length} named case(s), each its own passing test`);
NODE
  rm -f "$report"
  return "$rc"
}

# _m10b_graph <cmd> <args>... — one node program over the TypeScript AST (node_modules/typescript),
# walked with explicit stacks/queues (no recursion). Import closure = value imports only (`import type`
# is erased), following ./ ../ and @/ (= src/) specifiers to .ts/.tsx files, plus require()/import().
#   reaches <entry> <ERE>...           every ERE matches a repo path in entry's closure
#   contains <entry> <ERE>             a non-test file in entry's closure (entry included) has text matching ERE
#   links <entry> <href>               a non-test file in entry's closure, OTHER than the href's own route
#                                      file, has a quoted href to <href> ('/plan', "/plan?…", `/plan?…`)
#     (contains and links match CODE: comments are blanked first; strings, templates, JSX text stay)
#   title <route> <expected>           the route's screen title is exactly <expected>: from a nameless
#     <X.Screen options> in the route or a non-test .tsx it reaches, or <X.Screen name="<route>"> in an
#     ancestor _layout.tsx (option values: literals, consts — same file or a named ./ ../ @/ import —,
#     spreads of those, or arrows returning them; never a call result). headerShown — from the route's
#     options, else the navigator's screenOptions — must not be false (the root Stack hides headers).
_m10b_graph() {
  node - "$@" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (msg) => { console.log(`ratchet: ${msg}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); }
catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, ...args] = process.argv.slice(2);
const relPath = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const absPath = (p) => path.resolve(ROOT, p);
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const needFile = (p) => { if (!isFile(absPath(p))) fail(`missing file ${p}`); return absPath(p); };
const isTest = (f) => f.includes('/__tests__/') || /\.test\.tsx?$/.test(f);
const sources = new Map();
function sourceOf(abs) {
  if (!sources.has(abs)) {
    const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sources.set(abs, ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind));
  }
  return sources.get(abs);
}
function nodesOf(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node);
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return out;
}
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolveImport(fromAbs, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromAbs), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = EXTENSIONS.map((ext) => base + ext).find((p) => /\.tsx?$/.test(p) && isFile(p));
  return hit === undefined ? null : hit;
}
function typeOnly(node) {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return clause.name === undefined && named !== undefined && ts.isNamedImports(named)
    && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
}
function importSpecifiers(abs) {
  const specs = [];
  for (const node of nodesOf(sourceOf(abs))) {
    if (ts.isImportDeclaration(node) && !typeOnly(node) && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specs.push(node.arguments[0].text);
  }
  return specs;
}
function closureOf(entryAbs) {
  const queue = [entryAbs];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length && i < 5000; i += 1) {
    for (const spec of importSpecifiers(queue[i])) {
      const next = resolveImport(queue[i], spec);
      if (next !== null && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return queue.map(relPath);
}
function constInitializer(sf, name) {
  const decl = nodesOf(sf).find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
    && n.name.text === name && n.initializer !== undefined);
  return decl === undefined ? undefined : decl.initializer;
}
function importedInitializer(sf, name) {
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const named = node.importClause === undefined ? undefined : node.importClause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => e.name.text === name);
    if (el === undefined) continue;
    const target = resolveImport(sf.fileName, node.moduleSpecifier.text);
    if (target === null) return undefined;
    const tsf = sourceOf(target);
    const init = constInitializer(tsf, (el.propertyName === undefined ? el.name : el.propertyName).text);
    return init === undefined ? undefined : { node: init, sf: tsf };
  }
  return undefined;
}
function unwrap(expr, sf) {
  let e = expr;
  let file = sf;
  for (let hop = 0; hop < 16 && e !== undefined; hop += 1) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)
      || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) { e = e.expression; continue; }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (!ts.isBlock(e.body)) { e = e.body; continue; }
      const ret = e.body.statements.find((s) => ts.isReturnStatement(s));
      e = ret === undefined ? undefined : ret.expression;
      continue;
    }
    if (ts.isIdentifier(e)) {
      const local = constInitializer(file, e.text);
      if (local !== undefined) { e = local; continue; }
      const imported = importedInitializer(file, e.text);
      if (imported === undefined) return undefined;
      e = imported.node;
      file = imported.sf;
      continue;
    }
    return { node: e, sf: file };
  }
  return e === undefined ? undefined : { node: e, sf: file };
}
function optionKeys(expr, sf) {
  const keys = new Map();
  const first = expr === undefined ? undefined : unwrap(expr, sf);
  if (first === undefined || !ts.isObjectLiteralExpression(first.node)) return keys;
  const work = [first];
  for (let i = 0; i < work.length && i < 32; i += 1) {
    const { node: obj, sf: file } = work[i];
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const spread = unwrap(prop.expression, file);
        if (spread !== undefined && ts.isObjectLiteralExpression(spread.node)) work.push(spread);
        continue;
      }
      if (!ts.isPropertyAssignment(prop) || (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name))) continue;
      const init = unwrap(prop.initializer, file);
      let value = '<expr>';
      if (init !== undefined && ts.isStringLiteralLike(init.node)) value = init.node.text;
      else if (init !== undefined && init.node.kind === ts.SyntaxKind.FalseKeyword) value = false;
      else if (init !== undefined && init.node.kind === ts.SyntaxKind.TrueKeyword) value = true;
      if (!keys.has(prop.name.text)) keys.set(prop.name.text, value);
    }
  }
  return keys;
}
const tagOf = (el) => el.tagName.getText(el.getSourceFile());
const openings = (sf) => nodesOf(sf).filter((n) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
const isScreen = (el) => /(^|\.)Screen$/.test(tagOf(el));
function attrExpr(el, name) {
  const attr = el.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === name);
  if (attr === undefined || attr.initializer === undefined) return undefined;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer;
  return ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
}
function attrString(el, name, sf) {
  const raw = attrExpr(el, name);
  const value = raw === undefined ? undefined : unwrap(raw, sf);
  return value !== undefined && ts.isStringLiteralLike(value.node) ? value.node.text : null;
}
function screenSources(route) {
  const routeAbs = needFile(route);
  const appRoot = absPath('src/app');
  const perRoute = [];
  const navigator = [];
  for (const file of closureOf(routeAbs).filter((f) => f.endsWith('.tsx') && !isTest(f))) {
    const sf = sourceOf(absPath(file));
    for (const el of openings(sf)) {
      if (isScreen(el) && attrExpr(el, 'name') === undefined) perRoute.push({ where: file, keys: optionKeys(attrExpr(el, 'options'), sf) });
    }
  }
  let dir = path.dirname(routeAbs);
  for (let depth = 0; depth < 12 && dir.startsWith(appRoot); depth += 1) {
    const layout = path.join(dir, '_layout.tsx');
    if (isFile(layout) && layout !== routeAbs) {
      const lsf = sourceOf(layout);
      const rel = path.relative(dir, routeAbs).split(path.sep).join('/').replace(/\.tsx?$/, '');
      const names = new Set([rel, rel.replace(/\/index$/, '')]);
      for (const el of openings(lsf)) {
        if (isScreen(el) && names.has(attrString(el, 'name', lsf))) perRoute.push({ where: relPath(layout), keys: optionKeys(attrExpr(el, 'options'), lsf) });
        if (attrExpr(el, 'screenOptions') !== undefined) navigator.push({ where: relPath(layout), keys: optionKeys(attrExpr(el, 'screenOptions'), lsf) });
      }
    }
    if (dir === appRoot) break;
    dir = path.dirname(dir);
  }
  return { perRoute, navigator };
}
function checkTitle(route, expected) {
  const { perRoute, navigator } = screenSources(route);
  const titled = perRoute.filter((s) => s.keys.has('title'));
  if (titled.length === 0) fail(`${route} sets no screen title — give it options.title ${JSON.stringify(expected)} on a nameless <Stack.Screen> in the route, or on <Stack.Screen name="…"> in its _layout.tsx (literal or const values, not a call)`);
  const wrong = titled.find((s) => s.keys.get('title') !== expected);
  if (wrong !== undefined) fail(`${route}'s title is ${JSON.stringify(wrong.keys.get('title'))} (set in ${wrong.where}) — it must be exactly ${JSON.stringify(expected)}`);
  const shown = perRoute.find((s) => s.keys.has('headerShown')) ?? navigator.find((s) => s.keys.has('headerShown'));
  if (shown !== undefined && shown.keys.get('headerShown') !== true) fail(`${route}: headerShown resolves to ${JSON.stringify(shown.keys.get('headerShown'))} (set in ${shown.where}), so the ${JSON.stringify(expected)} title never shows — set headerShown: true on the route`);
  return `${route} shows the screen title ${JSON.stringify(expected)} (set in ${titled[0].where})`;
}
// The file's text with every comment blanked (same length, newlines kept) and every string, template and
// JSX text left intact, so `contains` / `links` never count a comment. Every comment lies in the trivia
// before some leaf token of the PARSED tree (the parser knows JSX context, unlike a bare scanner): TS
// reports its same-line part as trailing ranges and its after-newline part as leading ranges, so both
// are read. JSDoc subtrees and JsxText leaves (whose text may hold '//') are never read as trivia.
// keepJsxText false (links) also blanks JSX display text: words on screen are not a navigation target.
const JSDOC = (k) => k >= ts.SyntaxKind.FirstJSDocNode && k <= ts.SyntaxKind.LastJSDocNode;
function codeText(abs, keepJsxText) {
  const sf = sourceOf(abs);
  const chars = sf.text.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) { if (chars[i] !== '\n') chars[i] = ' '; } };
  const stack = [sf];
  for (let guard = 0; stack.length > 0 && guard < 1000000; guard += 1) {
    const node = stack.pop();
    const kids = node.getChildren(sf);
    if (kids.length > 0) { for (const kid of kids) { if (!JSDOC(kid.kind)) stack.push(kid); } continue; }
    if (node.kind === ts.SyntaxKind.JsxText) { if (!keepJsxText) blank(node.pos, node.end); continue; }
    const ranges = [ts.getTrailingCommentRanges(sf.text, node.pos), ts.getLeadingCommentRanges(sf.text, node.pos)];
    for (const range of ranges.flatMap((r) => r ?? [])) blank(range.pos, range.end);
  }
  if (stack.length > 0) fail(`${relPath(abs)} is too large to strip its comments`);
  return chars.join('');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function main() {
  if (cmd === 'reaches') {
    const [entry, ...patterns] = args;
    const files = closureOf(needFile(entry));
    const missing = patterns.filter((p) => !files.some((f) => new RegExp(p).test(f)));
    if (missing.length > 0) fail(`${entry} never imports (directly or transitively, value imports only) a module matching ${missing.map((p) => `/${p}/`).join(', ')}; it reaches: ${files.filter((f) => f.startsWith('src/')).join(', ')}`);
    return `${entry} reaches ${patterns.map((p) => `/${p}/`).join(', ')}`;
  }
  if (cmd === 'contains') {
    const [entry, pattern] = args;
    const re = new RegExp(pattern);
    const files = closureOf(needFile(entry)).filter((f) => !isTest(f));
    const hit = files.find((f) => re.test(codeText(absPath(f), true)));
    if (hit === undefined) fail(`no non-test module reached from ${entry} contains /${pattern}/ (searched: ${files.join(', ')})`);
    return `${hit} (reached from ${entry}) contains /${pattern}/`;
  }
  if (cmd === 'links') {
    const [entry, href] = args;
    const target = `src/app${href}.tsx`;
    const re = new RegExp(`["'\`]${escapeRe(href)}(\\?[^"'\`]*)?["'\`]`);
    const files = closureOf(needFile(entry)).filter((f) => !isTest(f) && f !== target);
    const hit = files.find((f) => re.test(codeText(absPath(f), false)));
    if (hit === undefined) fail(`nothing reached from ${entry} (tests and ${target} itself excluded) links to '${href}' — no entry point opens it (searched: ${files.join(', ')})`);
    return `${hit} (reached from ${entry}) links to '${href}'`;
  }
  if (cmd === 'title') return checkTitle(args[0], args[1]);
  return fail(`unknown _m10b_graph command '${cmd}'`);
}
console.log(`OK ${main()}`);
NODE
}

# plan_title <route> <title> — the route's real screen title is exactly <title>, and its header shows.
plan_title() { _m10b_graph title "$@" || return 1; }
# plan_reaches <entry> <ERE>... — the entry's value-import closure reaches a file matching every ERE.
plan_reaches() { _m10b_graph reaches "$@" || return 1; }
# plan_contains <entry> <ERE> — a non-test module the entry reaches (or the entry) contains ERE.
plan_contains() { _m10b_graph contains "$@" || return 1; }

# plan_entry_points — the plan's entry points open '/plan': the map tab (the Directions button) and the
# station sheet ("Route from here" on m6b's src/app/station/[stationKey].tsx, which lands before this card),
# both unconditionally. The saved-trip entry point (src/app/trip/[tripId].tsx) is m7b's gate (ruling R4/R6:
# m7b lands after this card). Guarded by the card's own route, so it cannot pass before the plan sheet exists.
plan_entry_points() {
  need_file src/app/plan.tsx || return 1
  _m10b_graph links "src/app/(tabs)/index.tsx" /plan || return 1
  _m10b_graph links "src/app/station/[stationKey].tsx" /plan || return 1
}

# trips_empty_plans — the Trips tab is useful before saved trips land (ruling R6): its route's non-test
# closure carries the "Plan a route" action text and links '/plan'. Guarded by the card's own route.
trips_empty_plans() {
  need_file src/app/plan.tsx || return 1
  _m10b_graph contains "src/app/(tabs)/trips/index.tsx" 'Plan a route' || return 1
  _m10b_graph links "src/app/(tabs)/trips/index.tsx" /plan || return 1
}

# hurry_chip_runs_engine <phrase> — runs the card's test dir UNFILTERED with a spy on every top-level
# function export of m7c's src/domain/hurry/verdict.ts (appended to the config's own setupFilesAfterEnv,
# never replacing them) that logs the CURRENT TEST's full name on each call. The run must be green, a
# passing test must end with <phrase>, and the engine must have been called DURING that test. A chip
# built from a hand-written verdict object, a type-only import or a UI re-implementation records no call.
hurry_chip_runs_engine() {
  local phrase="$1" verdict=src/domain/hurry/verdict.ts dir out rc=0 line
  local after=()
  [ -d "$M10B_TESTS" ] || { echo "ratchet: missing $M10B_TESTS — the milestone's tests do not exist yet"; return 1; }
  _no_argv_in_tests "$M10B_TESTS" || return 1
  need_file "$verdict" || return 1
  while IFS= read -r line; do [ -n "$line" ] && after+=("$line"); done < <(local_bin jest --showConfig 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const f of JSON.parse(s).configs[0].setupFilesAfterEnv||[])console.log(f)})')
  dir="$PWD/.cache/ratchet-m10b-spy.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  : > "$dir/calls"
  cat > "$dir/verdict-spy.js" <<EOF
jest.mock('$PWD/${verdict%.ts}', () => {
  const real = jest.requireActual('$PWD/${verdict%.ts}');
  const spied = { __esModule: true };
  for (const [name, value] of Object.entries(real)) {
    spied[name] = typeof value === 'function'
      ? function ratchetVerdictSpy(...args) {
          require('fs').appendFileSync('$dir/calls', String(expect.getState().currentTestName) + '\n');
          return value.apply(this, args);
        }
      : value;
  }
  return spied;
});
EOF
  out=$(local_bin jest --ci --json --outputFile="$dir/report.json" "$M10B_TESTS" \
    --setupFilesAfterEnv ${after[@]+"${after[@]}"} "$dir/verdict-spy.js" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$dir/report.json" ]; then
    echo "$out" | tail -25; rm -rf "$dir"; echo "ratchet: jest is red (exit $rc) under $M10B_TESTS with the verdict spy"; return 1
  fi
  node - "$dir/report.json" "$dir/calls" "$phrase" "$verdict" <<'NODE' || rc=1
const fs = require('node:fs');
const [report, callsFile, phrase, verdict] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const all = r.testResults.flatMap((t) => t.assertionResults);
if (r.success !== true || all.some((a) => a.status !== 'passed')) { console.log('ratchet: a card test failed, was skipped or is todo under the verdict spy'); process.exit(1); }
const p = phrase.toLowerCase();
const named = all.filter((a) => a.fullName.toLowerCase() === p || a.fullName.toLowerCase().endsWith(` ${p}`));
if (named.length === 0) { console.log(`ratchet: no passing test's full name ends with "${phrase}"`); process.exit(1); }
const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
const during = named.filter((a) => calls.includes(a.fullName));
if (during.length === 0) {
  const callers = [...new Set(calls)];
  console.log(`ratchet: "${named[0].fullName}" passed but never called ${verdict} — the chip must be the real hurry-or-chill verdict (m7c's engine, e.g. through m10a's firstLegVerdict), not a hand-built verdict, a type-only import or a UI re-implementation (tests that did call it: ${callers.join(' ; ') || 'none'})`);
  process.exit(1);
}
console.log(`ratchet: "${during[0].fullName}" passed and ran ${verdict} ${calls.filter((c) => c === during[0].fullName).length} time(s) during the test`);
NODE
  rm -rf "$dir"
  return "$rc"
}

# leg_actions_oracle walk|transit|opener — evaluates ONE contract of the real src/ui/routes/leg-actions.ts
# under the repo's own jest (jest-expo/ios: the app's babel transform and `@/` resolution), independent of
# the builder's tests, so a right-named test asserting the wrong value cannot pass it. The throwaway test
# lives in the gitignored .cache and is removed whether the check passes or fails.
#   walk     walkDirectionsUrl({lat: 25.7759, lon: -80.1961}) === 'maps://?daddr=25.7759,-80.1961&dirflg=w'
#   transit  transitDirectionsUrl({lat: 25.7759, lon: -80.1961}) === 'maps://?daddr=25.7759,-80.1961&dirflg=r'
#   opener   openDirections(url, openURL): openURL resolving undefined / false / true / null -> ok, opened
#            exactly once with url (the resolved value is never read: M1.19); openURL rejecting -> an err
#            (never a throw) naming the link, after url and at most one https://maps.apple.com fallback.
leg_actions_oracle() {
  local check="$1" module=src/ui/routes/leg-actions.ts dir out rc=0
  case "$check" in walk|transit|opener) ;; *) echo "ratchet: leg_actions_oracle: unknown check '$check'"; return 1 ;; esac
  need_file "$module" || return 1
  dir="$PWD/.cache/ratchet-m10b-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  {
    printf "import * as subject from '%s';\n" "$PWD/${module%.ts}"
    cat <<'EOF'
const s = subject as unknown as Record<string, any>;
const TO = { lat: 25.7759, lon: -80.1961 };
const WALK = 'maps://?daddr=25.7759,-80.1961&dirflg=w';
const TRANSIT = 'maps://?daddr=25.7759,-80.1961&dirflg=r';
function fn(name: string): (...a: any[]) => any {
  if (typeof s[name] !== 'function') throw new Error(`ratchet-oracle: src/ui/routes/leg-actions.ts exports no function ${name} (exports: ${Object.keys(s).join(', ') || 'none'})`);
  return s[name];
}
function urlIs(name: string, want: string): void {
  const got: unknown = fn(name)(TO);
  if (got !== want) throw new Error(`ratchet-oracle: ${name}({lat: 25.7759, lon: -80.1961}) returned ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  expect(got).toBe(want);
}
async function openerRule(): Promise<void> {
  const open = fn('openDirections');
  for (const value of [undefined, false, true, null]) {
    const calls: string[] = [];
    const result: any = await open(WALK, (url: string) => { calls.push(url); return Promise.resolve(value); });
    if (!(result && result.ok === true)) throw new Error(`ratchet-oracle: openDirections with openURL resolving ${String(value)} returned ${JSON.stringify(result)} — a resolve (with ANY value) means Apple Maps opened`);
    if (calls.length !== 1 || calls[0] !== WALK) throw new Error(`ratchet-oracle: with openURL resolving ${String(value)}, openURL was called with ${JSON.stringify(calls)}, expected exactly [${JSON.stringify(WALK)}]`);
  }
  const calls: string[] = [];
  let result: any;
  try {
    result = await open(WALK, (url: string) => { calls.push(url); return Promise.reject(new Error(`No app can open ${url}`)); });
  } catch (e) {
    throw new Error(`ratchet-oracle: openDirections threw when openURL rejected (${String(e)}) — a rejection must come back as err(...)`);
  }
  if (!(result && result.ok === false)) throw new Error(`ratchet-oracle: openURL rejecting gave ${JSON.stringify(result)}, expected an err`);
  if (calls[0] !== WALK || calls.length > 2 || (calls.length === 2 && !String(calls[1]).startsWith('https://maps.apple.com'))) throw new Error(`ratchet-oracle: openURL rejecting led to calls ${JSON.stringify(calls)} — expected ${JSON.stringify(WALK)} first, then at most one https://maps.apple.com fallback`);
  if (!JSON.stringify(result.error).includes('daddr=25.7759,-80.1961')) throw new Error(`ratchet-oracle: the err ${JSON.stringify(result.error)} does not name the link it could not open`);
  expect(result.ok).toBe(false);
  expect(calls[0]).toBe(WALK);
}
EOF
    case "$check" in
      walk) echo "it('ratchet oracle walk', () => { urlIs('walkDirectionsUrl', WALK); expect(WALK).toContain('dirflg=w'); });" ;;
      transit) echo "it('ratchet oracle transit', () => { urlIs('transitDirectionsUrl', TRANSIT); expect(TRANSIT).toContain('dirflg=r'); });" ;;
      opener) echo "it('ratchet oracle opener', async () => { await openerRule(); expect(true).toBe(true); });" ;;
    esac
  } > "$dir/leg.oracle.test.ts" || { rm -rf "$dir"; echo "ratchet: cannot write the oracle test"; return 1; }
  out=$(local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.ts' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | grep -q "ratchet-oracle:"; then echo "$out" | grep -m1 "ratchet-oracle:"; else echo "$out" | tail -25; fi
    echo "ratchet: leg-actions $check contract is not met"; return 1
  fi
  echo "$out" | grep -qE "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the $check oracle did not run"; return 1; }
  echo "ratchet: leg-actions $check contract holds on the real module"
}

# recents_survive_reload — ruling R6: recent places persist through expo-sqlite/kv-store (the same ruling
# as src/ui/settings/walking-pace.ts), never in module memory and never through m7a's settings-repo. An
# oracle under the repo's own jest (independent of the builder's tests) drives the REAL
# src/ui/routes/recent-places.ts over a labelled test-time mock of expo-sqlite/kv-store whose Map lives on
# globalThis, so it survives jest.resetModules() the way the SQLite file survives an app reload:
#   readRecentPlaces() on an empty store is []; recordRecentPlace(Brickell), (Government Center),
#   (Brickell) each return ok; the store now holds something; then jest.resetModules() (the reload) and a
#   fresh require: readRecentPlaces() names exactly [Brickell, Government Center] — newest first, no
#   duplicate. A module-level array passes before the reload and fails after it.
# The throwaway test lives in the gitignored .cache and is removed whether the check passes or fails.
recents_survive_reload() {
  local module=src/ui/routes/recent-places.ts dir out rc=0
  need_file "$module" || return 1
  dir="$PWD/.cache/ratchet-m10b-recents.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  {
    printf "const MODULE = '%s';\n" "$PWD/${module%.ts}"
    cat <<'EOF'
jest.mock('expo-sqlite/kv-store', () => { // test-time mock of native module
  // One Map on globalThis backs every store (the default/Storage/AsyncStorage instance and any
  // `new SQLiteStorage(db)`, namespaced by db), so any correct kv-store style persists across a reload.
  const g = globalThis as any;
  if (!(g.__ratchetKv instanceof Map)) g.__ratchetKv = new Map();
  const map: Map<string, string> = g.__ratchetKv;
  const makeStore = (db: string) => {
    const k = (key: string) => (db === '' ? key : db + '\u0000' + key);
    const own = () => [...map.keys()].filter((x) => (db === '' ? !x.includes('\u0000') : x.startsWith(db + '\u0000'))).map((x) => (db === '' ? x : x.slice(db.length + 1)));
    const get = (key: string) => map.get(k(key)) ?? null;
    const put = (key: string, value: any) => { map.set(k(key), typeof value === 'function' ? String(value(get(key))) : String(value)); };
    const del = (key: string) => map.delete(k(key));
    const clear = () => { for (const x of own()) map.delete(k(x)); return true; };
    return {
      getItemSync: get, setItemSync: put, removeItemSync: del, getAllKeysSync: own, clearSync: clear, getLengthSync: () => own().length,
      getItemAsync: async (key: string) => get(key), setItemAsync: async (key: string, v: any) => put(key, v), removeItemAsync: async (key: string) => del(key),
      getAllKeysAsync: async () => own(), clearAsync: async () => clear(), getLengthAsync: async () => own().length,
      getItem: async (key: string) => get(key), setItem: async (key: string, v: any) => put(key, v), removeItem: async (key: string) => { del(key); },
      getAllKeys: async () => own(), clear: async () => { clear(); },
      mergeItem: async (key: string, v: any) => { const prev = get(key); put(key, prev === null ? v : JSON.stringify({ ...JSON.parse(prev), ...JSON.parse(String(v)) })); },
      multiGet: async (keys: string[]) => keys.map((key) => [key, get(key)]),
      multiSet: async (pairs: [string, any][]) => { for (const [key, v] of pairs) put(key, v); },
      multiRemove: async (keys: string[]) => { for (const key of keys) del(key); },
    };
  };
  const store = makeStore('');
  class SQLiteStorage { constructor(db?: string) { Object.assign(this, makeStore(String(db ?? 'ExpoSQLiteStorage'))); } }
  return { __esModule: true, default: store, Storage: store, AsyncStorage: store, SQLiteStorage };
});
const fail = (m: string): never => { throw new Error('ratchet-oracle: ' + m); };
const BRICKELL = { name: 'Brickell', lat: 25.7584, lon: -80.1918 };
const GOV = { name: 'Government Center', lat: 25.7743, lon: -80.1955 };
function load(): Record<string, any> {
  const m = require(MODULE);
  for (const name of ['recordRecentPlace', 'readRecentPlaces']) {
    if (typeof m[name] !== 'function') fail(`src/ui/routes/recent-places.ts exports no function ${name} (exports: ${Object.keys(m).join(', ') || 'none'})`);
  }
  return m;
}
async function names(m: Record<string, any>): Promise<string[]> {
  const list: unknown = await m.readRecentPlaces();
  if (!Array.isArray(list)) fail(`readRecentPlaces() returned ${JSON.stringify(list)}, not an array of places`);
  return (list as any[]).map((p) => String(p?.name));
}
it('ratchet oracle recents survive a reload', async () => {
  const g = globalThis as any;
  g.__ratchetKv = new Map();
  const first = load();
  const empty = await names(first);
  if (empty.length !== 0) fail(`readRecentPlaces() on an empty store gave ${JSON.stringify(empty)}, expected []`);
  for (const place of [BRICKELL, GOV, BRICKELL]) {
    const r: any = await first.recordRecentPlace(place);
    if (r?.ok !== true) fail(`recordRecentPlace(${JSON.stringify(place)}) returned ${JSON.stringify(r)}, not ok`);
  }
  if (g.__ratchetKv.size === 0) fail('recordRecentPlace stored nothing in expo-sqlite/kv-store — recents must persist there (ruling R6)');
  jest.resetModules();
  const after = await names(load());
  const want = ['Brickell', 'Government Center'];
  if (JSON.stringify(after) !== JSON.stringify(want)) fail(`after a reload readRecentPlaces() names ${JSON.stringify(after)}, expected ${JSON.stringify(want)} (newest first, no duplicates, read back from expo-sqlite/kv-store)`);
  // The list must come FROM the store: wipe the store and reload -> []; restore it and reload -> the list again.
  // (A copy kept in module memory or on globalThis survives resetModules; this catches it.)
  const snapshot = [...g.__ratchetKv.entries()];
  g.__ratchetKv.clear();
  jest.resetModules();
  const wiped = await names(load());
  if (wiped.length !== 0) fail(`with expo-sqlite/kv-store emptied, a reload still reads ${JSON.stringify(wiped)} — recents must be read from the kv-store, not from memory or globalThis`);
  for (const [key, value] of snapshot) g.__ratchetKv.set(key, value);
  jest.resetModules();
  const restored = await names(load());
  if (JSON.stringify(restored) !== JSON.stringify(want)) fail(`with expo-sqlite/kv-store restored, a reload reads ${JSON.stringify(restored)}, expected ${JSON.stringify(want)}`);
  expect(after).toEqual(want);
  expect(restored).toEqual(want);
}, 120_000);
EOF
  } > "$dir/recents.oracle.test.ts" || { rm -rf "$dir"; echo "ratchet: cannot write the oracle test"; return 1; }
  out=$(local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.ts' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | grep -q "ratchet-oracle:"; then echo "$out" | grep -m1 "ratchet-oracle:"; else echo "$out" | tail -25; fi
    echo "ratchet: recent places do not survive a reload through expo-sqlite/kv-store"; return 1
  fi
  echo "$out" | grep -qE "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the recents oracle did not run"; return 1; }
  echo "ratchet: recent places survive a reload through expo-sqlite/kv-store (newest first, no duplicates)"
}

# openurl_value_unread — no non-test card code binds or branches on the value openURL resolved with
# (M1.19: RN Linking.openURL is Promise<void>; success = resolve, failure = reject). Gate 18's oracle
# catches a read the grep cannot see (resolving false must still be ok).
openurl_value_unread() {
  local f hits rc=0
  for f in "${M10B_FILES[@]}"; do need_file "$f" || return 1; done
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ \
    -e '=[[:space:]]*await[[:space:]]+[A-Za-z_$.]*openURL\(' \
    -e '\(await[[:space:]]+[A-Za-z_$.]*openURL\(' \
    -e 'openURL\([^)]*\)[[:space:]]*\.then\([[:space:]]*\(?[[:space:]]*[A-Za-z_$]' \
    src/app/plan.tsx src/ui/routes) || rc=$?
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) scanning the card's code"; return 1; }
  [ -z "$hits" ] || { echo "$hits"; echo "ratchet: card code reads openURL's resolved value — success = resolve, failure = reject (M1.19)"; return 1; }
  echo "ratchet: no card code reads openURL's resolved value"
}

# need_lits <dir> <string>... — the dir exists and its files contain EVERY fixed string.
need_lits() {
  local path="$1" s; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  for s in "$@"; do
    grep -rqF -- "$s" "$path" || { echo "ratchet: '$s' does not appear in $path — the tests must assert the exact value"; return 1; }
  done
}

# native_mocks_labelled <test-dir>... — every jest.mock/doMock in these test dirs names a module by
# literal, carries the '// test-time mock of native module' label on its line or the line above, and
# mocks a NATIVE module (expo*, @expo/*, react-native*, @react-native*). Mocking our own code is a stub.
native_mocks_labelled() {
  local d
  for d in "$@"; do [ -d "$d" ] || { echo "ratchet: missing $d — the milestone's tests do not exist yet"; return 1; }; done
  node - "$@" <<'NODE' || return 1
const fs = require('node:fs'), path = require('node:path');
const LABEL = 'test-time mock of native module';
const NATIVE = /^(expo([-/][\w./-]*)?|@expo\/[\w./-]+|react-native([-/][\w./-]*)?|@react-native(-[\w-]+)?\/[\w./-]+)$/;
const files = [], todo = process.argv.slice(2), problems = [];
for (let guard = 0; todo.length > 0 && guard < 10000; guard++) {
  const p = todo.pop();
  if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
  else if (/\.(ts|tsx|js|jsx)$/.test(p)) files.push(p);
}
let mocks = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8'), lines = text.split('\n');
  const calls = (text.match(/jest\.(mock|doMock)\(/g) || []).length;
  const re = /jest\.(mock|doMock)\(\s*(['"`])([^'"`]+)\2/g;
  let m, literal = 0;
  while ((m = re.exec(text)) !== null) {
    literal++; mocks++;
    const n = text.slice(0, m.index).split('\n').length - 1;
    const near = `${lines[n] ?? ''}\n${lines[n - 1] ?? ''}`;
    if (!near.includes(LABEL)) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") lacks the "// ${LABEL}" label`);
    if (!NATIVE.test(m[3])) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") mocks a non-native module (a stub of our own code)`);
  }
  if (literal !== calls) problems.push(`${f}: ${calls - literal} jest.mock call(s) without a literal module name`);
}
if (problems.length > 0) { console.log(problems.join('\n')); console.log('ratchet: test-time mocks must be labelled native modules only'); process.exit(1); }
console.log(`ratchet: ${files.length} test files, ${mocks} labelled native-module mocks`);
NODE
}

# m10b_full_gate — the repo-wide gate over THIS card's code. A bare full_gate is green on the unbuilt
# tree, so first every card module must exist and every M10B_CASES test must exist and pass as its own
# test; then tsc strict, eslint --max-warnings 0, the standards checker, jest and node:test must be green.
m10b_full_gate() {
  local f
  for f in "${M10B_FILES[@]}"; do need_file "$f" || return 1; done
  m10b_cases "$M10B_TESTS" "${M10B_CASES[@]}" || return 1
  full_gate || return 1
}

# m10b_bundle_carries <text>... — guarded by the card's modules: Metro bundles the app for iOS (lib's
# ios_export, the plan's Hermes export), and a --no-bytecode export of the same app carries each <text>
# as ONE whole quoted string literal (the Hermes string table packs strings back to back, so the .hbc
# is never grepped — see m5b). Both exports run on a Metro cache private to THIS tree (TMPDIR ->
# .cache/metro-tmp-m10b; Metro keeps its cache under os.tmpdir()). Proven 2026-10-01: Metro's shared
# cache keys node_modules/expo-router/_ctx.ios.js by its project-relative path + content, so in a tree
# whose node_modules is a symlink (a worktree, a scratch copy) the export reused the MAIN repo's cached
# require.context and bundled the main repo's src/app — no ./plan.tsx even though the tree had one. On
# a private cache the same tree bundled ./plan.tsx and "Routes by Transitous". The private cache never
# writes into the shared one, so this gate cannot poison another tree's exports either.
m10b_bundle_carries() {
  local dir=.cache/export-m10b-js metro_tmp="$PWD/.cache/metro-tmp-m10b" f text out rc
  for f in "${M10B_FILES[@]}"; do need_file "$f" || return 1; done
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  grep -rqF '"./plan.tsx"' "$dir/_expo/static/js/ios" \
    || { echo "ratchet: the iOS JS bundle has no route \"./plan.tsx\" — Metro did not bundle this tree's src/app/plan.tsx"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  for text in "$@"; do
    rc=0
    grep -rqF -e "\"$text\"" -e "'$text'" -e "\`$text\`" "$dir/_expo/static/js/ios" || rc=$?
    [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) scanning $dir"; return 1; }
    [ "$rc" -eq 0 ] || { echo "ratchet: the iOS JS bundle has no whole string literal \"$text\" — the route options sheet is not shipped"; return 1; }
  done
  echo "ratchet: the iOS JS bundle carries all $# literal(s): $*"
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m10b_routes_ui gate failed at verify script line $LINENO"' ERR

# --- M10b.1 Route options sheet -------------------------------------------------------------------------
# 1. The plan sheet route exists where the plan puts it (§4 layout: src/app/plan.tsx).
need_file src/app/plan.tsx
# 2. Its real screen title is exactly "Route options" (route options or its _layout <Stack.Screen name="plan">), and the header shows (the root Stack hides headers by default).
plan_title src/app/plan.tsx 'Route options'
# 3. The sheet is built from the real parts: the card's list, detail, unavailable state, selectors and leg actions; m10a's Transitous client, polite client and live overlay (+ firstLegVerdict); m7c's verdict engine and copy; m6a's LineBadge; m4b's live context (predictions for the overlay).
plan_reaches src/app/plan.tsx 'src/ui/routes/RouteOptionsList\.tsx$' 'src/ui/routes/ItineraryDetail\.tsx$' 'src/ui/routes/PlanUnavailable\.tsx$' 'src/ui/routes/route-options\.ts$' 'src/ui/routes/leg-actions\.ts$' 'src/domain/routes/transitous\.ts$' 'src/domain/routes/polite-client\.ts$' 'src/domain/routes/overlay\.ts$' 'src/domain/hurry/verdict\.ts$' 'src/ui/hurry/copy\.tsx?$' 'src/ui/primitives/LineBadge\.tsx$' 'src/live/live-context\.tsx$'
# 4. "To" is searchable: the sheet (or a module it reaches) geocodes the typed destination with expo-location's geocodeAsync.
plan_contains src/app/plan.tsx 'geocodeAsync\('
# 5. The attribution text "Routes by Transitous" is in the sheet's code (Transitous's terms for open clients).
plan_contains src/app/plan.tsx 'Routes by Transitous'
# 6. The attribution links exactly https://transitous.org/sources (a whole quoted literal; no other path).
plan_contains src/app/plan.tsx "[\"'\`]https://transitous\.org/sources[\"'\`]"
# 7. Entry points open '/plan': the map tab and the station sheet ("Route from here"), both unconditionally (the saved-trip entry point is m7b's gate).
plan_entry_points
# 8. M10b.1 A, one passing test each: sorted by arrival; row facts; first-leg hurry chip; Live badge; attribution footer; recent places.
m10b_cases src/ui/routes/__tests__ 'route options are sorted by arrival' 'route option shows depart and arrive times, duration, transfers and walk minutes' 'route option shows the first leg hurry chip' 'route option with a live leg shows the Live badge' 'footer credits Routes by Transitous with a link to its sources' 'a planned destination goes first in recent places without duplicates'
# 9. The hurry chip is the REAL verdict: m7c's src/domain/hurry/verdict.ts runs during the chip test (spied, unfiltered run).
hurry_chip_runs_engine 'route option shows the first leg hurry chip'
# 10. Ruling R6: plan.tsx reaches the card's recent-places module (the "To" field offers recent places).
plan_reaches src/app/plan.tsx 'src/ui/routes/recent-places\.ts$'
# 11. Ruling R6 oracle: recent places persist through expo-sqlite/kv-store and survive a reload (jest.resetModules + fresh require), newest first, no duplicates.
recents_survive_reload
# 12. Ruling R6: the Trips tab's empty state offers "Plan a route", and the Trips route's closure links '/plan'.
trips_empty_plans
# 13. Ruling R6, one passing test: the Trips tab's empty state offers Plan a route linking /plan.
m10b_cases src/ui/routes/__tests__ 'Trips tab empty state offers Plan a route linking /plan'

# --- M10b.2 Itinerary detail + directions ---------------------------------------------------------------
# 14. M10b.2 A, one passing test each: walk Directions URL; openURL resolving undefined = opened; rejection shown; transit leg detail; unavailable -> Open in Apple Maps.
m10b_cases src/ui/routes/__tests__ 'walk leg Directions opens Apple Maps walking with dirflg=w' 'walk leg Directions counts openURL resolving undefined as opened' 'walk leg Directions shows the failure when openURL rejects' 'transit leg shows its stations, line badge and Live or Scheduled' 'unavailable routes offer Open in Apple Maps with dirflg=r'
# 15. The card's tests assert the exact values: the maps:// link, walk and transit modes, the attribution text and URL.
need_lits src/ui/routes/__tests__ 'maps://?daddr=' '&dirflg=w' '&dirflg=r' 'https://transitous.org/sources' 'Routes by Transitous'
# 16. Oracle: walkDirectionsUrl({lat: 25.7759, lon: -80.1961}) is exactly 'maps://?daddr=25.7759,-80.1961&dirflg=w'.
leg_actions_oracle walk
# 17. Oracle: transitDirectionsUrl({lat: 25.7759, lon: -80.1961}) is exactly 'maps://?daddr=25.7759,-80.1961&dirflg=r' (the unavailable fallback).
leg_actions_oracle transit
# 18. Oracle (M1.19): openDirections treats ANY openURL resolution (undefined/false/true/null) as opened, and a rejection as an err naming the link, never a throw.
leg_actions_oracle opener
# 19. No non-test card code binds or branches on openURL's resolved value.
openurl_value_unread
# 20. Every jest.mock in the card's tests is a labelled mock of a native module (no stubs of our own code).
native_mocks_labelled src/ui/routes/__tests__

# --- Repo-wide ------------------------------------------------------------------------------------------
# 21. Guarded: the card's modules exist and all 12 named tests pass as their own tests, then tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test are green.
m10b_full_gate
# 22. Guarded: Metro bundles the app for iOS on a tree-private cache, and the iOS JS (--no-bytecode) carries the ./plan.tsx route plus "Routes by Transitous", "Route options", "https://transitous.org/sources" and the Trips tab's "Plan a route" as whole quoted literals (Metro strips comments, so gate 12's text must really ship).
m10b_bundle_carries 'Routes by Transitous' 'Route options' 'https://transitous.org/sources' 'Plan a route'

echo "m10b_routes_ui: all 22 gates green"
