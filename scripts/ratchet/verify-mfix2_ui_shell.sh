#!/usr/bin/env bash
# mfix2_ui_shell — tab headers, honest accessory, tick-time readout (ruling R3): the Stations AND Trips
# tabs get a native header Stack with a real title (content never under the status bar); the interim
# bottom accessory says the schedule end + live status in words, never a feed hash, and still opens
# Data & Settings; Diagnostics shows the map's measured frame-tick time in ms (the M5.13 phone check
# "tick time < 4 ms"); guarded full gate + a --no-bytecode iOS export (no .hbc greps).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side
# does not stop the script); compound checks live inside the card helpers below. Helpers read no
# variable that another gate set. Run one gate alone, from the repo root (sourcing defines lib.sh +
# the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix2_ui_shell.sh
#
# TEST-NAME CONVENTION the named-test gates rely on (same as m6b): each acceptance case is its OWN
# passing test whose full name (describe titles + test title, joined by one space, matched
# case-insensitively) ENDS with the gate's exact phrase, starting at a word boundary: every pin is
# '(^| )<phrase>$'. No phrase in this card is a suffix of another. Phrases use no regex metacharacters.

# ---- card helpers. The import-graph / route-options engine below (_route_graph and its wrappers,
#      _pin_anchored, jest_pin) is copied from verify-m6b_sheets_stations.sh @189a44b, then EXTENDED
#      (2026-10-01, independent-prover fixes): header mode also requires the layout's default export to
#      RETURN its <Stack> and rejects headerTransparent; new commands mounted / calls / drives / nohash
#      (documented at their definitions) back gates 6, 12, 13, 14, 16 and 17.


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
const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n);
const hasModifier = (n, kind) => (ts.getModifiers(n) || []).some((m) => m.kind === kind);
// The layout's default export as a function node: `export default function …`, or `export default X`
// where X is a same-file function declaration or a const arrow / function expression.
function defaultExportFn(sf) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasModifier(stmt, ts.SyntaxKind.ExportKeyword)
      && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) return stmt;
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
    let e = stmt.expression;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (!ts.isIdentifier(e)) return undefined;
    const decl = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name !== undefined && s.name.text === e.text);
    if (decl !== undefined) return decl;
    const init = constInitializer(sf, e.text);
    return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
  }
  return undefined;
}
// The expressions a function itself returns (nested functions' returns excluded); explicit stack, no recursion.
function ownReturns(fn) {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const stack = [fn.body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (ts.isReturnStatement(node)) { out.push(node.expression); continue; }
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) stack.push(child); });
  }
  return out;
}
// The <local> elements in the trees the layout's default export RETURNS: every return must carry one,
// so a <Stack> built but never returned (e.g. the layout returns <Slot />) does not count.
function returnedStacks(lsf, local, layout) {
  const fn = defaultExportFn(lsf);
  if (fn === undefined) fail(`${layout} has no default-exported layout function the AST can read`);
  const returns = ownReturns(fn);
  if (returns.length === 0) fail(`${layout}'s default export returns nothing`);
  const found = [];
  for (const expr of returns) {
    const tree = expr === undefined ? undefined : unwrap(expr, lsf);
    const hits = tree === undefined ? [] : nodesOf(tree.node).filter((n) => (ts.isJsxOpeningElement(n)
      || ts.isJsxSelfClosingElement(n)) && tagOf(n) === local);
    if (hits.length === 0) fail(`${layout}'s default export returns ${expr === undefined ? 'nothing' : JSON.stringify(expr.getText(lsf).slice(0, 80))} — not a tree holding its <${local}>, so the tab has no native header`);
    found.push(...hits);
  }
  return found;
}
// header mode (see the _route_graph comment): a <Stack> in the route's own folder, header shown, real title.
function checkHeader(route) {
  const routeAbs = needFile(route);
  const layoutAbs = path.join(path.dirname(routeAbs), '_layout.tsx');
  const layout = relPath(layoutAbs);
  if (!isFile(layoutAbs)) fail(`${route} has no ${layout} — NativeTabs draws no header (a tab's options.title is only its tab-bar label), so the screen's title needs a native <Stack> layout in the tab's own folder`);
  const lsf = sourceOf(layoutAbs);
  const local = stackName(lsf);
  if (local === null || !openings(lsf).some((el) => tagOf(el) === local)) fail(`${layout} renders no <Stack> from expo-router, so ${route} has no native header to carry a title`);
  const stacks = returnedStacks(lsf, local, layout);
  const leaf = path.basename(routeAbs).replace(/\.tsx?$/, '');
  const named = openings(lsf).filter((el) => isScreen(el) && attrString(el, 'name', lsf) === leaf)
    .map((el) => optionKeys(attrExpr(el, 'options'), lsf));
  const sources = [...ownOptions(routeAbs), ...named, ...stacks.map((el) => optionKeys(attrExpr(el, 'screenOptions'), lsf))];
  const title = pick(sources, 'title');
  if (!realTitle(title)) fail(`${route} has no real header title (found ${JSON.stringify(title)}) — set options.title on a <Stack.Screen> in the route, on <Stack.Screen name="${leaf}"> in ${layout}, or in the Stack's screenOptions; the NativeTabs.Trigger label does not count`);
  if (pick(sources, 'headerShown') === false) fail(`${route}: headerShown is false, so its header title ${JSON.stringify(title)} never shows`);
  const transparent = pick(sources, 'headerTransparent');
  if (transparent !== undefined && transparent !== false) fail(`${route}: headerTransparent is ${JSON.stringify(transparent)} — a transparent header lets the content render under the status bar again; leave it unset or literally false`);
  return `${route} shows the native header title ${JSON.stringify(title)} under the <${local}> its ${layout} returns`;
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
// Value-import bindings in sf of the module at moduleAbs: { local, imported ('default' | name | '*') }.
function bindingsOf(sf, moduleAbs) {
  const out = [];
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause === undefined
      || node.importClause.isTypeOnly || resolveImport(sf.fileName, node.moduleSpecifier.text) !== moduleAbs) continue;
    const clause = node.importClause;
    if (clause.name !== undefined) out.push({ local: clause.name.text, imported: 'default', decl: node });
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) out.push({ local: named.name.text, imported: '*', decl: node });
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (!el.isTypeOnly) out.push({ local: el.name.text, imported: (el.propertyName === undefined ? el.name : el.propertyName).text, decl: node });
    }
  }
  return out;
}
// Calls in sf of a binding (`name(…)`, or `ns.name(…)` through a namespace import) with >= minArgs arguments.
function callsThrough(sf, bindings, minArgs) {
  const direct = new Set(bindings.filter((b) => b.imported !== '*').map((b) => b.local));
  const spaces = new Set(bindings.filter((b) => b.imported === '*').map((b) => b.local));
  return nodesOf(sf).filter((n) => ts.isCallExpression(n) && n.arguments.length >= minArgs
    && ((ts.isIdentifier(n.expression) && direct.has(n.expression.text))
      || (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
        && spaces.has(n.expression.expression.text))));
}
const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
// Uses of a binding outside its own import declaration.
const usesOf = (sf, b) => nodesOf(sf).filter((n) => ts.isIdentifier(n) && n.text === b.local
  && !(n.pos >= b.decl.pos && n.end <= b.decl.end));
