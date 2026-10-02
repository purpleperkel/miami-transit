#!/usr/bin/env bash
# m6b_sheets_stations — station sheet (M6.4), Stations tab (M6.5), vehicle sheet with follow mode (M6.6), M7.6 Apple Maps handoff (R5), useful Stations rows (R7: scheduled next departures inline, nearest first, zero live calls), a verdict slot in the sheet header for m7c: real-DB selector tests, walk-directions footer, native formSheet routes with real titles, wiring, full gate + iOS export.
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
#   avoids <entry> <ERE>            NO non-test module in entry's closure has a path matching ERE
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
// renders mode: the local names a test file gives the REAL Stations list (StationsScreen's named
// export, or the tab route's default export), and whether the file jest-mocks either module away.
const LIST_MODULES = [['src/ui/stations/StationsScreen.tsx', 'StationsScreen'], ['src/app/(tabs)/stations/index.tsx', 'default']];
const listModuleOf = (sf, spec) => {
  const target = resolveImport(sf.fileName, spec);
  return target === null ? undefined : LIST_MODULES.find(([file]) => relPath(target) === file);
};
function listBindings(sf) {
  const names = new Set();
  for (const node of sf.statements) {
    if (!ts.isImportDeclaration(node) || typeOnly(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const hit = listModuleOf(sf, node.moduleSpecifier.text);
    const clause = node.importClause;
    if (hit === undefined || clause === undefined) continue;
    if (hit[1] === 'default' && clause.name !== undefined) names.add(clause.name.text);
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (!el.isTypeOnly && (el.propertyName === undefined ? el.name : el.propertyName).text === hit[1]) names.add(el.name.text);
    }
  }
  return names;
}
const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text
  : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '');
