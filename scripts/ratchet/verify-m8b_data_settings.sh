#!/usr/bin/env bash
# m8b_data_settings — Data & Settings (plan M8b.1): paste realtime keys into the Keychain (through the
# live runtime and src/live/keys.ts, never rendered in full), provider health + the Transitland quota,
# schedule facts, walking pace for hurry-or-chill, attribution, the Diagnostics link and the entry
# points; then the repo-wide gate and the iOS export, guarded behind this card's own artifacts.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
cd "$HERE/../.."
trap 'echo "ratchet: m8b_data_settings gate failed at verify script line $LINENO"' ERR

# Every gate below is ONE simple command on its own line (never `cmd && gate`: under `set -e` a failing
# left side does not stop the script); compound checks live in the card helpers, which fail loud with a
# named reason. No gate reads a variable or a file another gate created. Run one gate alone, from the
# repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source scripts/ratchet/verify-m8b_data_settings.sh; <gate command>'
#
# TEST-NAME CONVENTION the named-test gates rely on: each acceptance case is its OWN passing jest test
# under src/ui/settings/__tests__/ whose FULL name (describe titles + test title, one space between,
# matched case-insensitively by lib's jest_nonempty on an unfiltered run) ENDS with the case's exact
# phrase from M8B_PINS, starting at a word boundary: the pin is '(^| )<phrase>$'. A name ends only one
# way and no phrase is a suffix of another (pin_test refuses the script otherwise), so one catch-all test
# can satisfy at most one pin. Write each phrase whole inside one test title (an outer describe is fine).

# ---- card constants (fixed text; no gate sets them) ----
M8B_PINS=(
  'save writes live.key.transitland to the keychain'
  'the full key is never rendered, only its last 4'
  'clear deletes the key from the keychain'
  'the quota row reads 1234 of 10,000'
  'both attribution urls are exact'
  'the title is data & settings, never (tabs)'
  'the swiftly agency key defaults to miami'
  'walking pace saves through the kv store and reads back'
  'the status row shows the provider state, update age and bytes per poll'
)
M8B_TESTS=src/ui/settings/__tests__
M8B_SCREEN=src/ui/settings/DataSettingsScreen.tsx
M8B_PACE=src/ui/settings/walking-pace.ts
M8B_ROUTE=src/app/data.tsx

# ---- card helpers (lib.sh has no anchored-pin, regex need, absence, route-options, import-closure or
#      rendered-screen oracle helper; everything else is lib.sh's). ----

# pin_test <phrase> — the phrase must be in M8B_PINS (authoring check), no pin may be a suffix of another
# (so no single test title can end with two of them), then lib's jest_nonempty runs src/ui/settings/__tests__
# UNFILTERED and needs a passing test whose full name matches '(^| )<escaped phrase>$' (case-insensitive).
pin_test() {
  local phrase="$1" p q found=0 re
  for p in "${M8B_PINS[@]}"; do
    [ "$p" != "$phrase" ] || found=1
    for q in "${M8B_PINS[@]}"; do
      if [ "$p" != "$q" ] && [ "${q%" $p"}" != "$q" ]; then
        echo "ratchet: verify-script authoring error: pin '$p' is a suffix of pin '$q'"; return 1
      fi
    done
  done
  [ "$found" -eq 1 ] || { echo "ratchet: verify-script authoring error: '$phrase' is not in M8B_PINS"; return 1; }
  re=$(printf '%s' "$phrase" | sed -e 's/[][\.*^$+?(){}|]/\\&/g') || { echo "ratchet: could not escape '$phrase'"; return 1; }
  jest_nonempty "$M8B_TESTS" "(^| )$re\$"
}

# need_all <file> <ERE>... — the file exists and every ERE matches some line of it.
need_all() {
  local file="$1" re; shift
  need_file "$file" || return 1
  for re in "$@"; do
    grep -qE -- "$re" "$file" || { echo "ratchet: $file has nothing matching /$re/"; return 1; }
  done
}

# absent_code <ERE> <path>... — every path exists and NO non-test CODE line under them matches. Lines
# that are wholly comments (starting with //, /* or *) are ignored, so a doc comment may name a value;
# code with a trailing comment is still checked. A function, not `! grep`: bash's set -e ignores a
# failing `!`-negated command.
absent_code() {
  local re="$1" p hits rc=0; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing $p"; return 1; }; done
  hits=$(grep -rnE --exclude-dir=__tests__ -- "$re" "$@") || rc=$?
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (rc=$rc) scanning $*"; return 1; }
  hits=$(printf '%s\n' "$hits" | awk '$0 != "" && $0 !~ /^[^:]+:[0-9]+:[[:space:]]*(\/\/|\/?\*)/')
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | head -5
    echo "ratchet: forbidden /$re/ found in non-test code under $*"; return 1
  fi
}