function testFiles() {
  const out = [];
  const todo = [absPath('src')];
  for (let g = 0; todo.length > 0 && g < 20000; g += 1) {
    const p = todo.pop();
    if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); continue; }
    if (/\.tsx?$/.test(p) && isTest(relPath(p))) out.push(p);
  }
  return out.sort();
}
// mounted <layout> <outer>: the ONE repo component rendered inside <outer> in the layout (a JSX element
// whose tag is a value import from a ./ ../ @/ module), then every test that value-imports that same
// export from that same module and uses it. Prints the component, then one `TEST <path>` line per test
// (tests whose text names "feed hash" first).
function mountedTests(layout, outer) {
  const lsf = sourceOf(needFile(layout));
  const outers = nodesOf(lsf).filter((n) => ts.isJsxElement(n) && tagOf(n.openingElement) === outer);
  if (outers.length === 0) fail(`${layout} renders no <${outer}> element`);
  const found = new Map();
  for (const o of outers) {
    for (const el of nodesOf(o).filter((n) => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n !== o.openingElement)) {
      if (!ts.isIdentifier(el.tagName)) continue;
      for (const s of lsf.statements.filter((st) => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier))) {
        const target = resolveImport(lsf.fileName, s.moduleSpecifier.text);
        const b = target === null ? undefined : bindingsOf(lsf, target).find((x) => x.local === el.tagName.text && x.imported !== '*');
        if (b !== undefined) found.set(`${b.imported}@${target}`, { name: b.imported, moduleAbs: target });
      }
    }
  }
  if (found.size !== 1) fail(`${layout}: expected ONE repo component rendered inside <${outer}>, found ${found.size} (${[...found.values()].map((c) => `${c.name} from ${relPath(c.moduleAbs)}`).join(', ') || 'none'})`);
  const { name, moduleAbs } = [...found.values()][0];
  const tests = testFiles().filter((t) => bindingsOf(sourceOf(t), moduleAbs)
    .some((b) => b.imported === name && usesOf(sourceOf(t), b).length > 0));
  if (tests.length === 0) fail(`no test value-imports ${name} from ${relPath(moduleAbs)} (the module ${layout} mounts inside <${outer}>) and uses it`);
  const named = (t) => (/feed hash/i.test(fs.readFileSync(t, 'utf8')) ? 0 : 1);
  const ordered = [...tests].sort((x, y) => named(x) - named(y));
  return [`${name} from ${relPath(moduleAbs)} is mounted inside <${outer}>; tests importing it: ${ordered.map(relPath).join(', ')}`,
    ...ordered.map((t) => `TEST ${relPath(t)}`)].join('\n');
}
// calls <module> <minArgs> <entry> <scope-ERE>: a non-test file in entry's closure whose path matches the
// scope (and is not the module itself) CALLS an export of the module with >= minArgs arguments (AST:
// comments, strings and bare imports do not count).
function callsInto(moduleRel, minArgs, entry, scope) {
  const moduleAbs = needFile(moduleRel);
  const re = new RegExp(scope);
  const files = closureOf(needFile(entry)).filter((f) => re.test(f) && !isTest(f) && absPath(f) !== moduleAbs);
  for (const f of files) {
    const sf = sourceOf(absPath(f));
    const hit = callsThrough(sf, bindingsOf(sf, moduleAbs), Number(minArgs))[0];
    if (hit !== undefined) return `${f}:${lineOf(sf, hit)} calls ${hit.expression.getText(sf)}(…) from ${moduleRel} (reached from ${entry})`;
  }
  return fail(`no non-test file reached from ${entry} under /${scope}/ calls an export of ${moduleRel} with >= ${minArgs} argument(s) — importing it is not wiring it (searched: ${files.join(', ') || 'none'})`);
}
// drives <test> <module> <name|*> [<callee-ERE>]: the test value-imports <name> (any export for *) from
// the module and CALLS it (`name(…)` / `ns.name(…)`, AST), and (with an ERE) calls a function whose
// callee text matches.
function drives(testRel, moduleRel, name, callee) {
  const sf = sourceOf(needFile(testRel));
  const moduleAbs = needFile(moduleRel);
  const bs = bindingsOf(sf, moduleAbs).filter((b) => name === '*' || b.imported === name || b.imported === '*');
  const used = bs.filter((b) => callsThrough(sf, [b], 0).length > 0);
  if (used.length === 0) fail(`${testRel} does not value-import ${name === '*' ? 'an export' : name} from ${moduleRel} and call it (found ${bs.length} import binding(s), none called)`);
  if (callee === undefined) return `${testRel} imports and calls ${used.map((b) => b.imported).join(', ')} from ${moduleRel}`;
  const re = new RegExp(callee);
  const call = nodesOf(sf).find((n) => ts.isCallExpression(n) && re.test(n.expression.getText(sf)));
  if (call === undefined) fail(`${testRel} imports ${used.map((b) => b.imported).join(', ')} from ${moduleRel} but never calls /${callee}/ to drive it`);
  return `${testRel} imports ${used.map((b) => b.imported).join(', ')} from ${moduleRel} and calls ${call.expression.getText(sf)}`;
}
// nohash <file>...: no feed hash in the files' code (AST, comments are trivia): no `feedSha256` identifier,
// property or string, and no call of the hash formatter shortFeedHash (its export DECLARATION is fine).
function noHash(files) {
  const hits = [];
  for (const f of files) {
    const sf = sourceOf(needFile(f));
    for (const n of nodesOf(sf)) {
      if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'feedSha256') hits.push(`${f}:${lineOf(sf, n)} reads feedSha256`);
      if (ts.isCallExpression(n) && /(^|\.)shortFeedHash$/.test(n.expression.getText(sf))) hits.push(`${f}:${lineOf(sf, n)} calls shortFeedHash`);
    }
  }
  if (hits.length > 0) fail(`${hits.join('; ')} — the accessory's modules must not touch the feed hash (it stays in Data & Settings / Diagnostics)`);
  return `${files.join(', ')} never read feedSha256 or call shortFeedHash`;
}
function main() {
  if (cmd === 'mounted') return mountedTests(args[0], args[1]);
  if (cmd === 'calls') return callsInto(args[0], args[1], args[2], args[3]);
  if (cmd === 'drives') return drives(args[0], args[1], args[2], args[3]);
  if (cmd === 'nohash') return noHash(args);
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
# calls_into <module> <min-args> <entry> <scope-ERE> — a non-test file in entry's closure under scope
# CALLS an export of module with >= min-args arguments (AST; an import alone is not wiring).
calls_into() { _route_graph calls "$@" || return 1; }
# test_drives <test> <module> <name|*> [<callee-ERE>] — the test value-imports name from module, uses it,
# and (with an ERE) calls a function whose callee text matches it.
test_drives() { _route_graph drives "$@" || return 1; }

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

# stations_screen_titled — MOVED from m6b gate 12 (R3a). The Stations screen shows a native header
# title of its own (route_options header); m5b's labelled NativeTabs.Trigger is the tab-bar label and
# does not count, so this cannot pass on m5b's tab shell. Adjusted for the move: m6b's second clause
# (the route reaches M6.5's LineStrip) stays in m6b (its gate 11), because mfix2 runs BEFORE m6b.
stations_screen_titled() {
  route_options 'src/app/(tabs)/stations/index.tsx' header || return 1
}

# trips_screen_titled — the Trips-tab equivalent (R3a): the same header contract on the Trips route.
trips_screen_titled() {
  route_options 'src/app/(tabs)/trips/index.tsx' header || return 1
}

# card_files — every file this card creates (the two header Stacks, the accessory and tick-time tests,
# the tick-time recorder).
card_files() {
  local f
  for f in 'src/app/(tabs)/stations/_layout.tsx' 'src/app/(tabs)/trips/_layout.tsx' \
    src/ui/diagnostics/__tests__/DataVersionAccessory.test.tsx \
    src/ui/map/tickTime.ts src/ui/map/__tests__/tickTime.test.ts \
    src/ui/diagnostics/__tests__/tick-time-readout.test.tsx; do
    need_file "$f" || return 1
  done
}

# m5b_shell_green — with this card's header Stacks in the tree, m5b's tab-shell and route-titles tests
# (the M5.5 shell: three triggers, accessory kept, every pushed route titled) are still green.
m5b_shell_green() {
  need_file 'src/app/(tabs)/stations/_layout.tsx' || return 1
  need_file 'src/app/(tabs)/trips/_layout.tsx' || return 1
  tabs_declared_after_stacks || return 1
  jest_nonempty src/ui/__tests__/tab-shell.test.tsx || return 1
  jest_nonempty src/ui/__tests__/route-titles.test.tsx || return 1
}

# tabs_declared_after_stacks — a folder that gains a _layout is named by the folder alone, so the
# tab layout's Triggers become name="trips" and name="stations" (m5b's tabs_declared accepts both).
tabs_declared_after_stacks() {
  local layout='src/app/(tabs)/_layout.tsx' tab
  need_file "$layout" || return 1
  for tab in trips stations; do
    grep -qE "<NativeTabs\.Trigger[^>]*name=[\"']${tab}[\"']" "$layout" \
      || { echo "ratchet: $layout has no <NativeTabs.Trigger name=\"$tab\"> — with $tab/_layout.tsx the tab route is the folder"; return 1; }
  done
  grep -qF "<NativeTabs.BottomAccessory" "$layout" \
    || { echo "ratchet: $layout no longer renders <NativeTabs.BottomAccessory>"; return 1; }
}

# mounted_accessory_hides_hash — whatever the tab layout MOUNTS in <NativeTabs.BottomAccessory> (found
# over the AST: the one repo component rendered inside it, and the module the layout imports it from)
# has a passing test that value-imports THAT export from THAT module, named '…accessory text never shows
# a feed hash' (anchored). Before m7c that is DataVersionAccessory (src/ui/diagnostics); once m7c mounts
# NowAccessory in its place (R2) it is NowAccessory (src/ui/now) — so this gate stays true across m7c
# instead of pinning a component m7c unmounts (m7c carries the same pinned case for src/ui/now).
mounted_accessory_hides_hash() {
  local out f
  out=$(_route_graph mounted 'src/app/(tabs)/_layout.tsx' NativeTabs.BottomAccessory) || { echo "$out"; return 1; }
  echo "$out" | head -1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if jest_pin "$f" '(^| )accessory text never shows a feed hash$'; then return 0; fi
  done <<EOF
$(echo "$out" | sed -n 's/^TEST //p')
EOF
  echo "ratchet: no test importing the mounted accessory has a passing case named '…accessory text never shows a feed hash'"
  return 1
}

# accessory_hides_hash_in_code — the interim accessory's own modules never touch the feed hash: no
# `feedSha256` (property, identifier or string) and no shortFeedHash( call in the non-comment code of
# DataVersionAccessory.tsx or data-version.ts, in ANY placement (the inline text included). The
# shortFeedHash export itself stays (Data & Settings' ScheduleSection.tsx calls it).
accessory_hides_hash_in_code() {
  _route_graph nohash src/ui/diagnostics/DataVersionAccessory.tsx src/ui/diagnostics/data-version.ts || return 1
}

# tick_recorder_wired — the map's frame loop CALLS the recorder: a non-test src/ui/map file that
# useVehicleFrames.ts reaches (the hook itself or the frame runner it uses) calls a tickTime.ts export
# with the measured duration (>= 1 argument). An import with no call, or a call of a getter, fails.
tick_recorder_wired() {
  need_file src/ui/map/tickTime.ts || return 1
  calls_into src/ui/map/tickTime.ts 1 src/ui/map/useVehicleFrames.ts '^src/ui/map/' || return 1
}

# tick_readout_wired — the Diagnostics screen CALLS a tickTime.ts export to read what was recorded (a
# non-test file under src/ui/diagnostics/ or the /diagnostics route itself): a constant
# 'Map tick 1.8 ms' with no call into the recorder fails.
tick_readout_wired() {
  need_file src/ui/map/tickTime.ts || return 1
  calls_into src/ui/map/tickTime.ts 0 src/app/diagnostics.tsx '^src/(app/diagnostics\.tsx$|ui/diagnostics/)' || return 1
}

# tick_hook_case — the per-tick case drives the REAL hook: tickTime.test.ts value-imports useVehicleFrames
# from ../useVehicleFrames (or @/ui/map/useVehicleFrames), uses it, and advances jest's fake timers; then
# its own anchored case passes.
tick_hook_case() {
  local test=src/ui/map/__tests__/tickTime.test.ts
  test_drives "$test" src/ui/map/useVehicleFrames.ts useVehicleFrames '^jest\.(advanceTimersByTime|advanceTimersToNextTimer|runOnlyPendingTimers)$' || return 1
  jest_pin "$test" '(^| )every frame tick of useVehicleFrames records its tick time$' || return 1
}

# accessory_reads_live_state — the live status in words comes from the app's one live runtime
# (src/live/live-context.tsx useLive: read state only), and the accessory's own modules start no
# realtime work (REALTIME COST RULE: no watchStations / start / fetch call from the accessory).
accessory_reads_live_state() {
  local f hits rc
  route_reaches src/ui/diagnostics/DataVersionAccessory.tsx 'src/live/live-context\.tsx$' || return 1
  for f in src/ui/diagnostics/DataVersionAccessory.tsx src/ui/diagnostics/data-version.ts; do
    need_file "$f" || return 1
    rc=0
    hits=$(grep -nE '\b(watchStations|fetch)\(|\.start\(' "$f") || rc=$?
    [ "$rc" -le 1 ] || { echo "ratchet: grep failed (rc=$rc) on $f"; return 1; }
    [ -z "$hits" ] || { echo "$hits"; echo "ratchet: $f starts realtime work — the accessory only reads useLive().state"; return 1; }
  done
}

# readout_test_renders — the tick-time readout test renders the REAL Diagnostics screen (it imports
# DiagnosticsScreen, or the /diagnostics route), so "Diagnostics shows the tick time" is about the
# screen Jamie opens, not a readout component tested on its own.
readout_test_renders() {
  local test=src/ui/diagnostics/__tests__/tick-time-readout.test.tsx
  need_file "$test" || return 1
  route_reaches src/app/diagnostics.tsx 'src/ui/diagnostics/DiagnosticsScreen\.tsx$' || return 1
  grep -qE "import[^;]*\b(DiagnosticsScreen|DiagnosticsRoute)\b[^;]*from ['\"](\.\./DiagnosticsScreen|@/ui/diagnostics/DiagnosticsScreen|@/app/diagnostics)['\"]" "$test" \
    || { echo "ratchet: $test does not import DiagnosticsScreen (or the /diagnostics route) — render the real screen"; return 1; }
  # ...and it feeds the recorder the screen reads (it value-imports and calls a tickTime.ts export), so
  # the asserted ms are the recorded ones, not a constant the screen prints.
  test_drives "$test" src/ui/map/tickTime.ts '*' || return 1
}

# card_full_gate — the repo-wide gate, green WITH this card's files in the tree (they are the
# precondition, so the gate cannot pass on a repo where this card was not built).
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# export_registers_stacks — Metro exports the iOS bundle (Hermes, the plan's gate), then a --no-bytecode
# export's JS carries both header-Stack routes as whole string literals (expo-router's require.context
# keys). Never greps the .hbc. Both exports run on a Metro cache private to THIS tree (TMPDIR ->
# .cache/metro-tmp-mfix2; Metro keeps its cache under os.tmpdir()) — m10b's pattern
# (verify-m10b_routes_ui.sh m10b_bundle_carries): Metro's shared cache keys expo-router's _ctx.ios.js
# by project-relative path + content, so a tree whose node_modules is a symlink reused another tree's
# require.context (proven 2026-10-01: this gate's shared-cache export registered only 4 routes on a
# correct build). The private cache never writes into the shared one.
export_registers_stacks() {
  local dir=.cache/export-mfix2-js metro_tmp="$PWD/.cache/metro-tmp-mfix2" out key rc
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  for key in './(tabs)/stations/_layout.tsx' './(tabs)/trips/_layout.tsx'; do
    rc=0
    grep -rqF -e "\"$key\"" -e "'$key'" "$dir/_expo/static/js/ios" || rc=$?
    [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle does not register $key"; return 1; }
    [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  done
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix2_ui_shell gate failed at verify script line $LINENO"' ERR

# ---- gates

# --- (a) Tab headers: no content under the status bar ---
# 1. The Stations tab has its own header Stack layout.
need_file 'src/app/(tabs)/stations/_layout.tsx'
# 2. (moved from m6b gate 12) The Stations screen shows its own native header title (a <Stack> in src/app/(tabs)/stations/_layout.tsx); m5b's tab-bar Trigger label does not count.
stations_screen_titled
# 3. The Trips tab has its own header Stack layout.
need_file 'src/app/(tabs)/trips/_layout.tsx'
# 4. The Trips-tab equivalent of gate 2: its own native header title from a <Stack> in src/app/(tabs)/trips/_layout.tsx.
trips_screen_titled
# 5. With both Stacks in the tree, the tab layout names the folders (Triggers "trips", "stations"), keeps the accessory, and m5b's tab-shell + route-titles tests are green.
m5b_shell_green

# --- (b) Honest interim accessory ---
# 6. A: whatever the tab layout MOUNTS inside <NativeTabs.BottomAccessory> (AST: the component and the module the layout imports it from) has a passing test that imports it from that module, named '…accessory text never shows a feed hash' (DataVersionAccessory now; NowAccessory once m7c replaces it).
mounted_accessory_hides_hash
# 7. A: the rendered accessory text never shows a feed hash (no match for /Data [0-9a-f]{6,}/) in any placement or DB state — its own test.
jest_pin src/ui/diagnostics/__tests__/DataVersionAccessory.test.tsx '(^| )accessory text never shows a feed hash$'
# 8. A: it says when the bundled schedule runs out, in words (e.g. "schedule to Nov 22") — its own test.
jest_pin src/ui/diagnostics/__tests__/DataVersionAccessory.test.tsx '(^| )accessory says the schedule end in words$'
# 9. A: it says the live status in words (e.g. "Live" / "No live data") — its own test.
jest_pin src/ui/diagnostics/__tests__/DataVersionAccessory.test.tsx '(^| )accessory says the live status in words$'
# 10. A: tapping it still opens Data & Settings ('/data') — its own test.
jest_pin src/ui/diagnostics/__tests__/DataVersionAccessory.test.tsx '(^| )tapping the accessory opens data and settings$'
# 11. The live status is read from the app's one live runtime (useLive in src/live/live-context.tsx); the accessory starts no realtime work (REALTIME COST RULE).
accessory_reads_live_state
# 12. The accessory's code never touches the feed hash in any placement: no feedSha256 and no shortFeedHash( call in DataVersionAccessory.tsx or data-version.ts (AST; comments do not count).
accessory_hides_hash_in_code

# --- (c) Tick-time readout (M5.13 gap) ---
# 13. The map's frame loop CALLS the recorder: useVehicleFrames.ts (or the src/ui/map frame runner it reaches) calls a src/ui/map/tickTime.ts export with the measured duration.
tick_recorder_wired
# 14. The Diagnostics screen CALLS the same recorder to read it (src/ui/diagnostics or the /diagnostics route; a constant readout fails).
tick_readout_wired
# 15. A: the recorder keeps the measured frame duration in ms — its own test.
jest_pin src/ui/map/__tests__/tickTime.test.ts '(^| )tick time records the measured frame duration in ms$'
# 16. A: every frame tick useVehicleFrames draws lands in the recorder — the test imports and calls the REAL hook from ../useVehicleFrames and advances fake timers; its own test.
tick_hook_case
# 17. The readout test renders the real Diagnostics screen (DiagnosticsScreen or the /diagnostics route) and calls the tickTime.ts recorder it reads.
readout_test_renders
# 18. A: Diagnostics shows the map tick time in ms (readable against the phone check "tick time < 4 ms") — its own test.
jest_pin src/ui/diagnostics/__tests__/tick-time-readout.test.tsx '(^| )diagnostics shows the map tick time in ms$'

# --- (d) Full gate + iOS export ---
# 19. The card's files exist, then tsc, eslint --max-warnings 0, standards, jest, node:test — all green with them.
card_full_gate
# 20. Metro exports the iOS bundle, and a --no-bytecode export registers both header-Stack routes (both on a Metro cache private to this tree).
export_registers_stacks

echo "mfix2_ui_shell: all 20 gates green"