const calls = (root) => nodesOf(root).filter((n) => ts.isCallExpression(n));
const titleFits = (title, phrase) => {
  const [t, p] = [title.toLowerCase(), phrase.toLowerCase()];
  const [long, short] = t.length >= p.length ? [t, p] : [p, t];
  return long.endsWith(short) && (long.length === short.length || long[long.length - short.length - 1] === ' ');
};
const notCalled = (call) => {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'toHaveBeenCalled') return ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'not';
  return callee.name.text === 'toHaveBeenCalledTimes' && call.arguments.length === 1
    && ts.isNumericLiteral(call.arguments[0]) && Number(call.arguments[0].text) === 0;
};
// The pinned test's OWN callback renders the real list (render(…)/create(…) whose argument holds a
// JSX element of an imported list binding) and only AFTER that asserts a spy was not called.
function checkRendersList(test, phrase) {
  const sf = sourceOf(needFile(test));
  const names = listBindings(sf);
  if (names.size === 0) fail(`${test} imports neither StationsScreen from src/ui/stations/StationsScreen.tsx nor the default export of src/app/(tabs)/stations/index.tsx, so it never renders the real list`);
  const mocked = calls(sf).filter((c) => ['mock', 'doMock'].includes(calleeName(c)) && c.arguments.length > 0
    && ts.isStringLiteralLike(c.arguments[0]) && listModuleOf(sf, c.arguments[0].text) !== undefined);
  if (mocked.length > 0) fail(`${test} jest-mocks the Stations list module itself (${mocked.map((c) => c.arguments[0].text).join(', ')}), so the spy watches a fake list`);
  const tests = calls(sf).filter((c) => ['it', 'test'].includes(calleeName(c)) && c.arguments.length >= 2
    && ts.isStringLiteralLike(c.arguments[0]) && titleFits(c.arguments[0].text, phrase));
  if (tests.length === 0) fail(`${test} has no it()/test() with a static title ending the phrase '${phrase}'`);
  for (const t of tests) {
    const body = t.arguments[t.arguments.length - 1];
    const renders = calls(body).filter((c) => ['render', 'create'].includes(calleeName(c)) && c.arguments.length > 0
      && openings(sf).some((el) => names.has(tagOf(el)) && el.pos >= c.arguments[0].pos && el.end <= c.arguments[0].end));
    const asserts = calls(body).filter(notCalled);
    const first = renders.reduce((min, c) => Math.min(min, c.pos), Infinity);
    if (renders.length > 0 && asserts.some((a) => a.pos > first)) {
      return `${test}: '${t.arguments[0].text}' renders <${[...names].join('|')}> with ${calleeName(renders[0])}(…) and then asserts a spy was not called`;
    }
  }
  return fail(`${test}: the test titled for '${phrase}' never renders the real list (render(…)/create(…) of <${[...names].join('|')}>) inside its own callback before asserting not.toHaveBeenCalled()/toHaveBeenCalledTimes(0)`);
}
// clean mode: the source of every non-test module in the closure, with comments blanked out.
const isJsDoc = (n) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
function codeOnly(abs) {
  const sf = sourceOf(abs);
  const text = sf.getFullText();
  const ranges = new Map();
  const stack = [sf];
  while (stack.length > 0) {
    const node = stack.pop();
    const found = [...(ts.getLeadingCommentRanges(text, node.getFullStart()) || []), ...(ts.getTrailingCommentRanges(text, node.getEnd()) || [])];
    for (const r of found) ranges.set(r.pos, r.end);
    for (const child of node.getChildren(sf)) if (!isJsDoc(child)) stack.push(child);
  }
  let out = text;
  for (const [pos, end] of ranges) out = out.slice(0, pos) + ' '.repeat(end - pos) + out.slice(end);
  return out;
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
  if (cmd === 'avoids') {
    const [entry, pattern] = args;
    const re = new RegExp(pattern, 'i');
    const files = closureOf(needFile(entry));
    const hits = files.filter((f) => re.test(f) && !isTest(f));
    if (hits.length > 0) fail(`${entry} imports (directly or transitively) ${hits.join(', ')}, matching /${pattern}/i — that code must stay out of its closure`);
    return `${entry} reaches no module matching /${pattern}/i (${files.length} modules checked)`;
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
  if (cmd === 'renders') return checkRendersList(args[0], args[1]);
  if (cmd === 'clean') {
    const [entry, pattern] = args;
    const re = new RegExp(pattern);
    const files = closureOf(needFile(entry)).filter((f) => !isTest(f));
    const hits = files.filter((f) => re.test(codeOnly(absPath(f))))
      .map((f) => { const lines = codeOnly(absPath(f)).split('\n'); const i = lines.findIndex((l) => re.test(l)); return `${f}:${i + 1}`; });
    if (hits.length > 0) fail(`${entry} reaches code matching /${pattern}/ outside comments: ${hits.join(', ')}`);
    return `no non-test module reached from ${entry} has code matching /${pattern}/ (${files.length} modules, comments ignored)`;
  }
  return fail(`unknown _route_graph command '${cmd}'`);
}
console.log(`OK ${main()}`);
NODE
}

# route_reaches <entry> <ERE>... — the entry route exists and its import closure reaches every ERE.
route_reaches() { _route_graph reaches "$@" || return 1; }
# route_shares <ERE> <a> <b> — a module matching ERE is imported by both a's and b's closures.
route_shares() { _route_graph shares "$@" || return 1; }
# route_avoids <entry> <ERE> — the entry exists and no non-test module in its closure matches ERE.
route_avoids() { _route_graph avoids "$@" || return 1; }
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