# mocks_labelled <dir> — test files exist under <dir>; every jest.mock( line carries the label
# "test-time mock of native module" on that line or the line above (CLAUDE.md), and expo-secure-store is
# one of the mocked modules (plan M8b.1: "SecureStore mocked and labelled").
mocks_labelled() {
  local dir="$1" files
  [ -d "$dir" ] || { echo "ratchet: missing $dir — the milestone's tests do not exist yet"; return 1; }
  files=$(find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
  [ -n "$files" ] || { echo "ratchet: no *.test.ts(x) under $dir"; return 1; }
  # shellcheck disable=SC2086
  awk -v q="'" -v label='test-time mock of native module' '
    FNR == 1 { prev = "" }
    /jest\.mock\(/ && index($0, label) == 0 && index(prev, label) == 0 {
      printf "ratchet: unlabelled jest.mock at %s:%d — label it \"// %s\" (native modules only)\n", FILENAME, FNR, label; bad = 1 }
    $0 ~ ("jest\\.mock\\([[:space:]]*[\"" q "]expo-secure-store[\"" q "]") { secure = 1 }
    { prev = $0 }
    END { if (!secure) { print "ratchet: no test under the settings tests mocks expo-secure-store (jest.mock(\"expo-secure-store\", …))"; bad = 1 }
          exit bad }' $files
}

# route_title — the /data route's own header options, read from the TypeScript AST (explicit stacks, no
# recursion): a <X.Screen name="data" options={…}> in src/app/_layout.tsx and/or a nameless
# <X.Screen options={…}> in src/app/data.tsx. Option values may be object literals, same-file consts
# (`as const` ok), arrows returning them, or spreads of those. Requires: title 'Data & Settings' (and no
# other title); the header shown (headerShown: true when the root <Stack screenOptions> hides headers,
# never headerShown: false); and a back label that is not "(tabs)" (M1.19): headerBackTitle (not
# "(tabs)") or headerBackButtonDisplayMode 'minimal' on the route or the root Stack's screenOptions, or
# a real title on the root (tabs) screen.
route_title() {
  need_file "$M8B_ROUTE" || return 1
  need_file src/app/_layout.tsx || return 1
  node - "$M8B_ROUTE" src/app/_layout.tsx <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(process.cwd(), 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed (${e.message})`); }
const [routeFile, layoutFile] = process.argv.slice(2);
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodesOf(sf) {
  const out = []; const stack = [sf];
  while (stack.length) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (c) => { stack.push(c); }); }
  return out;
}
const unwrap = (e) => { let x = e; for (let i = 0; i < 10 && x && (ts.isAsExpression(x) || ts.isParenthesizedExpression(x) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(x))); i += 1) x = x.expression; return x; };
const tagOf = (el) => el.tagName.getText();
const attr = (el, name) => el.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
function attrExpr(el, name) {
  const a = attr(el, name);
  if (!a || !a.initializer) return null;
  return ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
}
function constInit(sf, name) {
  const d = nodesOf(sf).find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer);
  return d ? d.initializer : null;
}
function resolveSpec(fromFile, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(path.resolve(fromFile)), spec);
  else if (spec.startsWith('@/')) base = path.join(process.cwd(), 'src', spec.slice(2));
  if (base === null) return null;
  const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => base + x).find((p) => /\.tsx?$/.test(p) && fs.existsSync(p));
  return hit === undefined ? null : hit;
}
// `name` as a same-file const, or a const named-imported from a ./ ../ @/ module: { sf, expr } or null.
function constOf(sf, name) {
  const local = constInit(sf, name);
  if (local) return { sf, expr: local };
  for (const st of sf.statements) {
    const nb = ts.isImportDeclaration(st) && st.importClause && !st.importClause.isTypeOnly ? st.importClause.namedBindings : undefined;
    if (!nb || !ts.isNamedImports(nb)) continue;
    const el = nb.elements.find((e) => e.name.text === name);
    if (!el) continue;
    const file = resolveSpec(sf.fileName, st.moduleSpecifier.text);
    if (file === null) return null;
    const other = parse(file);
    const init = constInit(other, el.propertyName ? el.propertyName.text : name);
    return init ? { sf: other, expr: init } : null;
  }
  return null;
}
// An options expression -> { sf, obj } (identifier -> const, arrow -> returned object), or null.
function toObject(sf, expr) {
  let cur = { sf, expr: unwrap(expr) };
  for (let i = 0; i < 8 && cur && cur.expr; i += 1) {
    const e = cur.expr;
    if (ts.isObjectLiteralExpression(e)) return { sf: cur.sf, obj: e };
    if (ts.isIdentifier(e)) { cur = constOf(cur.sf, e.text); if (cur) cur = { sf: cur.sf, expr: unwrap(cur.expr) }; }
    else if (ts.isArrowFunction(e) && !ts.isBlock(e.body)) cur = { sf: cur.sf, expr: unwrap(e.body) };
    else return null;
  }
  return null;
}
function literal(sf, e) {
  let x = unwrap(e);
  if (x && ts.isIdentifier(x)) { const c = constOf(sf, x.text); x = c ? unwrap(c.expr) : null; }
  if (!x) return { kind: 'dynamic' };
  if (ts.isStringLiteralLike(x)) return { kind: 'string', value: x.text };
  if (x.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'bool', value: true };
  if (x.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'bool', value: false };
  return { kind: 'dynamic' };
}
// Flattened {key -> literal} of an options expression; spreads resolved through a bounded queue.
function optionsOf(sf, expr) {
  const out = new Map();
  if (!expr) return out;
  const root = toObject(sf, expr);
  if (!root) return out;
  const queue = [root];
  for (let i = 0; i < queue.length && i < 20; i += 1) {
    const { sf: at, obj } = queue[i];
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p)) out.set(p.name.getText().replace(/^['"]|['"]$/g, ''), literal(at, p.initializer));
      else if (ts.isShorthandPropertyAssignment(p)) out.set(p.name.text, literal(at, p.name));
      else if (ts.isSpreadAssignment(p)) { const inner = toObject(at, p.expression); if (inner) queue.push(inner); }
    }
  }
  return out;
}
const elements = (sf) => nodesOf(sf).filter((n) => ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n));
const isScreen = (el) => /\.Screen$/.test(tagOf(el));
const nameOf = (el) => { const e = attrExpr(el, 'name'); return e && ts.isStringLiteralLike(e) ? e.text : null; };
const layout = parse(layoutFile);
const route = parse(routeFile);
const routeOpts = [
  ...elements(layout).filter((el) => isScreen(el) && nameOf(el) === 'data').map((el) => optionsOf(layout, attrExpr(el, 'options'))),
  ...elements(route).filter((el) => isScreen(el) && attr(el, 'name') === undefined).map((el) => optionsOf(route, attrExpr(el, 'options'))),
];
if (routeOpts.length === 0) fail(`no <Stack.Screen name="data" options={…}> in ${layoutFile} and no nameless <Stack.Screen options={…}> in ${routeFile} — the route has no options of its own`);
const rootStack = elements(layout).filter((el) => tagOf(el) === 'Stack').map((el) => optionsOf(layout, attrExpr(el, 'screenOptions')));
const tabsOpts = elements(layout).filter((el) => isScreen(el) && nameOf(el) === '(tabs)').map((el) => optionsOf(layout, attrExpr(el, 'options')));
const values = (maps, key) => maps.map((m) => m.get(key)).filter((v) => v !== undefined);
const titles = values(routeOpts, 'title');
if (!titles.some((t) => t.kind === 'string' && t.value === 'Data & Settings')) fail(`the /data route's options never set title: 'Data & Settings' (titles found: ${JSON.stringify(titles)})`);
if (titles.some((t) => !(t.kind === 'string' && t.value === 'Data & Settings'))) fail(`the /data route's options set another title too: ${JSON.stringify(titles)}`);
const shown = values(routeOpts, 'headerShown');
if (shown.some((v) => v.kind === 'bool' && v.value === false)) fail('the /data route hides its header (headerShown: false) — the title would never show');
const rootHides = values(rootStack, 'headerShown').some((v) => v.kind === 'bool' && v.value === false);
if (rootHides && !shown.some((v) => v.kind === 'bool' && v.value === true)) fail('the root <Stack screenOptions> hides headers and the /data route does not set headerShown: true — the title would never show');
const realBack = (v) => v.kind === 'string' && v.value.trim() !== '' && v.value.trim() !== '(tabs)';
const backOk = [...routeOpts, ...rootStack].some((m) => (m.get('headerBackTitle') && realBack(m.get('headerBackTitle')))
  || (m.get('headerBackButtonDisplayMode') && m.get('headerBackButtonDisplayMode').kind === 'string' && m.get('headerBackButtonDisplayMode').value === 'minimal'))
  || tabsOpts.some((m) => m.get('title') && realBack(m.get('title')));
if (!backOk) fail('the back button on Data & Settings would read "(tabs)" (M1.19): set headerBackTitle (not "(tabs)") or headerBackButtonDisplayMode: \'minimal\' on the route or the root Stack, or a real title on the root (tabs) screen');
console.log("ratchet: /data has the header title 'Data & Settings', shown, with a real back label");
NODE
}

# _closure_has <cmd> <args>… — one node program over the import graph (regex imports; `import type` skipped;
# ./ ../ and @/ (= src/) specifiers resolved to .ts/.tsx/index files; bounded BFS, no recursion). A route
# reference is a quoted literal: '/data', "/data" or `/data` (router.push, <Link href>, { pathname }).
#   reaches <entry> <route>      some non-test file in entry's import closure references <route>
#   floating <route>             the component mounted in <NativeTabs.BottomAccessory> of src/app/(tabs)/_layout.tsx
#                                reaches <route>; and once src/ui/map/StatusPill.tsx exists (m5c), the pill's closure
#                                or a non-test file that renders <StatusPill references <route> too
_closure_has() {
  node - "$@" <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
const [cmd, ...args] = process.argv.slice(2);
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const isTest = (f) => /\/__tests__\//.test(f) || /\.test\.tsx?$/.test(f);
function resolve(fromAbs, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromAbs), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => base + x).find((p) => /\.tsx?$/.test(p) && isFile(p));
  return hit === undefined ? null : hit;
}
function specs(text) {
  const out = [];
  const fromRe = /(^|[\n;])\s*(import|export)\s+(type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g;
  for (let m = fromRe.exec(text); m !== null; m = fromRe.exec(text)) if (!m[3]) out.push(m[4]);
  const bare = /(^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = bare.exec(text); m !== null; m = bare.exec(text)) out.push(m[2]);
  const dyn = /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dyn.exec(text); m !== null; m = dyn.exec(text)) out.push(m[1]);
  return out;
}
function closure(entryAbs) {
  const queue = [entryAbs]; const seen = new Set(queue);
  for (let i = 0; i < queue.length && i < 3000; i += 1) {
    for (const s of specs(fs.readFileSync(queue[i], 'utf8'))) {
      const next = resolve(queue[i], s);
      if (next !== null && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return queue;
}
const refRe = (route) => new RegExp('[\'"`]' + route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '[\'"`]');
const referencing = (files, route) => files.filter((f) => !isTest(rel(f)) && refRe(route).test(fs.readFileSync(f, 'utf8'))).map(rel);
function reaches(entry, route, label) {
  const abs = path.resolve(ROOT, entry);
  if (!isFile(abs)) fail(`missing file ${entry}`);
  const files = closure(abs);
  const hits = referencing(files, route);
  if (hits.length === 0) fail(`${label}: nothing in the import closure of ${entry} (${files.length} files) references the route '${route}'`);
  console.log(`ratchet: ${label}: ${entry} reaches '${route}' (${hits.slice(0, 3).join(', ')})`);
}
function accessoryEntry() {
  const layout = path.join(ROOT, 'src/app/(tabs)/_layout.tsx');
  if (!isFile(layout)) fail('missing file src/app/(tabs)/_layout.tsx');
  const text = fs.readFileSync(layout, 'utf8');
  const m = /<NativeTabs\.BottomAccessory\b[^>]*>([\s\S]*?)<\/NativeTabs\.BottomAccessory>/.exec(text);
  if (!m) fail('src/app/(tabs)/_layout.tsx renders no <NativeTabs.BottomAccessory>…</NativeTabs.BottomAccessory>');
  const tag = /<([A-Z][A-Za-z0-9_]*)\b/.exec(m[1]);
  if (!tag) fail('the BottomAccessory in src/app/(tabs)/_layout.tsx mounts no component');
  const name = tag[1];
  const imp = new RegExp('import\\s+(?:' + name + '\\b|\\{[^}]*\\b' + name + '\\b[^}]*\\})[^;]*?from\\s*[\'"]([^\'"]+)[\'"]').exec(text);
  if (!imp) fail(`<${name}> in the BottomAccessory is not imported from a module`);
  const file = resolve(layout, imp[1]);
  if (file === null) fail(`cannot resolve '${imp[1]}' (the BottomAccessory's <${name}>)`);
  return { name, file: rel(file) };
}
function floating(route) {
  const acc = accessoryEntry();
  reaches(acc.file, route, `tab-bar accessory <${acc.name}>`);
  const pill = path.join(ROOT, 'src/ui/map/StatusPill.tsx');
  if (!isFile(pill)) { console.log('ratchet: src/ui/map/StatusPill.tsx is not built yet (m5c) — only the accessory is checked'); return; }
  const files = [...closure(pill)];
  const stack = [path.join(ROOT, 'src')];
  for (let i = 0; i < 5000 && stack.length; i += 1) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.tsx?$/.test(e.name) && !isTest(rel(p)) && /<StatusPill\b/.test(fs.readFileSync(p, 'utf8'))) files.push(p);
    }
  }
  const hits = referencing(files, route);
  if (hits.length === 0) fail(`status pill: neither src/ui/map/StatusPill.tsx's import closure nor a module rendering <StatusPill references the route '${route}' (§4: tapping the pill opens Data & Settings)`);
  console.log(`ratchet: status pill reaches '${route}' (${hits.slice(0, 3).join(', ')})`);
}
if (cmd === 'reaches') reaches(args[0], args[1], args[2] || args[0]);
else if (cmd === 'floating') floating(args[0]);
else fail(`verify-script authoring error: unknown _closure_has command '${cmd}'`);
NODE
}
reaches_route() { _closure_has reaches "$@"; }
floating_entries_reach() { _closure_has floating "$@"; }

# data_oracle <check> — evaluates ONE behaviour of the REAL screen under the repo's own jest (jest-expo/ios:
# the app's babel transform and @/ resolution), independent of the builder's tests, so a right-named test
# asserting the wrong thing cannot pass it. It renders the plan's DataSettingsView (exported by
# src/ui/settings/DataSettingsScreen.tsx) with live={{ state, runtime }} from a REAL LiveRuntime
# (src/live/runtime.ts) over the native mocks below — expo-secure-store and expo-sqlite/kv-store as labelled
# test-time mocks of native modules, react-native's Linking/Alert spied — with fake keys only and no
# network (fetch rejects). The throwaway test lives in the gitignored .cache and is removed whether the
# check passes or fails. Checks:
#   masked     a stored Transitland key shows as "Saved ••••<last4>" under testID key-status-transitland; no
#              5-character run of the key renders anywhere; key-status-swiftly says "Not set"
#   save       a paste into key-input-transitland (with stray whitespace) + key-save-transitland calls
#              setItemAsync('live.key.transitland', <trimmed key>) once, the runtime then HAS the key (saved
#              through useLive().runtime), the field no longer shows it, and "••••<last4>" does
#   clear      key-clear-transitland (a confirm Alert's destructive button is pressed if one is shown) calls
#              deleteItemAsync('live.key.transitland') and nothing else; the runtime no longer has the key;
#              key-status-transitland says "Not set"
#   quota      1234 Transitland calls this month render "1234 of 10,000" (or "1,234 of 10,000")
#   health     after 3 failed Transitland polls the status row (testID provider-status-transitland) says
#              "Failing"; before any poll it does not
#   agency     agency-input-swiftly shows 'miami' (value/placeholder/defaultValue); typing 'miami-dade' and
#              pressing agency-save-swiftly stores live.agency.swiftly and puts it in effect in the runtime
#   attribution  attribution-link-transitland / attribution-link-transitous open EXACTLY
#              https://www.transit.land/terms / https://transitous.org/sources (Linking.openURL, or a rendered
#              href); the screen names Miami-Dade DTPW, Swiftly, Transitland and Transitous
#   schedule   the bundled manifest's feed hash (first 8 hex) and both service ends (data-version.ts's
#              shortServiceDate) render; testID schedule-expiry has text
#   pace       defaults render 1.35 and 2.7 (m/s); after saveWalkingPace({walkMps:1.5, jogMps:3.1}) a new
#              mount renders 1.5 and 3.1
#   pace-store walking-pace.ts: DEFAULT_WALK_MPS = 1.35, DEFAULT_JOG_MPS = 2.7; readWalkingPace() on an empty
#              kv-store gives them; saveWalkingPace returns ok and persists in expo-sqlite/kv-store (read
#              back); a jog no faster than the walk is refused (ok: false) and stores nothing
data_oracle() {
  local check="$1" dir out rc=0
  case "$check" in masked|save|clear|quota|health|agency|attribution|schedule|pace|pace-store) ;;
    *) echo "ratchet: verify-script authoring error: unknown data_oracle check '$check'"; return 1 ;; esac
  case "$PWD" in *\'*|*\\*|*\`*|*'|'*|*'&'*) echo "ratchet: the repo path contains a quote, backslash, backtick, | or &"; return 1 ;; esac
  if [ "$check" != pace-store ]; then need_file "$M8B_SCREEN" || return 1; fi
  if [ "$check" = pace ] || [ "$check" = pace-store ]; then need_file "$M8B_PACE" || return 1; fi
  dir="$PWD/.cache/ratchet-m8b-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  sed -e "s|__ROOT__|$PWD|g" -e "s|__CHECK__|$check|g" > "$dir/data.oracle.test.tsx" <<'ORACLE' || { rm -rf "$dir"; echo "ratchet: could not write the oracle test"; return 1; }
