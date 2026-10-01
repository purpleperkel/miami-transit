#!/usr/bin/env bash
# m6b_sheets_stations — station sheet (M6.4), Stations tab (M6.5), vehicle sheet with follow mode (M6.6): real-DB selector tests, walk/save-trip footer, native formSheet routes with real titles, wiring, full gate + iOS export.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below. Helpers read no
# variable that another gate set. Run one gate alone, from the repo root (sourcing defines lib.sh +
# the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-m6b_sheets_stations.sh
#
# TEST-NAME CONVENTION the named-test gates rely on: each acceptance case is its OWN passing test
# whose full name (jest: describe titles + test title; node:test: suite names + test name; joined
# by one space, matched case-insensitively) ENDS with the gate's exact phrase, starting at a word
# boundary: every pin is '(^| )<phrase>$'. A name can end only one way, and no phrase in this card is
# a suffix of another, so one catch-all test can satisfy at most one gate. An outer describe/suite in
# front of the phrase is fine. Phrases use no regex metacharacters.

# ---- card helpers (lib.sh has no import-graph, route-options, anchored-pin or real-DB-probe name
#      pin; everything else comes from lib.sh). Every helper fails loud with a named reason.

# _route_graph <cmd> <args>... — one node program over the TypeScript AST (node_modules/typescript),
# walked with explicit stacks/queues (no recursion). Import closure = value imports only (`import type`
# is erased), following ./ ../ and @/ (= src/) specifiers to .ts/.tsx files, plus require()/import().
#   reaches <entry> <ERE>...        every ERE (case-insensitive) matches a repo path in entry's closure
#   shares <ERE> <a> <b>            some non-test module matching ERE is in BOTH closures
#   contains <entry> <ERE>          some non-test file in entry's closure has text matching ERE
#   options <route> sheet|back|header  the route's own options: a <X.Screen> with no `name` in the
#     route file or a non-test component it reaches, or <X.Screen name="<route rel. to the layout>"> in
#     an ancestor _layout.tsx. Option values may be object literals, consts (same file or a named
#     import from a ./ ../ @/ module; `as const` ok), spreads of those, or arrows returning them — not
#     the result of a function call. sheet = presentation 'formSheet' + sheetAllowedDetents +
#     sheetLargestUndimmedDetentIndex; back = a real title + a back label that is not "(tabs)"
#     (headerBackTitle on the route or a navigator's screenOptions, or a real title on the root
#     (tabs) screen); header = a tab screen's own native header title: NativeTabs draws no header (its
#     options.title is only the tab-bar label; Expo's native-tabs guide: nest a native <Stack /> inside
#     the tab for headers), so the route's own folder has a _layout.tsx rendering expo-router's
#     <Stack>, the header is not hidden, and the route has a real title from a nameless <X.Screen
#     options> in its closure, <X.Screen name="index"> in that layout, or the Stack's screenOptions.
#     A NativeTabs.Trigger label never counts.
_route_graph() {
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
const isTest = (f) => f.includes('/__tests__/') || /\.test\.tsx?$/.test(f);
function constInitializer(sf, name) {
  const decl = nodesOf(sf).find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
    && n.name.text === name && n.initializer !== undefined);
  return decl === undefined ? undefined : decl.initializer;
}
// A named import of a const from a ./ ../ or @/ module -> that module's `const <name> = …` initializer.
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
// Follows parens/as/satisfies/!, arrow + function bodies, and same-file or imported consts -> { node, sf }.
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
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
      let value = '<expr>';
      if (ts.isPropertyAssignment(prop)) {
        const init = unwrap(prop.initializer, file);
        if (init !== undefined && ts.isStringLiteralLike(init.node)) value = init.node.text;
        else if (init !== undefined && init.node.kind === ts.SyntaxKind.FalseKeyword) value = false;
        else if (init !== undefined && init.node.kind === ts.SyntaxKind.TrueKeyword) value = true;
      }
      keys.set(prop.name.text, value);
    }
  }
  return keys;
}
const tagOf = (el) => el.tagName.getText(el.getSourceFile());
const openings = (sf) => nodesOf(sf).filter((n) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n));
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
const isScreen = (el) => /(^|\.)Screen$/.test(tagOf(el));
const realTitle = (v) => typeof v === 'string' && v.trim().length > 0 && v.trim() !== '(tabs)';
function pick(maps, key) {
  const hit = maps.find((m) => m.has(key));
  return hit === undefined ? undefined : hit.get(key);
}
// Route-level options: a nameless <X.Screen options> rendered by the route file or by any non-test
// component it reaches (a src/ui sheet component may set its own route's title).
function ownOptions(routeAbs) {
  const own = [];
  for (const file of closureOf(routeAbs).filter((f) => f.endsWith('.tsx') && !isTest(f))) {
    const sf = sourceOf(absPath(file));
    for (const el of openings(sf)) {
      if (isScreen(el) && attrExpr(el, 'name') === undefined) own.push(optionKeys(attrExpr(el, 'options'), sf));
    }
  }
  return own;
}
// The local name a file gives expo-router's Stack (`import { Stack } from 'expo-router'`, aliasing ok).
function stackName(sf) {
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'expo-router') continue;
    const named = node.importClause === undefined ? undefined : node.importClause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => (e.propertyName === undefined ? e.name : e.propertyName).text === 'Stack');
    if (el !== undefined) return el.name.text;
  }
  return null;
}
function routeSources(route) {
  const routeAbs = needFile(route);
  const appRoot = absPath('src/app');
  const own = ownOptions(routeAbs);
  const named = [];
  const navigator = [];
  let tabsTitle = null;
  let dir = path.dirname(routeAbs);
  for (let depth = 0; depth < 12 && dir.startsWith(appRoot); depth += 1) {
    const layout = path.join(dir, '_layout.tsx');
    if (isFile(layout)) {
      const lsf = sourceOf(layout);
      const rel = path.relative(dir, routeAbs).split(path.sep).join('/').replace(/\.tsx?$/, '');
      const names = new Set([rel, rel.replace(/\/index$/, '')]);
      for (const el of openings(lsf)) {
        const name = attrString(el, 'name', lsf);
        if (isScreen(el) && name !== null && names.has(name)) named.push(optionKeys(attrExpr(el, 'options'), lsf));
        if (isScreen(el) && name === '(tabs)' && dir === appRoot) {
          const title = optionKeys(attrExpr(el, 'options'), lsf).get('title');
          if (realTitle(title)) tabsTitle = title;
        }
        if (attrExpr(el, 'screenOptions') !== undefined) navigator.push(optionKeys(attrExpr(el, 'screenOptions'), lsf));
      }
    }
    if (dir === appRoot) break;
    dir = path.dirname(dir);
  }
  return { perRoute: [...own, ...named], navigator, tabsTitle };
}
// header mode (see the _route_graph comment): a <Stack> in the route's own folder, header shown, real title.
function checkHeader(route) {
  const routeAbs = needFile(route);
  const layoutAbs = path.join(path.dirname(routeAbs), '_layout.tsx');
  const layout = relPath(layoutAbs);
  if (!isFile(layoutAbs)) fail(`${route} has no ${layout} — NativeTabs draws no header (a tab's options.title is only its tab-bar label), so the screen's title needs a native <Stack> layout in the tab's own folder`);
  const lsf = sourceOf(layoutAbs);
  const local = stackName(lsf);
  const stacks = local === null ? [] : openings(lsf).filter((el) => tagOf(el) === local);
  if (stacks.length === 0) fail(`${layout} renders no <Stack> from expo-router, so ${route} has no native header to carry a title`);
  const leaf = path.basename(routeAbs).replace(/\.tsx?$/, '');
  const named = openings(lsf).filter((el) => isScreen(el) && attrString(el, 'name', lsf) === leaf)
    .map((el) => optionKeys(attrExpr(el, 'options'), lsf));
  const sources = [...ownOptions(routeAbs), ...named, ...stacks.map((el) => optionKeys(attrExpr(el, 'screenOptions'), lsf))];
  const title = pick(sources, 'title');
  if (!realTitle(title)) fail(`${route} has no real header title (found ${JSON.stringify(title)}) — set options.title on a <Stack.Screen> in the route, on <Stack.Screen name="${leaf}"> in ${layout}, or in the Stack's screenOptions; the NativeTabs.Trigger label does not count`);
  if (pick(sources, 'headerShown') === false) fail(`${route}: headerShown is false, so its header title ${JSON.stringify(title)} never shows`);
  return `${route} shows the native header title ${JSON.stringify(title)} under the <${local}> in ${layout}`;
}
function checkOptions(route, mode) {
  if (mode === 'header') return checkHeader(route);
  const s = routeSources(route);
  const title = pick(s.perRoute, 'title');
  const where = 'a <Stack.Screen options> in the route file, or <Stack.Screen name="…"> in its _layout.tsx';
  if (mode === 'back') {
    if (!realTitle(title)) fail(`${route} has no real title (found ${JSON.stringify(title)}) — set options.title on ${where}`);
    const back = pick(s.perRoute, 'headerBackTitle') ?? pick(s.navigator, 'headerBackTitle');
    if (!realTitle(back) && s.tabsTitle === null) fail(`${route}: nothing sets a real back label, so iOS shows "(tabs)" (M1.19) — set headerBackTitle on the route or its navigator's screenOptions, or a title on the root (tabs) screen`);
    return `${route} has title ${JSON.stringify(title)} and back label ${JSON.stringify(realTitle(back) ? back : s.tabsTitle)}`;
  }
  if (mode === 'sheet') {
    const presentation = pick(s.perRoute, 'presentation');
    if (presentation !== 'formSheet') fail(`${route} is not a native formSheet (presentation = ${JSON.stringify(presentation)}) — set it on ${where}`);
    for (const key of ['sheetAllowedDetents', 'sheetLargestUndimmedDetentIndex']) {
      if (pick(s.perRoute, key) === undefined) fail(`${route} formSheet has no ${key} — the sheet needs detents and an undimmed medium detent so the map stays usable`);
    }
    return `${route} is a formSheet with detents and an undimmed detent`;
  }
  return fail(`unknown options mode '${mode}'`);
}
function main() {
  if (cmd === 'reaches') {
    const [entry, ...patterns] = args;
    const files = closureOf(needFile(entry));
    const missing = patterns.filter((p) => !files.some((f) => new RegExp(p, 'i').test(f)));
    if (missing.length > 0) fail(`${entry} never imports (directly or transitively) a module matching ${missing.map((p) => `/${p}/i`).join(', ')}; it reaches: ${files.filter((f) => f.startsWith('src/')).join(', ')}`);
    return `${entry} reaches ${patterns.map((p) => `/${p}/i`).join(', ')}`;
  }
  if (cmd === 'shares') {
    const [pattern, a, b] = args;
    const re = new RegExp(pattern, 'i');
    const inA = closureOf(needFile(a)).filter((f) => re.test(f) && !isTest(f));
    const inB = new Set(closureOf(needFile(b)).filter((f) => re.test(f) && !isTest(f)));
    const both = inA.filter((f) => inB.has(f));
    if (both.length === 0) fail(`no module matching /${pattern}/i is imported by both ${a} [${inA.join(', ') || 'none'}] and ${b} [${[...inB].join(', ') || 'none'}]`);
    return `${a} and ${b} both run ${both.join(', ')}`;
  }
  if (cmd === 'contains') {
    const [entry, pattern] = args;
    const re = new RegExp(pattern);
    const files = closureOf(needFile(entry)).filter((f) => !isTest(f));
    const hit = files.find((f) => re.test(fs.readFileSync(absPath(f), 'utf8')));
    if (hit === undefined) fail(`no module reached from ${entry} contains /${pattern}/ (searched: ${files.join(', ')})`);
    return `${hit} (reached from ${entry}) contains /${pattern}/`;
  }
  if (cmd === 'options') return checkOptions(args[0], args[1]);
  return fail(`unknown _route_graph command '${cmd}'`);
}
console.log(`OK ${main()}`);
NODE
}