# nodetest_real_case <file> <'(^| )phrase$'> [table] — lib's nodetest_case contract (static titles: no
# test file reads process.argv/execArgv; ONE UNFILTERED run — no --test-name-pattern a title could adapt
# to — matched here on the full "suite … test" name; real passing leaves only; no fail/skip/todo/
# cancelled) with an anchored pin, PLUS the run queried assets/db/schedule.db in place: a probe on
# DatabaseSync.prototype.{prepare,createTagStore}, imported BEFORE tsx (m3a's proven order), logs
# every DB file the test process queries and the text of every SQL statement run on it. With [table],
# some SQL the file's run sent to the real DB must name that table as a word (gate 22: stop_time —
# scripts/gtfs/schema.ts — so hardcoded times beside a trivial `select 1` cannot pass).
nodetest_real_case() {
  local file="$1" pat="$2" table="${3:-}" out lc n db probe
  _pin_anchored "$pat" || return 1
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  _no_argv_in_tests "$file" || return 1
  db="$(pwd -P)/assets/db/schedule.db"
  probe='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const at=(db)=>db.isOpen?String(db.location()):"closed";const log=(db)=>{const l=at(db);if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};const sql=(db,q)=>process.stderr.write("ratchet-db-sql: "+at(db)+" :: "+String(q).replace(/\s+/g," ")+"\n");const p=D.prototype.prepare;D.prototype.prepare=function(...a){log(this);sql(this,a[0]);return p.apply(this,a)};const t=D.prototype.createTagStore;if(typeof t==="function"){D.prototype.createTagStore=function(...a){log(this);const db=this;const s=t.apply(this,a);for(const k of ["all","get","iterate","run"]){const f=s[k];if(typeof f==="function"){s[k]=function(q,...v){sql(db,Array.isArray(q)?q.join(" "):q);return f.call(this,q,...v)}}}return s}}'
  out=$(node --import "$probe" --import tsx --test --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file (unfiltered run)"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  lc=$(printf '%s' "$pat" | tr '[:upper:]' '[:lower:]')
  n=$(echo "$out" | _nodetest_count "$lc" "$file")
  [ "$n" -ge 1 ] || { echo "$out" | tail -10; echo "ratchet: no passing test named /$pat/i in $file"; return 1; }
  grep -qF "ratchet-db-open: $db" <<<"$out" \
    || { grep -F 'ratchet-db-open:' <<<"$out" || echo '(no DB was queried)'; echo "ratchet: /$pat/i in $file never queried $db — selector acceptance runs on the real schedule DB, in place"; return 1; }
  [ -z "$table" ] && return 0
  grep -F "ratchet-db-sql: $db :: " <<<"$out" | grep -qiE "(^|[^a-z0-9_])${table}([^a-z0-9_]|$)" \
    || { grep -F "ratchet-db-sql: $db :: " <<<"$out" | sed 's/^.* :: /  sql: /' | sort -u | head -12; echo "ratchet: /$pat/i in $file: no SQL on $db names the $table table — the acceptance values must come from the real schedule, not hardcoded"; return 1; }
}

# ---- M7.6 Apple Maps handoff helpers (R5: moved VERBATIM from verify-m7b_trips_ui.sh with its gates
#      7–9; only the report file name changed). These use m7b's multi-case convention, scoped to
#      src/domain/handoff: a pinned case is a case-insensitive SUBSTRING of a passing test's full name,
#      and counts only through a test whose name carries NO OTHER name from JEST_CASES below.
JEST_CASES=(
  "transit url" "walk url" "fallback url"
  "openURL resolving undefined" "openURL resolving false" "openURL rejects falls back"
)

# need_lits <file-or-dir> <string>... — the path exists and contains EVERY fixed string (tests included).
need_lits() {
  local path="$1" s; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  for s in "$@"; do
    grep -rqF -- "$s" "$path" || { echo "ratchet: '$s' does not appear in $path"; return 1; }
  done
}

# need_pure_export <file> <name>... — the module loads under plain Node through tsx (so it pulls in no
# react-native/expo code at runtime) and exports each <name> as a function.
need_pure_export() {
  local file="$1"; shift
  need_file "$file" || return 1
  local_bin tsx --version >/dev/null || return 1
  node --import tsx -e '
const [file, ...names] = process.argv.slice(1);
const href = require("node:url").pathToFileURL(require("node:path").resolve(file)).href;
import(href).then((m) => {
  const missing = names.filter((n) => typeof m[n] !== "function");
  if (missing.length > 0) { console.log(`ratchet: ${file} does not export function(s): ${missing.join(", ")}`); process.exit(1); }
  console.log(`${file} loads under plain Node and exports ${names.join(", ")}`);
}, (e) => { console.log(`ratchet: ${file} does not load under plain Node (tsx): ${e.message}`); process.exit(1); });
' "$file" "$@" || return 1
}

# order_stations_by_location — gate 26: R7's ordering module is pure (need_pure_export) AND, probed here on
# the REAL module with the real rail stations (assets/db/schedule.db, mode 0, in station_idx order), it
# honours the location. Pinned signature (card note):
#   orderStations<S extends LatLon>(stations: readonly S[], location: LatLon | null)
#     : readonly { station: S; walkingMeters: number | null }[]     (LatLon = src/lib/geo.ts)
# Near Brickell: the first row is rail:brickell, every walkingMeters is a finite number >= 0, in
# ascending order, the first under 1 km and the last over 10 km. Near Dadeland South: the first row is
# rail:dadeland-south and the order differs from Brickell's. No location: every station once, every
# walkingMeters null, and the order is identical across calls.
order_stations_by_location() {
  local file=src/domain/stations/order-stations.ts
  need_pure_export "$file" orderStations || return 1
  node --import tsx -e '
const { DatabaseSync } = require("node:sqlite");
const file = process.argv[1];
const db = new DatabaseSync("assets/db/schedule.db", { readOnly: true });
const stations = db.prepare("SELECT station_key AS key, lat AS latitude, lon AS longitude FROM station WHERE mode = 0 ORDER BY station_idx").all().map((r) => ({ ...r }));
db.close();
const bad = (msg) => { console.log(`ratchet: ${file} orderStations: ${msg}`); process.exit(1); };
if (stations.length !== 23) bad(`probe expected 23 rail stations in the DB, found ${stations.length}`);
const at = (key) => { const s = stations.find((x) => x.key === key); return { latitude: s.latitude + 0.001, longitude: s.longitude }; };
import(require("node:url").pathToFileURL(require("node:path").resolve(file)).href).then(({ orderStations }) => {
  const run = (loc, label) => {
    const rows = orderStations(stations.map((s) => ({ ...s })), loc);
    if (!Array.isArray(rows) || rows.length !== stations.length) bad(`${label}: expected ${stations.length} rows, got ${JSON.stringify(rows).slice(0, 120)}`);
    const keys = rows.map((r) => (r && r.station ? r.station.key : undefined));
    if (new Set(keys).size !== stations.length || keys.some((k) => !stations.some((s) => s.key === k))) bad(`${label}: rows must carry every input station once as row.station (got ${keys.join(",")})`);
    return { keys, meters: rows.map((r) => r.walkingMeters) };
  };
  const check = (key, label) => {
    const r = run(at(key), label);
    if (r.keys[0] !== key) bad(`${label}: the first row is ${r.keys[0]}, not ${key}`);
    if (!r.meters.every((m) => typeof m === "number" && Number.isFinite(m) && m >= 0)) bad(`${label}: walkingMeters must be finite numbers >= 0 (got ${r.meters.join(",")})`);
    if (r.meters.some((m, i) => i > 0 && m < r.meters[i - 1])) bad(`${label}: walkingMeters are not ascending (${r.meters.join(",")})`);
    if (!(r.meters[0] < 1000 && r.meters[r.meters.length - 1] > 10000)) bad(`${label}: walkingMeters do not look like metres (first ${r.meters[0]}, last ${r.meters[r.meters.length - 1]})`);
    return r.keys.join(",");
  };
  const brickell = check("rail:brickell", "near Brickell");
  const dadeland = check("rail:dadeland-south", "near Dadeland South");
  if (brickell === dadeland) bad("moving the location from Brickell to Dadeland South did not change the order");
  const [a, b] = [run(null, "no location"), run(null, "no location, again")];
  if (![...a.meters, ...b.meters].every((m) => m === null)) bad("without a location every walkingMeters must be null");
  if (a.keys.join(",") !== b.keys.join(",")) bad("without a location the order differs between calls");
  console.log(`${file}: nearest-first from Brickell and Dadeland South (orders differ); stable null-distance fallback without a location`);
}, (e) => bad(`does not load: ${e.message}`)).catch((e) => bad(`threw: ${e.message}`));
' "$file" || return 1
}

# named_cases <where> <case>... — stdin: one "<status><TAB><full test name>" line per test. Every <case>
# must name >= 1 test, all such tests passed, and >= 1 of them carries no other name from CASE_UNIVERSE
# (newline-separated; defaults to this call's own cases).
named_cases() {
  local where="$1" universe; shift
  [ "$#" -ge 1 ] || { echo "ratchet: named_cases needs at least one case"; return 1; }
  universe="${CASE_UNIVERSE:-$(printf '%s\n' "$@")}"
  CASE_UNIVERSE="$universe" node -e '
const [where, ...wanted] = process.argv.slice(1);
const universe = process.env.CASE_UNIVERSE.split("\n").filter(Boolean).map((s) => s.toLowerCase());
const tests = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean)
  .map((l) => ({ status: l.slice(0, l.indexOf("\t")), name: l.slice(l.indexOf("\t") + 1).toLowerCase() }));
const problems = [];
for (const a of universe) for (const b of universe) {
  if (a !== b && b.includes(a)) problems.push(`authoring error: pinned name "${a}" is inside "${b}"`);
}
for (const w of wanted.map((s) => s.toLowerCase())) {
  if (!universe.includes(w)) { problems.push(`authoring error: "${w}" is not a pinned case of this card`); continue; }
  const named = tests.filter((t) => t.name.includes(w));
  const own = named.filter((t) => universe.every((o) => o === w || !t.name.includes(o)));
  if (named.length === 0) problems.push(`no test named like "${w}"`);
  else if (named.some((t) => t.status !== "passed")) problems.push(`a test named like "${w}" did not pass`);
  else if (own.length === 0) problems.push(`every test named like "${w}" also carries another pinned name — give "${w}" its own test`);
}
if (problems.length > 0) { console.log(`ratchet: ${where}: ${problems.join("; ")}`); process.exit(1); }
console.log(`ratchet: ${where}: ${tests.length} tests green; named cases: ${wanted.join(" | ")}`);
' "$where" "$@" || return 1
}