/* ratchet m8b oracle — generated by scripts/ratchet/verify-m8b_data_settings.sh and deleted after the run. */
import { act, create } from 'react-test-renderer';
import { Alert, Linking } from 'react-native';

jest.mock('expo-secure-store', () => { // test-time mock of native module
  const items = new Map();
  return {
    __esModule: true,
    __items: items,
    getItemAsync: jest.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { items.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { items.delete(key); }),
    isAvailableAsync: jest.fn(async () => true),
  };
});
jest.mock('expo-sqlite/kv-store', () => { // test-time mock of native module
  const map = new Map();
  const put = (key: string, value: any) => { map.set(key, typeof value === 'function' ? String(value(map.get(key) ?? null)) : String(value)); };
  const store = {
    getItemSync: (key: string) => map.get(key) ?? null, setItemSync: put, removeItemSync: (key: string) => map.delete(key),
    getAllKeysSync: () => [...map.keys()], clearSync: () => { map.clear(); return true; },
    getItemAsync: async (key: string) => map.get(key) ?? null, setItemAsync: async (key: string, value: any) => put(key, value),
    removeItemAsync: async (key: string) => map.delete(key), getAllKeysAsync: async () => [...map.keys()],
    getItem: async (key: string) => map.get(key) ?? null, setItem: async (key: string, value: any) => put(key, value),
    removeItem: async (key: string) => { map.delete(key); }, getAllKeys: async () => [...map.keys()],
  };
  return { __esModule: true, __map: map, default: store, Storage: store, AsyncStorage: store };
});