# route_reaches <entry> <ERE>... — the entry route exists and its import closure reaches every ERE.
route_reaches() { _route_graph reaches "$@" || return 1; }
# route_shares <ERE> <a> <b> — a module matching ERE is imported by both a's and b's closures.
route_shares() { _route_graph shares "$@" || return 1; }
# closure_contains <entry> <ERE> — a non-test module reached from entry contains ERE.
closure_contains() { _route_graph contains "$@" || return 1; }
# route_options <route> sheet|back|header — the route's own Screen options (see _route_graph).
route_options() { _route_graph options "$@" || return 1; }

# _pin_anchored <pattern> — authoring guard for the TEST-NAME CONVENTION: a pin must end in `$`.
_pin_anchored() {
  case "$1" in
    *'$') return 0 ;;
    *) echo "ratchet: test-name pin '$1' must end in \$ so each acceptance case needs its own test"; return 1 ;;
  esac
}

# jest_pin <path> <'(^| )phrase$'> — lib's jest_nonempty (jest -t is new RegExp(pin, 'i') on the full
# name; >= 1 test passed) with an anchored pin, so the passing test is this case's own.
jest_pin() {
  _pin_anchored "$2" || return 1
  jest_nonempty "$1" "$2" || return 1
}

# nodetest_real_case <file> <'(^| )phrase$'> — lib's nodetest_case contract (full-name match, real
# passing leaves only, no fail/skip/todo/cancelled; Node 26 matches --test-name-pattern against the
# full "suite … test" name, as lib's leaf counter does) with an anchored pin, PLUS the run queried
# assets/db/schedule.db in place: a probe on DatabaseSync.prototype.{prepare,createTagStore},
# imported BEFORE tsx (m3a's proven order), logs every DB file the test process queries.
nodetest_real_case() {
  local file="$1" pat="$2" out lc n db probe
  _pin_anchored "$pat" || return 1
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  db="$(pwd -P)/assets/db/schedule.db"
  probe='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?String(db.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","createTagStore"]){const f=D.prototype[k];D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}'
  out=$(node --import "$probe" --import tsx --test --test-reporter=tap "--test-name-pattern=/$pat/i" "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: tests matching /$pat/i are red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  lc=$(printf '%s' "$pat" | tr '[:upper:]' '[:lower:]')
  n=$(echo "$out" | _nodetest_count "$lc" "$file")
  [ "$n" -ge 1 ] || { echo "$out" | tail -10; echo "ratchet: no passing test named /$pat/i in $file"; return 1; }
  grep -qF "ratchet-db-open: $db" <<<"$out" \
    || { grep -F 'ratchet-db-open:' <<<"$out" || echo '(no DB was queried)'; echo "ratchet: /$pat/i in $file never queried $db — selector acceptance runs on the real schedule DB, in place"; return 1; }
}

# stations_screen_titled — this card's refined Stations screen (the tab route renders M6.5's LineStrip)
# shows a native header title of its own (route_options header). m5b's labelled NativeTabs.Trigger is
# the tab-bar label and does not count, so this cannot pass on m5b's tab shell.
stations_screen_titled() {
  route_options 'src/app/(tabs)/stations/index.tsx' header || return 1
  route_reaches 'src/app/(tabs)/stations/index.tsx' 'src/ui/stations/LineStrip\.tsx$' || return 1
}

# row_opens_station_sheet — the station sheet route (this card's own artifact) exists, and code reached
# from the Stations tab routes to '/station/…'. A link to a route that does not exist yet proves nothing.
row_opens_station_sheet() {
  need_file 'src/app/station/[stationKey].tsx' || return 1
  closure_contains 'src/app/(tabs)/stations/index.tsx' '[\x22\x27\x60]/station/' || return 1
}

# card_files — every file this card creates (plan M6.4–M6.6 F lists + the Stations tab's header Stack).
card_files() {
  local f
  for f in 'src/app/station/[stationKey].tsx' 'src/app/vehicle/[vehicleKey].tsx' 'src/app/(tabs)/stations/_layout.tsx' \
    src/ui/stations/StationSheetFooter.tsx src/ui/stations/StationRow.tsx src/ui/stations/LineStrip.tsx; do
    need_file "$f" || return 1
  done
}

# card_full_gate — the repo-wide gate, green WITH this card's files in the tree (they are the
# precondition, so the gate cannot pass on a repo where this card was not built).
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# export_bundles_routes — Metro exports the iOS bundle and the bundle registers this card's routes:
# expo-router's require.context keys ('./station/[stationKey].tsx', …) are plain strings in the Hermes
# bytecode string table (checked on the M1 export: './(tabs)/index.tsx' and './(tabs)/_layout.tsx'
# are present byte for byte).
export_bundles_routes() {
  card_files || return 1
  ios_export || return 1
  node - <<'NODE' || return 1
const fs = require('node:fs');
const meta = JSON.parse(fs.readFileSync('.cache/export/metadata.json', 'utf8'));
const bundle = `.cache/export/${meta.fileMetadata.ios.bundle}`;
const bytes = fs.readFileSync(bundle);
const routes = ['./station/[stationKey].tsx', './vehicle/[vehicleKey].tsx', './(tabs)/stations/index.tsx', './(tabs)/stations/_layout.tsx'];
const missing = routes.filter((r) => bytes.indexOf(Buffer.from(r, 'utf8')) < 0);
if (missing.length > 0) { console.log(`ratchet: the iOS bundle ${bundle} does not register: ${missing.join(', ')}`); process.exit(1); }
console.log(`OK the iOS bundle ${bundle} registers ${routes.join(', ')}`);
NODE
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m6b_sheets_stations gate failed at verify script line $LINENO"' ERR

# ---- gates

# --- M6.4 Station sheet ---
# 1. The station route exists and is a native formSheet with detents and an undimmed detent (the map stays usable under it, M6.7).
route_options 'src/app/station/[stationKey].tsx' sheet
# 2. The station route has a real title and a back label that is not "(tabs)" (M1.19 phone finding).
route_options 'src/app/station/[stationKey].tsx' back
# 3. The sheet renders M6.3's DirectionGroup and its own footer, with live predictions merged in (live-context + M4.7 merge-departures).
route_reaches 'src/app/station/[stationKey].tsx' 'src/ui/departures/direction-?group\.tsx$' 'src/ui/stations/StationSheetFooter\.tsx$' 'src/live/live-context\.tsx$' 'src/domain/live/merge-departures\.ts$'
# 4. A (M6.4): a trunk station (Government Center, Wed 08:00) gives exactly 2 direction groups — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-sheet-real.test.ts '(^| )Government Center trunk station gives 2 direction groups$'
# 5. A (M6.4): Palmetto gives exactly 1 direction group (terminating trains are not departures) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-sheet-real.test.ts '(^| )Palmetto gives 1 direction group$'
# 6. The real-DB test exercises the same station-sheet selector module the route runs.
route_shares '/station-sheet\.tsx?$' 'src/app/station/[stationKey].tsx' scripts/gtfs/__tests__/station-sheet-real.test.ts
# 7. A (M6.4): the footer offers walk directions as an Apple Maps link with dirflg=w to the station — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )walk directions open Apple Maps with dirflg=w to the station$'
# 8. A (M6.4): the footer offers save trip, starting a trip from this station — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )save trip starts a trip from this station$'
# 9. Handoff rule (M1.19 RESULT): openURL resolving undefined (RN's Promise<void>) counts as opened — never read the resolved value; its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )openURL resolving undefined counts as opened$'
# 10. Handoff rule (M1.19 RESULT): openURL rejecting is the only failure, and the footer shows it — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )openURL rejecting shows the failure$'

# --- M6.5 Stations tab ---
# 11. The Stations tab route renders StationRow, which draws LineStrip (this card's refinement of m5b's plain list).
route_reaches 'src/app/(tabs)/stations/index.tsx' 'src/ui/stations/StationRow\.tsx$' 'src/ui/stations/LineStrip\.tsx$'
# 12. The refined Stations screen shows its own native header title (a <Stack> in src/app/(tabs)/stations/_layout.tsx); m5b's tab-bar Trigger label does not count.
stations_screen_titled
# 13. A station row opens the station sheet: the station route exists and code reached from the tab routes to '/station/…'.
row_opens_station_sheet
# 14. A (M6.5): the Metrorail section lists 23 stations — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )Metrorail section lists 23 stations$'
# 15. A (M6.5): every trunk row (Green + Orange) has 2 strip segments — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )every trunk row has 2 strip segments$'
# 16. A (M6.5): the Airport row has 1 strip segment (Orange) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )Airport row has 1 strip segment$'
# 17. The real-DB test exercises the same station-list selector module the tab runs.
route_shares '/station-list\.tsx?$' 'src/app/(tabs)/stations/index.tsx' scripts/gtfs/__tests__/station-list-real.test.ts
# 18. Never color alone (§4): LineStrip's accessibility label names every line it draws — its own test.
jest_pin src/ui/stations/__tests__/LineStrip.test.tsx '(^| )LineStrip accessibility label names every line$'

# --- M6.6 Vehicle sheet with follow mode ---
# 19. The vehicle route exists and is a native formSheet with detents and an undimmed detent (the followed vehicle stays visible).
route_options 'src/app/vehicle/[vehicleKey].tsx' sheet
# 20. The vehicle route has a real title and a back label that is not "(tabs)".
route_options 'src/app/vehicle/[vehicleKey].tsx' back
# 21. A (M6.6): for every scheduled vehicle at Wed 08:00 the next-stops selector returns at most 3 stops in ascending order — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/repo-next-stops.test.ts '(^| )next stops for every vehicle at Wed 08:00 are at most 3 in ascending order$'
# 22. Card addition: an Inner Loop car near the end of its half-trip continues onto next_trip_idx (the car keeps going) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/repo-next-stops.test.ts '(^| )next stops of an Inner Loop car continue onto next_trip_idx$'
# 23. The real-DB test exercises the same next-stops module the vehicle route runs.
route_shares '/next-stops\.tsx?$' 'src/app/vehicle/[vehicleKey].tsx' scripts/gtfs/__tests__/repo-next-stops.test.ts
# 24. Follow mode keeps the camera centered on the followed vehicle — its own test (anywhere under src/ui).
jest_pin src/ui '(^| )follow mode keeps the camera centered on the followed vehicle$'
# 25. Follow mode ends on a user map gesture — its own test (anywhere under src/ui).
jest_pin src/ui '(^| )follow mode ends on a user map gesture$'
# 26. The vehicle sheet's follow toggle and the map (M5.12 TransitMap) share one follow module.
route_shares '/[^/]*follow[^/]*\.tsx?$' 'src/app/vehicle/[vehicleKey].tsx' src/ui/map/TransitMap.tsx

# --- Repo-wide ---
# 27. npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest, node:test) is green with this card's files in the tree.
card_full_gate
# 28. Metro exports the iOS bundle and it registers the station, vehicle and Stations-tab routes and the Stations header Stack.
export_bundles_routes

echo "m6b_sheets_stations: all 28 gates green"