# jest_cases <file-or-dir> <case>... — ONE local-jest run over the path (a dir runs every test file under
# it) with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo, then named_cases against
# the card-wide JEST_CASES. (lib's `jest_nonempty <path> <name>` cannot pin several cases: a -t filter
# reports every excluded test as skipped.)
jest_cases() {
  local path="$1" report out names; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/m6b_sheets_stations.$(printf '%s' "$path" | tr '/' '_').json"
  rm -f "$report"
  out=$(local_bin jest --ci "$path" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest red (or not installed) under $path"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; echo "ratchet: jest wrote no JSON report for $path"; return 1; }
  names=$(node -e '
const [report, path] = process.argv.slice(1);
const r = JSON.parse(require("node:fs").readFileSync(report, "utf8"));
const bad = [];
if (r.success !== true) bad.push("jest reported success=false");
if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) bad.push("failing tests/suites");
if (r.numPendingTests > 0 || r.numTodoTests > 0) bad.push("skipped/todo tests are forbidden");
if (r.numPassedTests < 1) bad.push("no test passed");
if (bad.length > 0) { console.error(`ratchet: ${path}: ${bad.join("; ")}`); process.exit(1); }
for (const suite of r.testResults) for (const t of suite.assertionResults) console.log(`${t.status}\t${t.fullName}`);
' "$report" "$path") || return 1
  printf '%s\n' "$names" | CASE_UNIVERSE="$(printf '%s\n' "${JEST_CASES[@]}")" named_cases "$path (jest)" "$@" || return 1
}


# list_makes_no_live_calls — R7's REALTIME COST RULE, behaviourally: the named StationsScreen test is
# green (jest_pin), and that test really watches the live transport — it spies on or mocks the one
# network door (src/live/http.ts or the expo/fetch it wraps) and asserts the spy was never called — so
# a test that renders the list without watching the network cannot satisfy the gate. And the spy must
# watch a REAL render: the file imports StationsScreen (src/ui/stations/StationsScreen.tsx) or the tab
# route's default export, does not jest-mock that module, and the pinned test's own it()/test()
# callback calls render(…)/create(…) on a JSX element of it BEFORE its not-called assertion (a test
# that mocks expo/fetch and asserts not-called without rendering anything proves nothing).
list_makes_no_live_calls() {
  local t=src/ui/stations/__tests__/StationsScreen.test.tsx
  jest_pin "$t" '(^| )Stations list makes no live prediction calls$' || return 1
  grep -qE "live/http['\"]|expo/fetch['\"]" "$t" \
    || { echo "ratchet: $t never spies on the live transport (src/live/http or expo/fetch)"; return 1; }
  grep -qE 'not\.toHaveBeenCalled\(\)|toHaveBeenCalledTimes\(0\)' "$t" \
    || { echo "ratchet: $t never asserts the live transport spy was not called"; return 1; }
  _route_graph renders "$t" 'Stations list makes no live prediction calls' || return 1
}

# list_avoids_live — R7's REALTIME COST RULE, structurally: the refined Stations list (StationRow drawn
# from the tab, this card's own artifact, so the check cannot pass on m5b's plain list) reaches no live
# HTTP / poller / runtime / live-context module, no live provider, and not the Transitland departures
# parser. Live predictions cost one call per station per refresh and belong to the open station sheet.
# The import closure follows ./ ../ @/ only, so a row calling expo/fetch (a package) or the global
# fetch directly would slip past it: no non-test module in the closure may contain expo/fetch, a
# fetch( call or XMLHttpRequest in its code (comments are blanked out first).
list_avoids_live() {
  route_reaches 'src/app/(tabs)/stations/index.tsx' 'src/ui/stations/StationRow\.tsx$' || return 1
  route_avoids 'src/app/(tabs)/stations/index.tsx' '^src/live/(http|poller|runtime|live-context|use-live-polling)\.tsx?$|^src/live/providers/|^src/domain/live/from-transitland-departures\.ts$' || return 1
  _route_graph clean 'src/app/(tabs)/stations/index.tsx' 'expo/fetch|\bfetch\(|XMLHttpRequest' || return 1
}

# row_opens_station_sheet — the station sheet route (this card's own artifact) exists, and code reached
# from the Stations tab routes to '/station/…'. A link to a route that does not exist yet proves nothing.
row_opens_station_sheet() {
  need_file 'src/app/station/[stationKey].tsx' || return 1
  closure_contains 'src/app/(tabs)/stations/index.tsx' '[\x22\x27\x60]/station/' || return 1
}

# card_files — every file this card creates (plan M6.4–M6.6 F lists; R5's M7.6 handoff module; R7's
# nearest-first ordering and the sheet header with m7c's verdict slot). The Stations tab's header Stack
# (src/app/(tabs)/stations/_layout.tsx) is mfix2's file (R3), so it is not listed here.
card_files() {
  local f
  for f in 'src/app/station/[stationKey].tsx' 'src/app/vehicle/[vehicleKey].tsx' \
    src/ui/stations/StationSheetFooter.tsx src/ui/stations/StationSheetHeader.tsx src/ui/stations/StationRow.tsx \
    src/ui/stations/LineStrip.tsx src/domain/handoff/apple-maps.ts src/domain/stations/order-stations.ts; do
    need_file "$f" || return 1
  done
}

# card_full_gate — the repo-wide gate, green WITH this card's files in the tree (they are the
# precondition, so the gate cannot pass on a repo where this card was not built).
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# export_bundles_routes — Metro exports the iOS bundle (lib.sh ios_export, the plan's Hermes export)
# AND a --no-bytecode export of the same app carries this card's route keys. expo-router's
# require.context keys ('./station/[stationKey].tsx', …) are matched in the plain JS, never in the
# Hermes .hbc: its string table packs strings back to back, so bytes can appear across unrelated
# strings (m5b/m5c finding, 2026-10-01).
export_bundles_routes() {
  local dir=.cache/export-m6b-js out route
  card_files || return 1
  ios_export || return 1
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(npx expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  for route in './station/[stationKey].tsx' './vehicle/[vehicleKey].tsx' './(tabs)/stations/index.tsx'; do
    grep -rqF -- "$route" "$dir/_expo/static/js/ios" \
      || { echo "ratchet: the iOS JS bundle does not register $route"; return 1; }
  done
  echo "OK the iOS JS bundle registers the station, vehicle and Stations-tab routes"
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
# 3. The sheet renders M6.3's DirectionGroup, its own header and footer, with live predictions merged in (live-context + M4.7 merge-departures).
route_reaches 'src/app/station/[stationKey].tsx' 'src/ui/departures/direction-?group\.tsx$' 'src/ui/stations/StationSheetHeader\.tsx$' 'src/ui/stations/StationSheetFooter\.tsx$' 'src/live/live-context\.tsx$' 'src/domain/live/merge-departures\.ts$'
# 4. R7: the sheet header leaves a slot for m7c's hurry verdict — whatever the route passes as the verdict renders inside the header, and nothing renders when none is passed — its own test.
jest_pin src/ui/stations/__tests__/StationSheetHeader.test.tsx '(^| )sheet header renders the verdict passed into its slot$'
# 5. A (M6.4): a trunk station (Government Center, Wed 08:00) gives exactly 2 direction groups — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-sheet-real.test.ts '(^| )Government Center trunk station gives 2 direction groups$'
# 6. A (M6.4): Palmetto gives exactly 1 direction group (terminating trains are not departures) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-sheet-real.test.ts '(^| )Palmetto gives 1 direction group$'
# 7. The real-DB test exercises the same station-sheet selector module the route runs.
route_shares '/station-sheet\.tsx?$' 'src/app/station/[stationKey].tsx' scripts/gtfs/__tests__/station-sheet-real.test.ts
# 8. A (M6.4): the footer offers walk directions as an Apple Maps link with dirflg=w to the station — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )walk directions open Apple Maps with dirflg=w to the station$'
# 9. Handoff rule (M1.19 RESULT): openURL resolving undefined (RN's Promise<void>) counts as opened — never read the resolved value; its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )openURL resolving undefined counts as opened$'
# 10. Handoff rule (M1.19 RESULT): openURL rejecting is the only failure, and the footer shows it — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )openURL rejecting shows the failure$'

# --- M7.6 Apple Maps handoff (R5: moved verbatim from m7b gates 7–9; m6b's footer is its first user) ---
# 11. src/domain/handoff/apple-maps.ts is pure (loads under plain Node via tsx) and exports appleMapsUrl
need_pure_export src/domain/handoff/apple-maps.ts appleMapsUrl
# 12. the handoff tests assert the plan's exact values: the transit URL, walk mode dirflg=w, the https://maps.apple.com fallback
need_lits src/domain/handoff/__tests__ 'maps://?daddr=25.7759,-80.1961&dirflg=r' 'dirflg=w' 'https://maps.apple.com'
# 13. A (M7.6) + the M1.19 handoff rule (plan V `npx jest src/domain/handoff --ci`): transit/walk/fallback URLs; openURL resolving undefined or false = opened (value never read); rejection falls back to https
jest_cases src/domain/handoff "transit url" "walk url" "fallback url" "openURL resolving undefined" "openURL resolving false" "openURL rejects falls back"
# 14. The footer builds its walk link with the domain handoff module (one URL builder, the tested one).
route_reaches src/ui/stations/StationSheetFooter.tsx 'src/domain/handoff/apple-maps\.ts$'

# --- M6.5 Stations tab ---
# 15. The Stations tab route renders StationRow, which draws LineStrip (this card's refinement of m5b's plain list).
route_reaches 'src/app/(tabs)/stations/index.tsx' 'src/ui/stations/StationRow\.tsx$' 'src/ui/stations/LineStrip\.tsx$'
# 16. A station row opens the station sheet: the station route exists and code reached from the tab routes to '/station/…'.
row_opens_station_sheet
# 17. A (M6.5): the Metrorail section lists 23 stations — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )Metrorail section lists 23 stations$'
# 18. A (M6.5): every trunk row (Green + Orange) has 2 strip segments — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )every trunk row has 2 strip segments$'
# 19. A (M6.5): the Airport row has 1 strip segment (Orange) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )Airport row has 1 strip segment$'
# 20. The real-DB test exercises the same station-list selector module the tab runs.
route_shares '/station-list\.tsx?$' 'src/app/(tabs)/stations/index.tsx' scripts/gtfs/__tests__/station-list-real.test.ts
# 21. Never color alone (§4): LineStrip's accessibility label names every line it draws — its own test.
jest_pin src/ui/stations/__tests__/LineStrip.test.tsx '(^| )LineStrip accessibility label names every line$'

# --- R7 Stations usefulness: scheduled next departures inline, nearest first, zero live calls ---
# 22. A (R7): at Wed 08:00 every trunk row carries the next SCHEDULED departure for each of its 2 directions, from the local DB — its own test, on the real DB, whose run queries the stop_time table there.
nodetest_real_case scripts/gtfs/__tests__/station-list-real.test.ts '(^| )every trunk row has the next scheduled departure per direction at Wed 08:00$' stop_time
# 23. A (R7): a row shows each direction's next scheduled departure inline (headsign + time) — its own test.
jest_pin src/ui/stations/__tests__/StationRow.test.tsx '(^| )row shows the next scheduled departure per direction inline$'
# 24. A (R7, REALTIME COST RULE): rendering the Stations list makes zero live prediction calls — its own test, which spies on the live transport (src/live/http or expo/fetch), renders the REAL list (StationsScreen or the tab route, not mocked) in its own callback, then asserts the spy is never called.
list_makes_no_live_calls
# 25. R7 structurally (guarded on this card's refined list): nothing the Stations tab imports reaches the live HTTP layer, a live provider, or the Transitland departures parser, and no module it reaches calls expo/fetch, fetch( or XMLHttpRequest in code (predictions belong to the open station sheet only).
list_avoids_live
# 26. src/domain/stations/order-stations.ts is pure (loads under plain Node via tsx), exports orderStations, and — probed on the real module with the real rail stations — orders nearest first by walking metres, follows the location, and falls back to a stable null-distance order without one.
order_stations_by_location
# 27. A (R7): with a location, stations come nearest first, each with its walking distance — its own test.
jest_pin src/domain/stations/__tests__/order-stations.test.ts '(^| )orders stations nearest first with walking distance$'
# 28. A (R7): without a location the order is the stable fallback order (identical on every call, no distances) — its own test.
jest_pin src/domain/stations/__tests__/order-stations.test.ts '(^| )keeps a stable fallback order without a location$'
# 29. The Stations tab orders its rows with that pure module.
route_reaches 'src/app/(tabs)/stations/index.tsx' 'src/domain/stations/order-stations\.ts$'
# 30. A (R7): a row shows its walking distance when a location is available — its own test.
jest_pin src/ui/stations/__tests__/StationRow.test.tsx '(^| )row shows the walking distance when a location is available$'

# --- M6.6 Vehicle sheet with follow mode ---
# 31. The vehicle route exists and is a native formSheet with detents and an undimmed detent (the followed vehicle stays visible).
route_options 'src/app/vehicle/[vehicleKey].tsx' sheet
# 32. The vehicle route has a real title and a back label that is not "(tabs)".
route_options 'src/app/vehicle/[vehicleKey].tsx' back
# 33. A (M6.6): for every scheduled vehicle at Wed 08:00 the next-stops selector returns at most 3 stops in ascending order — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/repo-next-stops.test.ts '(^| )next stops for every vehicle at Wed 08:00 are at most 3 in ascending order$'
# 34. Card addition: an Inner Loop car near the end of its half-trip continues onto next_trip_idx (the car keeps going) — its own test, on the real DB.
nodetest_real_case scripts/gtfs/__tests__/repo-next-stops.test.ts '(^| )next stops of an Inner Loop car continue onto next_trip_idx$'
# 35. The real-DB test exercises the same next-stops module the vehicle route runs.
route_shares '/next-stops\.tsx?$' 'src/app/vehicle/[vehicleKey].tsx' scripts/gtfs/__tests__/repo-next-stops.test.ts
# 36. Follow mode keeps the camera centered on the followed vehicle — its own test (anywhere under src/ui).
jest_pin src/ui '(^| )follow mode keeps the camera centered on the followed vehicle$'
# 37. Follow mode ends on a user map gesture — its own test (anywhere under src/ui).
jest_pin src/ui '(^| )follow mode ends on a user map gesture$'
# 38. The vehicle sheet's follow toggle and the map (M5.12 TransitMap) share one follow module.
route_shares '/[^/]*follow[^/]*\.tsx?$' 'src/app/vehicle/[vehicleKey].tsx' src/ui/map/TransitMap.tsx

# --- Repo-wide ---
# 39. npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest, node:test) is green with this card's files in the tree.
card_full_gate
# 40. Metro exports the iOS bundle, and its --no-bytecode JS registers the station, vehicle and Stations-tab routes.
export_bundles_routes

echo "m6b_sheets_stations: all 40 gates green"