const CHECK = '__CHECK__';
const KEY_TL = 'tlK9q2Vx7Lm4Pz8RWXYZ'; // fake; last 4 = WXYZ
const KEY_NEW = 'nwB3c8Hd1Jf6Kg0MQRST'; // fake; last 4 = QRST
const NOW_S = Date.UTC(2026, 9, 1, 16) / 1000;
const NETWORK = { lineOfTrip: () => null, stationOfStop: () => null, stopsOfStation: () => [], tracks: [] };
const EVENT = { nativeEvent: {}, preventDefault: () => undefined, stopPropagation: () => undefined };
const fail = (m: string): never => { throw new Error('ratchet-oracle: ' + m); };

async function settle() { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); }

function strings(node: any, out: string[]) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n == null) continue;
    if (typeof n === 'string') { out.push(n); continue; }
    if (Array.isArray(n)) { for (let i = n.length - 1; i >= 0; i -= 1) stack.push(n[i]); continue; }
    if (n.children) for (let i = n.children.length - 1; i >= 0; i -= 1) stack.push(n.children[i]);
  }
  return out;
}
/** Every Text's whole text, every string prop, of the rendered (host) tree. */
function texts(tree: any): string[] {
  const out: string[] = []; const stack = [tree.toJSON()];
  while (stack.length) {
    const n = stack.pop();
    if (n == null || typeof n === 'string') continue;
    if (Array.isArray(n)) { stack.push(...n); continue; }
    if (n.type === 'Text') out.push(strings(n, []).join(''));
    for (const v of Object.values(n.props ?? {})) if (typeof v === 'string') out.push(v);
    if (n.children) stack.push(...n.children);
  }
  return out;
}
/** The text under every host node carrying testID `id`. */
function textOfId(tree: any, id: string): string {
  const hits: string[] = []; const stack = [tree.toJSON()];
  while (stack.length) {
    const n = stack.pop();
    if (n == null || typeof n === 'string') continue;
    if (Array.isArray(n)) { stack.push(...n); continue; }
    if (n.props?.testID === id) hits.push(strings(n, []).join('') + ' ' + Object.values(n.props).filter((v) => typeof v === 'string').join(' '));
    if (n.children) stack.push(...n.children);
  }
  if (!hits.length) fail(`nothing rendered carries testID "${id}"`);
  return hits.join(' ');
}
function handler(tree: any, id: string, prop: string): any {
  const hits = tree.root.findAll((n: any) => n.props && n.props.testID === id && typeof n.props[prop] === 'function');
  if (!hits.length) fail(`nothing with testID "${id}" has an ${prop} handler`);
  return hits[0].props[prop];
}
function leak(tree: any, key: string): string | null {
  const json = JSON.stringify(tree.toJSON());
  for (let i = 0; i + 5 <= key.length; i += 1) if (json.includes(key.slice(i, i + 5))) return key.slice(i, i + 5);
  return null;
}
const sample = (t: string[]) => JSON.stringify(t.filter((s) => s.trim()).slice(0, 40)).slice(0, 900);

async function mount(keychain: Record<string, string>, kv: Record<string, string>, clock = { now: NOW_S }) {
  const SecureStore = require('expo-secure-store');
  const Kv = require('expo-sqlite/kv-store');
  SecureStore.__items.clear();
  for (const [k, v] of Object.entries(keychain)) SecureStore.__items.set(k, v);
  Kv.__map.clear();
  for (const [k, v] of Object.entries(kv)) Kv.__map.set(k, v);
  const { LiveRuntime } = require('__ROOT__/src/live/runtime');
  const screen = require('__ROOT__/src/ui/settings/DataSettingsScreen');
  const View = screen.DataSettingsView;
  if (typeof View !== 'function') fail('src/ui/settings/DataSettingsScreen.tsx exports no DataSettingsView component');
  const states: any[] = [];
  const runtime = new LiveRuntime({ network: NETWORK, onChange: (s: any) => states.push(s), fetch: () => Promise.reject(new Error('ratchet oracle: no network')), nowS: () => clock.now });
  await act(async () => { runtime.start(); await settle(); });
  const live = () => ({ state: states[states.length - 1] ?? null, runtime });
  let tree: any;
  await act(async () => { tree = create(<View live={live()} />); await settle(); });
  const refresh = async () => { await act(async () => { await settle(); tree.update(<View live={live()} />); await settle(); }); };
  await refresh();
  SecureStore.setItemAsync.mockClear();
  SecureStore.deleteItemAsync.mockClear();
  const latest = () => states[states.length - 1];
  const unmount = async () => { await act(async () => { tree.unmount(); await settle(); }); if (runtime.isStarted()) runtime.stop(); };
  return { tree: () => tree, runtime, SecureStore, Kv, refresh, latest, unmount, clock };
}

async function masked() {
  const m = await mount({ 'live.key.transitland': KEY_TL }, {});
  const w = leak(m.tree(), KEY_TL);
  if (w) fail(`the screen renders "${w}" — 5 characters of the stored Transitland key; only "••••" + its last 4 may render`);
  const tl = textOfId(m.tree(), 'key-status-transitland');
  if (!tl.includes('••••WXYZ') || !/\bSaved\b/.test(tl)) fail(`key-status-transitland must read "Saved ••••WXYZ" for a stored key ending WXYZ; it reads ${JSON.stringify(tl)}`);
  const sw = textOfId(m.tree(), 'key-status-swiftly');
  if (!sw.includes('Not set')) fail(`key-status-swiftly must read "Not set" with no Swiftly key; it reads ${JSON.stringify(sw)}`);
  await m.unmount();
}

async function save() {
  const m = await mount({}, {});
  await act(async () => { handler(m.tree(), 'key-input-transitland', 'onChangeText')(`  ${KEY_NEW}\n`); await settle(); });
  await act(async () => { handler(m.tree(), 'key-save-transitland', 'onPress')(EVENT); await settle(); });
  await m.refresh();
  const calls = m.SecureStore.setItemAsync.mock.calls.map((c: any[]) => [c[0], c[1] === KEY_NEW ? '<the trimmed paste>' : `<${String(c[1]).length} chars>`]);
  if (calls.length !== 1 || calls[0][0] !== 'live.key.transitland' || calls[0][1] !== '<the trimmed paste>') fail(`Save must call setItemAsync('live.key.transitland', <the trimmed paste>) exactly once; calls: ${JSON.stringify(calls)}`);
  if (m.latest()?.hasKey?.transitland !== true) fail('after Save the live runtime still has no Transitland key — save through useLive().runtime.saveKey so the key is in effect at once');
  const w = leak(m.tree(), KEY_NEW);
  if (w) fail(`after Save the screen still renders "${w}" of the pasted key — clear the field; only "••••" + the last 4 may render`);
  const tl = textOfId(m.tree(), 'key-status-transitland');
  if (!tl.includes('••••QRST')) fail(`after Save key-status-transitland must show "••••QRST"; it reads ${JSON.stringify(tl)}`);
  await m.unmount();
}

async function clear() {
  const m = await mount({ 'live.key.transitland': KEY_TL }, {});
  jest.spyOn(Alert, 'alert').mockImplementation((_t: any, _m: any, buttons: any) => {
    const b = (buttons ?? []).find((x: any) => x.style === 'destructive') ?? (buttons ?? [])[(buttons ?? []).length - 1];
    if (b && typeof b.onPress === 'function') b.onPress();
  });
  await act(async () => { handler(m.tree(), 'key-clear-transitland', 'onPress')(EVENT); await settle(); });
  await m.refresh();
  const dels = m.SecureStore.deleteItemAsync.mock.calls.map((c: any[]) => c[0]);
  if (!dels.includes('live.key.transitland')) fail(`Clear must call deleteItemAsync('live.key.transitland'); deletes: ${JSON.stringify(dels)}`);
  if (dels.some((k: string) => k !== 'live.key.transitland')) fail(`Clear for Transitland also deleted ${JSON.stringify(dels)}`);
  if (m.latest()?.hasKey?.transitland !== false) fail('after Clear the live runtime still has a Transitland key — clear through useLive().runtime.clearKey');
  const tl = textOfId(m.tree(), 'key-status-transitland');
  if (tl.includes('WXYZ') || !tl.includes('Not set')) fail(`after Clear key-status-transitland must read "Not set"; it reads ${JSON.stringify(tl)}`);
  await m.unmount();
}

async function quota() {
  const { quotaKey } = require('__ROOT__/src/live/quota');
  const now = Math.floor(Date.now() / 1000);
  const m = await mount({ 'live.key.transitland': KEY_TL }, { [quotaKey('transitland', NOW_S)]: '1234', [quotaKey('transitland', now)]: '1234' });
  if (m.latest()?.callsThisMonth?.transitland !== 1234) fail(`oracle rig: the runtime reads ${m.latest()?.callsThisMonth?.transitland} Transitland calls, not the seeded 1234`);
  const t = texts(m.tree());
  if (!t.some((s) => /(^|[^0-9,])1,?234 of 10,000($|[^0-9,])/.test(s))) fail(`no text reads "1234 of 10,000" for 1234 Transitland calls this month; texts: ${sample(t)}`);
  await m.unmount();
}

async function health() {
  const clock = { now: NOW_S };
  const m = await mount({ 'live.key.transitland': KEY_TL }, {}, clock);
  const before = textOfId(m.tree(), 'provider-status-transitland');
  if (/failing/i.test(before)) fail(`before any poll provider-status-transitland already says Failing: ${JSON.stringify(before)}`);
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { if (i === 0) m.runtime.resume(); else m.runtime.tick(); await settle(); });
    clock.now += 300;
  }
  if (m.latest()?.status?.vehicles?.failing !== true) fail(`oracle rig: 3 failed polls did not make Transitland vehicles failing (status ${JSON.stringify(m.latest()?.status)})`);
  await m.refresh();
  const after = textOfId(m.tree(), 'provider-status-transitland');
  if (!/failing/i.test(after)) fail(`after 3 failed Transitland polls provider-status-transitland must say Failing; it reads ${JSON.stringify(after)}`);
  await m.unmount();
}

async function agency() {
  const m = await mount({}, {});
  const input = m.tree().root.findAll((n: any) => n.props && n.props.testID === 'agency-input-swiftly' && typeof n.props.onChangeText === 'function')[0];
  if (!input) fail('nothing with testID "agency-input-swiftly" has an onChangeText handler');
  const shown = [input.props.value, input.props.placeholder, input.props.defaultValue];
  if (!shown.includes('miami')) fail(`agency-input-swiftly must show the default agency key 'miami' (value, placeholder or defaultValue); it has ${JSON.stringify(shown)}`);
  await act(async () => { input.props.onChangeText('miami-dade'); await settle(); });
  await act(async () => { handler(m.tree(), 'agency-save-swiftly', 'onPress')(EVENT); await settle(); });
  await m.refresh();
  const sets = m.SecureStore.setItemAsync.mock.calls;
  if (!sets.some((c: any[]) => c[0] === 'live.agency.swiftly' && c[1] === 'miami-dade')) fail(`saving the agency key must store live.agency.swiftly = 'miami-dade'; calls: ${JSON.stringify(sets)}`);
  if (m.latest()?.swiftlyAgency !== 'miami-dade') fail('after saving, the live runtime still uses another agency key — save through useLive().runtime.saveSwiftlyAgency');
  await m.unmount();
}

async function attribution() {
  const m = await mount({}, {});
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
  const links: [string, string][] = [['attribution-link-transitland', 'https://www.transit.land/terms'], ['attribution-link-transitous', 'https://transitous.org/sources']];
  for (const [id, url] of links) {
    const hrefs = m.tree().root.findAll((n: any) => n.props && n.props.testID === id && typeof n.props.href === 'string').map((n: any) => n.props.href);
    if (hrefs.length > 0) { if (hrefs.every((h: string) => h === url)) continue; fail(`${id} links to ${JSON.stringify(hrefs)}, not exactly ${url}`); }
    openURL.mockClear();
    await act(async () => { handler(m.tree(), id, 'onPress')(EVENT); await settle(); });
    const got = openURL.mock.calls.map((c: any[]) => c[0]);
    if (got.length !== 1 || got[0] !== url) fail(`pressing ${id} must open exactly ${url}; it opened ${JSON.stringify(got)}`);
  }
  const all = texts(m.tree()).join('\n');
  for (const name of ['Miami-Dade DTPW', 'Swiftly', 'Transitland', 'Transitous']) if (!all.includes(name)) fail(`the attribution never names ${name}`);
  await m.unmount();
}

async function schedule() {
  const manifest = require('__ROOT__/assets/db/manifest.json');
  const { shortServiceDate } = require('__ROOT__/src/ui/diagnostics/data-version');
  const m = await mount({}, {});
  const t = texts(m.tree());
  const all = t.join('\n');
  const want = [manifest.feedSha256.slice(0, 8), shortServiceDate(manifest.serviceEnd.rail.date), shortServiceDate(manifest.serviceEnd.mover.date)];
  for (const w of want) if (!all.includes(w)) fail(`the Schedule section never shows "${w}" (bundled manifest: feed hash, rail end, Mover end); texts: ${sample(t)}`);
  if (textOfId(m.tree(), 'schedule-expiry').trim() === '') fail('schedule-expiry renders no text — show the expiry state');
  await m.unmount();
}

async function pace() {
  const first = await mount({}, {});
  const t0 = texts(first.tree()).join('\n');
  if (!/(^|[^0-9.])1\.350*([^0-9]|$)/.test(t0) || !/(^|[^0-9.])2\.70*([^0-9]|$)/.test(t0)) fail('with nothing saved, the Walking pace section must show the defaults 1.35 and 2.7 (m/s)');
  await first.unmount();
  const pace = require('__ROOT__/src/ui/settings/walking-pace');
  const Kv = require('expo-sqlite/kv-store');
  Kv.__map.clear();
  const saved = pace.saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 });
  if (!saved || saved.ok !== true) fail(`saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 }) did not return ok: ${JSON.stringify(saved)}`);
  const stored = Object.fromEntries(Kv.__map);
  const second = await mount({}, stored);
  const t1 = texts(second.tree()).join('\n');
  if (!/(^|[^0-9.])1\.50*([^0-9]|$)/.test(t1) || !/(^|[^0-9.])3\.10*([^0-9]|$)/.test(t1)) fail('after saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 }) a new mount must show 1.5 and 3.1 — the screen reads the saved pace');
  await second.unmount();
}

function paceStore() {
  const Kv = require('expo-sqlite/kv-store');
  Kv.__map.clear();
  const pace = require('__ROOT__/src/ui/settings/walking-pace');
  if (pace.DEFAULT_WALK_MPS !== 1.35 || pace.DEFAULT_JOG_MPS !== 2.7) fail(`DEFAULT_WALK_MPS / DEFAULT_JOG_MPS are ${pace.DEFAULT_WALK_MPS} / ${pace.DEFAULT_JOG_MPS}, not 1.35 / 2.7 (plan M7c.1)`);
  const empty = pace.readWalkingPace();
  if (empty?.walkMps !== 1.35 || empty?.jogMps !== 2.7) fail(`readWalkingPace() on an empty store is ${JSON.stringify(empty)}, not the defaults`);
  const saved = pace.saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 });
  if (saved?.ok !== true) fail(`saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 }) returned ${JSON.stringify(saved)}, not ok`);
  if (Kv.__map.size === 0) fail('saveWalkingPace stored nothing in expo-sqlite/kv-store');
  const back = pace.readWalkingPace();
  if (back?.walkMps !== 1.5 || back?.jogMps !== 3.1) fail(`after saving 1.5 / 3.1, readWalkingPace() gives ${JSON.stringify(back)}`);
  const before = JSON.stringify([...Kv.__map]);
  const refused = pace.saveWalkingPace({ walkMps: 2, jogMps: 1.8 });
  if (refused?.ok !== false) fail(`a jog (1.8 m/s) no faster than the walk (2 m/s) must be refused (ok: false); got ${JSON.stringify(refused)}`);
  if (JSON.stringify([...Kv.__map]) !== before) fail('a refused pace still changed the stored values');
}

const CHECKS: Record<string, () => unknown> = { masked, save, clear, quota, health, agency, attribution, schedule, pace, 'pace-store': paceStore };

// The real modules are require()d inside the test, so a cold transform cache counts toward its time: allow 120 s.
it('ratchet m8b oracle', async () => {
  const run = CHECKS[CHECK];
  expect(typeof run).toBe('function');
  await run();
  expect(CHECK.length).toBeGreaterThan(0);
}, 120_000);
ORACLE
  out=$(local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.tsx' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 "ratchet-oracle:" | sed -e 's/^ *//'
    elif echo "$out" | _qgrep -E '●|Exceeded timeout|Cannot find module|SyntaxError'; then echo "$out" | grep -E -A6 '●|Exceeded timeout|Cannot find module|SyntaxError' | grep -vE '^ +at ' | head -24
    else echo "$out" | tail -30; fi
    echo "ratchet: data_oracle '$check' failed on the real screen"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the '$check' oracle did not run"; return 1; }
  echo "ratchet: data_oracle '$check' passed on the real screen"
}

# m8b_built — this card's own artifacts exist (route, screen, pace store) and every pinned phrase is the
# title of some test under src/ui/settings/__tests__; the repo-wide gates below run only after this, so
# they can never pass on a tree where M8b.1 is unbuilt.
m8b_built() {
  local f p
  for f in "$M8B_ROUTE" "$M8B_SCREEN" "$M8B_PACE"; do need_file "$f" || return 1; done
  [ -d "$M8B_TESTS" ] || { echo "ratchet: missing $M8B_TESTS — the milestone's tests do not exist yet"; return 1; }
  for p in "${M8B_PINS[@]}"; do
    grep -rqiF -- "$p" "$M8B_TESTS" || { echo "ratchet: no test under $M8B_TESTS is named '$p'"; return 1; }
  done
}

# m8b_full_gate — guarded by m8b_built, then lib's full_gate (no argv-reading tests; npm run verify:
# tsc app + scripts, eslint --max-warnings 0, the standards checker, jest, node:test).
m8b_full_gate() {
  m8b_built || return 1
  full_gate
}

# m8b_ios_export — guarded by m8b_built, then a fresh lib ios_export. Every expo-router route key ("./x.tsx")
# in the Hermes bundle that metadata.json names must be a file under THIS repo's src/app — Metro's transform
# cache lives in $TMPDIR/metro-cache and is shared by every checkout whose node_modules resolves to the same
# real expo-router (worktrees and scratch copies symlink it), and its cached require.context can point at
# ANOTHER checkout's src/app (seen 2026-10-01) — and ./data.tsx and the "Data & Settings" title must be there.
m8b_ios_export() {
  local bundle keys key rc=0 foreign=""
  m8b_built || return 1
  ios_export || return 1
  bundle=$(node -e 'process.stdout.write(String(require("./.cache/export/metadata.json").fileMetadata.ios.bundle))') \
    || { echo "ratchet: .cache/export/metadata.json names no iOS bundle"; return 1; }
  [ -s ".cache/export/$bundle" ] || { echo "ratchet: the exported iOS bundle .cache/export/$bundle is missing or empty"; return 1; }
  keys=$(grep -aoE '\./[]A-Za-z0-9_()+/[-]+\.tsx' ".cache/export/$bundle" | sort -u) || rc=$?   # POSIX bracket: ] first, - last
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (rc=$rc) reading the exported bundle"; return 1; }
  while IFS= read -r key; do
    if [ -n "$key" ] && [ ! -f "src/app/${key#./}" ]; then foreign="$foreign $key"; fi
  done <<< "$keys"
  [ -z "$foreign" ] || { echo "ratchet: the exported bundle carries routes this repo does not have:$foreign — Metro reused another checkout's cached router context; clear it (npx expo export --platform ios --output-dir .cache/export --clear) and rerun"; return 1; }
  grep -aqF -- "./data.tsx" ".cache/export/$bundle" || { echo "ratchet: the exported iOS bundle has no route ./data.tsx"; return 1; }
  grep -aqF -- "Data & Settings" ".cache/export/$bundle" || { echo "ratchet: the exported iOS bundle never says 'Data & Settings'"; return 1; }
  echo "ratchet: the exported iOS bundle carries ./data.tsx and its title, and only this repo's routes"
}

if (return 0 2>/dev/null); then return 0; fi

# --- M8b.1 route + title ---------------------------------------------------------------------------------
# 1. The route exists where the plan puts it.
need_file src/app/data.tsx
# 2. A: the route's own header title is 'Data & Settings', shown, and its back button never reads "(tabs)" (AST of src/app/_layout.tsx + src/app/data.tsx).
route_title
# 3. The route renders the screen component from src/ui/settings (no logic in src/app).
need_all src/app/data.tsx "from ['\"](@/ui/settings/DataSettingsScreen|\.\./ui/settings/DataSettingsScreen)['\"]" '<DataSettingsScreen\b'
# 4. The screen is a container over the live context (useLive) plus an exported, prop-driven DataSettingsView({ live }).
need_all src/ui/settings/DataSettingsScreen.tsx 'export (function|const) DataSettingsScreen\b' 'export (function|const) DataSettingsView\b' 'useLive\('
# 5. A (named test): the title is Data & Settings, never "(tabs)".
pin_test 'the title is data & settings, never (tabs)'

# --- M8b.1 Live data: keys in the Keychain, never rendered -------------------------------------------------
# 6. Keys reach the Keychain only through src/live/keys.ts (via the live runtime): no non-test settings code imports expo-secure-store.
absent_code 'expo-secure-store' src/ui/settings src/app/data.tsx
# 7. Nothing in the settings code logs (a key must never reach a log).
absent_code 'console\.' src/ui/settings src/app/data.tsx
# 8. Every jest.mock in the settings tests is a labelled native-module mock, and expo-secure-store is mocked.
mocks_labelled src/ui/settings/__tests__
# 9. A (named test): Save writes SecureStore live.key.transitland.
pin_test 'save writes live.key.transitland to the keychain'
# 10. A (named test): the full key is never rendered, only its masked last 4.
pin_test 'the full key is never rendered, only its last 4'
# 11. A (named test): Clear deletes the key.
pin_test 'clear deletes the key from the keychain'
# 12. Oracle: a stored key renders "Saved ••••<last4>" and no 5-char run of it; an absent key reads "Not set".
data_oracle masked
# 13. Oracle: paste + Save → setItemAsync('live.key.transitland', trimmed) once, in effect in the runtime, field cleared, masked last 4 shown.
data_oracle save
# 14. Oracle: Clear → deleteItemAsync('live.key.transitland') only, out of effect in the runtime, "Not set".
data_oracle clear
# 15. Swiftly's agency key field: shows the default 'miami'; saving stores live.agency.swiftly and puts it in effect (oracle).
data_oracle agency
# 16. A (named test): the Swiftly agency key defaults to miami.
pin_test 'the swiftly agency key defaults to miami'

# --- M8b.1 provider health + quota ---------------------------------------------------------------------------
# 17. The Transitland limit comes from PROVIDER_CONFIG.transitland.monthlyQuota, never a literal in the settings code (comment lines may name it).
absent_code '10,000|10000|10_000' src/ui/settings src/app/data.tsx
# 18. Oracle: 1234 Transitland calls this month render "1234 of 10,000" (grouping "1,234" accepted).
data_oracle quota
# 19. A (named test): the quota row reads 1234 of 10,000.
pin_test 'the quota row reads 1234 of 10,000'
# 20. Oracle: the provider status row says Failing after 3 failed Transitland polls (and not before).
data_oracle health
# 21. Named test: the status row shows the provider state, the last update age and bytes per poll.
pin_test 'the status row shows the provider state, update age and bytes per poll'

# --- M8b.1 schedule, walking pace, attribution ----------------------------------------------------------------
# 22. Oracle: the bundled manifest's feed hash and both service ends render, and the expiry state has text.
data_oracle schedule
# 23. Oracle: walking-pace.ts — defaults 1.35 / 2.7 m/s, persisted in expo-sqlite/kv-store, a jog no faster than the walk refused.
data_oracle pace-store
# 24. Oracle: the screen shows the default paces, and a saved pace after a remount.
data_oracle pace
# 25. Named test: walking pace saves through the kv store and reads back.
pin_test 'walking pace saves through the kv store and reads back'
# 26. Oracle: both attribution links open their exact URLs, and all four sources are named.
data_oracle attribution
# 27. A (named test): both attribution URLs are exact.
pin_test 'both attribution urls are exact'

# --- M8b.1 entry points ----------------------------------------------------------------------------------------
# 28. Data & Settings links to Diagnostics.
reaches_route src/app/data.tsx /diagnostics 'Data & Settings -> Diagnostics'
# 29. Diagnostics opens Data & Settings.
reaches_route src/app/diagnostics.tsx /data 'Diagnostics -> Data & Settings'
# 30. The tab-bar accessory (and the status pill, once m5c builds it) opens Data & Settings.
floating_entries_reach /data

# --- repo-wide, guarded behind this card's own artifacts ------------------------------------------------------
# 31. Route + screen + pace store + every pinned test exist, THEN npm run verify (tsc, eslint, standards, jest, node:test) and the argv ban.
m8b_full_gate
# 32. Route + screen + pace store + every pinned test exist, THEN a fresh iOS export whose bundle carries ./data.tsx, "Data & Settings", and no route this repo lacks.
m8b_ios_export

echo "m8b_data_settings: all 32 gates green"
