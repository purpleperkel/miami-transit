#!/usr/bin/env bash
# mfix10_swiftly_wifi_only — "use Swiftly only on Wi-Fi" (Jamie, 2026-10-02 ~10:25, verbatim: "Can u build auto WiFi
# detection and have a setting in app that's like use swiftly only on wifi"). His 10:19 Data & Settings screenshot read
# Swiftly "Live · updated 9 s ago · 475.5 KB per poll": the Swiftly provider downloads the WHOLE-AGENCY
# gtfs-rt-trip-updates every 30 s while predictions are watched, past plan risk R19's 300 KB-per-poll line.
# Today (a04a4cb) Swiftly serves first whenever it has a key, on any network; expo-network is not installed.
# Arbiter brief (binding): .cache/reseq-inputs/mfix10-brief.md. Rulings: scope is literal (setting on + not on Wi-Fi =
# Swiftly makes NO request, Transitland serves both capabilities as if Swiftly had no key); default ON; "on Wi-Fi" =
# type WIFI or ETHERNET (CELLULAR, NONE, UNKNOWN, anything else and no reading yet are NOT Wi-Fi); a gated Swiftly is
# not a failing one (no failure, no backoff, no 3-failure failover, no 300 s re-probe wait; back on Wi-Fi it serves at
# the next poll tick); a request already in flight may finish, no NEW Swiftly request starts while gated.
# FIXTURE-ONLY: no gate calls the network (fetch is a fake; `expo install --check` runs with EXPO_OFFLINE=1).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not stop
# the script); compound checks live inside the card helpers below. Helpers read no variable another gate set.
# Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix10_swiftly_wifi_only.sh
#
# BINDING CONTRACT (the oracles below load these by exact path and export name; the card note spells out the copy):
#   src/domain/live/network-gate.ts  export function isOnWifi(state: { type?: string } | null): boolean
#                                    export function swiftlyAllowed({ wifiOnly, onWifi }): boolean  (= !wifiOnly || onWifi)
#                                    pure: imports no expo / react / react-native / '@/' module
#   src/live/swiftly-wifi.ts  export const DEFAULT_SWIFTLY_WIFI_ONLY = true
#                                    export function readSwiftlyWifiOnly(store = Storage): boolean
#                                    export function saveSwiftlyWifiOnly(value: boolean, store = Storage): Result<boolean, …>
#                                    ONE expo-sqlite/kv-store item, 'settings.swiftly-wifi-only'
#   src/live/live-context.tsx        LiveDataProvider (unchanged name) owns the ONE expo-network watch (it, or the
#                                    LiveRuntime it starts): getNetworkStateAsync once on mount + addNetworkStateListener,
#                                    the subscription removed on unmount; the gate is re-read at every poll tick
#   Data & Settings (DataSettingsScreen > LiveDataSection), in the Swiftly card: a Switch testID 'swiftly-wifi-only',
#                                    accessibilityLabel and visible label exactly "Use Swiftly only on Wi-Fi"; the Swiftly
#                                    status row 'provider-status-swiftly' reads exactly "Paused · not on Wi-Fi" while gated;
#                                    the section footer is exactly MFIX10_FOOTER below
#
# TEST-NAME CONVENTION (verify-mfix6's): each acceptance case is its OWN passing jest test whose full name (describe
# titles + test title, one space, case-insensitive) ENDS with the case's exact phrase at a word boundary.
MFIX10_JEST_CASES=(
  'only wifi and ethernet count as on wi-fi'
  'swiftly is allowed unless wi-fi only is on and the phone is off wi-fi'
  'the wi-fi only setting is on when its item is empty or unreadable'
  'the wi-fi only setting round-trips through one kv item'
  'wi-fi only on cellular serves vehicles and predictions from transitland and swiftly sees zero requests'
  'wi-fi only on wi-fi serves from swiftly'
  'wi-fi only off on cellular serves from swiftly'
  'cellular to wi-fi to cellular switches the provider within one cadence each time'
  'gated time adds no swiftly failures so swiftly serves at the next tick back on wi-fi'
  'no network reading yet counts as not on wi-fi'
  'a network change sends the next fetch of the real live provider to the allowed provider'
  'a toggle saved through the setting sends the next fetch to the allowed provider'
  'the network watch is read once on mount and removed on unmount'
  'the wi-fi only switch renders under swiftly and is on by default'
  'toggling the wi-fi only switch writes its kv item'
  'a gated swiftly row reads paused not on wi-fi'
  'transitland shows its own live health while it serves for a gated swiftly'
  'the live data footer states the wi-fi rule'
)
# The card's own test files (the guard for the re-check and repo-wide gates).
MFIX10_GATE_TEST=src/domain/live/__tests__/network-gate.test.ts
MFIX10_SETTING_TEST=src/live/__tests__/swiftly-wifi.test.ts
MFIX10_CHAIN_TEST=src/live/__tests__/swiftly-wifi-chain.test.ts
MFIX10_WATCH_TEST=src/live/__tests__/network-watch.test.tsx
MFIX10_SCREEN_TEST=src/ui/settings/__tests__/swiftly-wifi-setting.test.tsx
# The Live data footer (arbiter brief D, exact; the apostrophe is a plain ').
MFIX10_FOOTER="Keys stay in this phone's Keychain. Swiftly serves first when it has a key (only on Wi-Fi, if that is on); Transitland otherwise."

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied from verify-mfix6_one_location_watch.sh (only the card universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX10_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix10_swiftly_wifi_only.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX10_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX10_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX10_JEST_CASES[@]}" || return 1
}

# need_files and mocks_native_only: copied VERBATIM from verify-mfix6_one_location_watch.sh.
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

# The card's own test files: the guard for the re-checks and the repo-wide gates (a bare full_gate is green on the
# unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files "$MFIX10_GATE_TEST" "$MFIX10_SETTING_TEST" "$MFIX10_CHAIN_TEST" "$MFIX10_WATCH_TEST" "$MFIX10_SCREEN_TEST" || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built that this card's edits could break, run
# only WITH this card's files.
after_card() {
  [ "$#" -ge 1 ] || { echo "ratchet: after_card needs a gate to run"; return 1; }
  card_files || return 1
  "$@" || return 1
}

# card_full_gate — npm run verify (tsc app + scripts, eslint --max-warnings 0, standards, jest — every existing test —
# and node:test) green WITH this card's files in the tree.
card_full_gate() {
  card_files || return 1
  full_gate || return 1
}

# card_export_carries <text> — guarded on this card's files: Metro bundles the app for iOS (lib.sh ios_export) on a
# PRIVATE Metro cache (TMPDIR; mfix2/m10b/mfix6/mfix8 pattern), then a --no-bytecode export (never a .hbc grep: Hermes
# bytecode stores strings in its own table) must carry <text> as a whole string literal.
card_export_carries() {
  local text="$1" metro_tmp="$PWD/.cache/metro-tmp-mfix10" dir=.cache/export-mfix10-js out rc=0
  [ -n "$text" ] || { echo "ratchet: verify-script authoring error: card_export_carries needs a text"; return 1; }
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(export TMPDIR="$metro_tmp"; npx expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  grep -rqF -e "\"$text\"" -e "'$text'" -e "\`$text\`" "$dir/_expo/static/js/ios" || rc=$?
  [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle has no whole string literal \"$text\" — the Wi-Fi only switch is not shipped"; return 1; }
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  echo "ratchet: the iOS bundle exports and carries \"$text\""
}

# stepped_test <test file> [spy] — the repo's act() timer trap (CLAUDE.md, mfix5): the file runs on jest fake timers
# (jest.useFakeTimers), advances them ONLY by advanceTimersByTime / advanceTimersByTimeAsync with a numeric literal of at
# most 1000 ms or HEARTBEAT_MS (never runAllTimers / runOnlyPendingTimers / advanceTimersToNextTimer, which jump), and
# with `spy`, holds a call spy (jest.fn or jest.spyOn) — the chain cases count Swiftly's calls with it.
stepped_test() {
  local file="$1" spy="${2:-}"
  need_file "$file" || return 1
  node - "$file" "$spy" <<'NODE' || return 1
const fs = require("node:fs");
const [file, spy] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const problems = [];
if (!/\bjest\.useFakeTimers\s*\(/.test(text)) problems.push("it never calls jest.useFakeTimers()");
const steps = [...text.matchAll(/\badvanceTimersByTime(?:Async)?\s*\(([^()]*)\)/g)];
if (steps.length === 0) problems.push("it never advances the fake timers with advanceTimersByTime / advanceTimersByTimeAsync");
for (const m of steps) {
  const arg = m[1].trim();
  const n = /^[0-9][0-9_]*$/.test(arg) ? Number(arg.replace(/_/g, "")) : null;
  if (arg !== "HEARTBEAT_MS" && (n === null || n > 1000)) problems.push(`advanceTimersByTime(${arg}) — each step is a literal <= 1000 ms or HEARTBEAT_MS`);
}
for (const jump of text.matchAll(/\b(runAllTimers|runOnlyPendingTimers|advanceTimersToNextTimer|runAllTimersAsync|runOnlyPendingTimersAsync|advanceTimersToNextTimerAsync)\s*\(/g)) problems.push(`${jump[1]}() jumps the clock — step it by <= 1 s instead`);
if (spy === "spy" && !/\bjest\.(fn|spyOn)\s*\(/.test(text)) problems.push("it holds no call spy (jest.fn / jest.spyOn) to count Swiftly's calls");
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${file}: ${p}`)); process.exit(1); }
console.log(`ratchet: ${file}: fake timers stepped by <= 1 s (${steps.length} step call(s))${spy === "spy" ? ", with a call spy" : ""}`);
NODE
}

# card_mocks_native_only — mocks_native_only (mfix6's helper, unchanged) over EXACTLY this card's five test files, copied
# into a throwaway folder: a folder-wide scan would also judge src/ui/settings/__tests__/native-fakes.ts, whose doc
# comment shows a jest.mock example under a ' * '-prefixed label (not this card's code).
card_mocks_native_only() {
  local tmp f rc=0
  card_files || return 1
  tmp="$PWD/.cache/ratchet-mfix10-mocks.$$.$RANDOM"
  mkdir -p "$tmp" || { echo "ratchet: cannot create $tmp"; return 1; }
  for f in "$MFIX10_GATE_TEST" "$MFIX10_SETTING_TEST" "$MFIX10_CHAIN_TEST" "$MFIX10_WATCH_TEST" "$MFIX10_SCREEN_TEST"; do
    cp "$f" "$tmp/$(printf '%s' "$f" | tr '/' '_')" || { rm -rf "$tmp"; echo "ratchet: cannot copy $f"; return 1; }
  done
  mocks_native_only "$tmp" || rc=$?
  rm -rf "$tmp" || { echo "ratchet: cannot remove $tmp"; return 1; }
  return "$rc"
}

# one_watch_site — brief B: outside tests, EXACTLY ONE file in src/ calls addNetworkStateListener( or useNetworkState(;
# it is under src/live/ (the live runtime owns the watch), it calls getNetworkStateAsync( and addNetworkStateListener(,
# no other non-test file in src/ calls getNetworkStateAsync( (one app-wide reading), no other non-test file imports
# expo-network for a value (aliases and namespaces included), and none reaches the ExpoNetwork native module.
# The import and native-module scans read the TypeScript AST (the house pattern, verify-mfix6 _mfix6_ast: comments are
# trivia, so a comment naming a module or the native module never counts). A module is named by import / export … from /
# import = require(), or by require() / import() with a CONSTANT string specifier, folded the way Metro's
# collectDependencies evaluates one (literals, templates and + over them: 'expo-' + 'network' IS expo-network). A
# require() / import() whose specifier is not such a constant is refused outright: Metro rejects a dynamic require in app
# code, and the scan could not see what it loads. The native module's names ('ExpoNetwork', 'onNetworkStateChanged')
# count as an identifier or property name (NativeModulesProxy.ExpoNetwork, globalThis.expo.modules.ExpoNetwork), a
# string, or a constant concatenation ('Expo' + 'Network').
one_watch_site() {
  node - <<'NODE' || return 1
const fs = require("node:fs");
const path = require("node:path");
const files = fs.readdirSync("src", { recursive: true }).map(String).map((f) => path.join("src", f))
  .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/(^|\/)__tests__\//.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f));
const read = (f) => fs.readFileSync(f, "utf8");
const NATIVE = ["ExpoNetwork", "onNetworkStateChanged"];
const isExpoNetwork = (spec) => spec === "expo-network" || spec.startsWith("expo-network/");
function nodesOf(ts, root) {
  const out = [], stack = [root];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (k) => { stack.push(k); }); }
  return out;
}
/** The constant string an expression folds to (string literals, templates and + over them, parenthesised), else null. */
function constString(ts, root) {
  const value = new Map(), stack = [[root, false]];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const [n, ready] = stack.pop();
    if (ts.isStringLiteralLike(n)) value.set(n, n.text);
    else if (ts.isParenthesizedExpression(n)) { if (ready) value.set(n, value.get(n.expression) ?? null); else stack.push([n, true], [n.expression, false]); }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (!ready) { stack.push([n, true], [n.left, false], [n.right, false]); continue; }
      const l = value.get(n.left), r = value.get(n.right);
      value.set(n, typeof l === "string" && typeof r === "string" ? l + r : null);
    } else if (ts.isTemplateExpression(n)) {
      if (!ready) { stack.push([n, true], ...n.templateSpans.map((s) => [s.expression, false])); continue; }
      const parts = n.templateSpans.map((s) => value.get(s.expression));
      value.set(n, parts.every((p) => typeof p === "string") ? n.head.text + n.templateSpans.map((s, i) => parts[i] + s.literal.text).join("") : null);
    } else value.set(n, null);
  }
  const v = value.get(root);
  return typeof v === "string" ? v : null;
}
/** One file's AST: how often it imports expo-network for a value, its unreadable specifiers, its native-module names. */
function scanFile(ts, file) {
  const kind = /\.[cm]?jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
  const at = (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const typeOnlyList = (list) => list.length > 0 && list.every((e) => e.isTypeOnly);
  const out = { file, valueImports: 0, computed: [], native: [] };
  for (const n of nodesOf(ts, sf)) {
    let spec = null, value = true;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      spec = n.moduleSpecifier.text;
      value = !(c !== undefined && (c.isTypeOnly || (c.name === undefined && c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) && typeOnlyList(c.namedBindings.elements))));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      spec = n.moduleSpecifier.text;
      value = !(n.isTypeOnly || (n.exportClause !== undefined && ts.isNamedExports(n.exportClause) && typeOnlyList(n.exportClause.elements)));
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      spec = constString(ts, n.moduleReference.expression);
      value = !n.isTypeOnly;
      if (spec === null) out.computed.push(at(n));
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      spec = n.arguments.length === 1 ? constString(ts, n.arguments[0]) : null;
      if (spec === null) out.computed.push(at(n));
    }
    if (spec !== null && value && isExpoNetwork(spec)) out.valueImports += 1;
    const name = ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text
      : ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) ? constString(ts, n) : null;
    if (name !== null && NATIVE.includes(name)) out.native.push(`${name} at ${at(n)}`);
  }
  return out;
}
const watch = files.filter((f) => /\b(addNetworkStateListener|useNetworkState)\s*\(/.test(read(f)));
const readers = files.filter((f) => /\bgetNetworkStateAsync\s*\(/.test(read(f)));
const problems = [];
if (watch.length !== 1) problems.push(`${watch.length} non-test file(s) in src/ call addNetworkStateListener( or useNetworkState(: ${JSON.stringify(watch)} — exactly one owns the watch`);
else {
  const site = watch[0], text = read(site);
  if (!site.startsWith("src/live/")) problems.push(`the watch lives in ${site}: the live runtime owns it (src/live/)`);
  if (/\buseNetworkState\s*\(/.test(text)) problems.push(`${site} calls useNetworkState( — the note's watch is getNetworkStateAsync once + addNetworkStateListener`);
  if (!/\baddNetworkStateListener\s*\(/.test(text)) problems.push(`${site} never calls addNetworkStateListener(`);
  if (!/\bgetNetworkStateAsync\s*\(/.test(text)) problems.push(`${site} never calls getNetworkStateAsync( (the reading on mount)`);
  const others = readers.filter((f) => f !== site);
  if (others.length) problems.push(`getNetworkStateAsync( is called outside the watch site too: ${JSON.stringify(others)}`);
  // An aliased import (`addNetworkStateListener as listen`) or a namespace call hides the name from the call scan above,
  // and the native module (ExpoNetwork / 'onNetworkStateChanged') bypasses expo-network: so the watch site is also the
  // ONLY non-test file that imports expo-network for a value (an `import type` is fine), every require() / import() names
  // a constant module, and no file names the native module.
  let ts = null;
  try { ts = require(path.join(process.cwd(), "node_modules", "typescript")); } catch (e) { problems.push(`typescript is not installed in node_modules (${e.message}): the import and native-module scans read the TypeScript AST`); }
  const scans = ts === null ? [] : files.map((f) => scanFile(ts, f));
  const strays = scans.filter((s) => s.valueImports > 0 && s.file !== site).map((s) => s.file);
  if (strays.length) problems.push(`expo-network is imported outside the watch site: ${JSON.stringify(strays)} — one app-wide watch`);
  const computed = scans.flatMap((s) => s.computed);
  if (computed.length) problems.push(`require() / import() with a specifier that is not a constant string: ${JSON.stringify(computed)} — Metro bundles only constant specifiers, and the one-watch scan must see what every module loads`);
  const native = scans.flatMap((s) => s.native);
  if (native.length) problems.push(`the ExpoNetwork native module is reached directly: ${JSON.stringify(native)} — one app-wide watch, through expo-network`);
  if (ts !== null && !scans.some((s) => s.file === site && s.valueImports > 0)) problems.push(`${site} holds the watch but the import scan finds no value import of expo-network in it (premise of the scan)`);
}
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${p}`)); process.exit(1); }
console.log(`ratchet: one network watch, in ${watch[0]}`);
NODE
}

# domain_pure — brief B: src/domain/live/network-gate.ts imports no expo / react / react-native / '@/' module (the domain
# stays pure; it takes the strings 'WIFI' / 'ETHERNET', never expo-network's NetworkStateType enum).
domain_pure() {
  local file=src/domain/live/network-gate.ts
  need_file "$file" || return 1
  node - "$file" <<'NODE' || return 1
const fs = require("node:fs");
const file = process.argv[2];
const text = fs.readFileSync(file, "utf8");
const specs = [...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
const banned = specs.filter((s) => /^(react|react-native|expo|@expo\/|@\/)/.test(s));
const problems = [];
if (banned.length) problems.push(`imports ${JSON.stringify(banned)} — the domain is pure`);
if (/\bNetworkStateType\b/.test(text)) problems.push("names expo-network's NetworkStateType — the domain takes the strings 'WIFI' / 'ETHERNET'");
if (!/['"`]WIFI['"`]/.test(text) || !/['"`]ETHERNET['"`]/.test(text)) problems.push("does not name the strings 'WIFI' and 'ETHERNET'");
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${file}: ${p}`)); process.exit(1); }
console.log(`ratchet: ${file} is pure (imports: ${JSON.stringify(specs)})`);
NODE
}

# expo_network_installed — brief E: `npx expo install expo-network` ran: package.json DEPENDENCIES (not dev) carry it at an
# SDK-pinned ~57.x.y, package-lock.json and node_modules hold a 57.x copy, and `expo install --check` is clean. The check
# runs OFFLINE (EXPO_OFFLINE=1: versions from the installed expo package's bundledNativeModules.json, no network).
expo_network_installed() {
  node - <<'NODE' || return 1
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const problems = [];
const want = (pkg.dependencies ?? {})["expo-network"];
if (want === undefined) problems.push("package.json dependencies have no expo-network (npx expo install expo-network)");
else if (!/^~57\.\d+\.\d+$/.test(want)) problems.push(`package.json pins expo-network ${JSON.stringify(want)}: the SDK pin is ~57.x.y`);
if ((pkg.devDependencies ?? {})["expo-network"] !== undefined) problems.push("expo-network is also a devDependency: it ships in the app");
let lock = null;
try { lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); } catch (e) { problems.push(`package-lock.json unreadable: ${e.message}`); }
const locked = lock?.packages?.["node_modules/expo-network"]?.version;
if (lock !== null && !/^57\./.test(String(locked))) problems.push(`package-lock.json locks expo-network at ${JSON.stringify(locked ?? null)}: want 57.x`);
let installed = null;
try { installed = JSON.parse(fs.readFileSync("node_modules/expo-network/package.json", "utf8")).version; } catch { problems.push("node_modules/expo-network is not installed"); }
if (installed !== null && !/^57\./.test(installed)) problems.push(`node_modules holds expo-network ${installed}: want 57.x`);
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${p}`)); process.exit(1); }
console.log(`ratchet: expo-network ${want} in dependencies, ${locked} locked and installed`);
NODE
  EXPO_OFFLINE=1 local_bin expo install --check || { echo "ratchet: expo install --check is not clean (offline, against the installed SDK's pins)"; return 1; }
}

# expo_network_mock_labelled — brief E: the tests mock expo-network (they drive the network type), and every jest.mock /
# jest.doMock of it in src/ carries '// test-time mock of native module' on the line DIRECTLY ABOVE the call (the card
# note's placement; a label trailing the call or inside it does not count).
expo_network_mock_labelled() {
  node - <<'NODE' || return 1
const fs = require("node:fs");
const path = require("node:path");
const LABEL = "// test-time mock of native module";
const files = fs.readdirSync("src", { recursive: true }).map(String).map((f) => path.join("src", f))
  .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && (/(^|\/)__tests__\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f)));
const problems = [];
let mocks = 0;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n");
  for (const m of text.matchAll(/\bjest\.(?:mock|doMock|setMock|unstable_mockModule)\(\s*(['"`])expo-network\1/g)) {
    mocks += 1;
    const lineNo = text.slice(0, m.index).split("\n").length;
    const above = (lines[lineNo - 2] ?? "").trim();
    if (!above.startsWith(LABEL)) problems.push(`${f}:${lineNo}: jest.mock('expo-network') lacks the '${LABEL}' label on the line directly above it (the card note's placement)`);
  }
}
if (mocks === 0) problems.push("no test mocks expo-network: the card's tests drive the network type through a labelled jest mock of it");
if (problems.length) { problems.forEach((p) => console.log(`ratchet: ${p}`)); process.exit(1); }
console.log(`ratchet: ${mocks} jest mock(s) of expo-network, all labelled`);
NODE
}

# mfix10_oracle <case> — the card's behaviour checked on the SHIPPED app, independent of the builder's tests: a
# throwaway jest test in the gitignored .cache (removed whether it passes or fails; mfix8's pattern) under the repo's own
# jest-expo/ios transform. Pure cases (network_gate, setting) load the two new modules. Live cases render the REAL
# LiveDataProvider inside the REAL ScheduleDbProvider (the committed assets/db/schedule.db through node:sqlite) — plus
# the REAL DataSettingsScreen for the screen cases — with labelled native mocks only: expo-network (the oracle sets the
# first reading and emits changes to every live listener), expo/fetch (a fake server: Swiftly and Transitland answer
# 200 with the committed synthetic fixtures; every request is recorded), expo-secure-store (both fake keys saved),
# expo-sqlite/kv-store (the repo's native-fakes; the setting and the quota meter live there) and expo-sqlite. The app is
# active, a watcher asks the runtime for Government Center Metromover (stop 813), and jest's fake timers are stepped
# 1 s at a time inside act (the repo's act() trap). Cases: network_gate setting chain_cellular chain_wifi chain_off
# chain_flip chain_no_failures chain_no_reading wiring_toggle wiring_watch screen_switch screen_toggle screen_paused_row
# screen_transitland_row screen_footer
mfix10_oracle() {
  local which="$1" kind dir out rc=0
  case "$which" in
    network_gate|setting) kind=pure ;;
    chain_cellular|chain_wifi|chain_off|chain_flip|chain_no_failures|chain_no_reading|wiring_toggle|wiring_watch) kind=live ;;
    screen_switch|screen_toggle|screen_paused_row|screen_transitland_row|screen_footer) kind=live ;;
    *) echo "ratchet: verify-script authoring error: unknown mfix10 oracle case '$which'"; return 1 ;;
  esac
  if [ "$which" = network_gate ]; then need_files src/domain/live/network-gate.ts || return 1; fi
  if [ "$which" = setting ]; then need_files src/live/swiftly-wifi.ts || return 1; fi
  if [ "$kind" = live ]; then
    need_files src/domain/live/network-gate.ts src/live/swiftly-wifi.ts node_modules/expo-network/package.json || return 1
  fi
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-mfix10-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/wifi.oracle.test.tsx" <<'TSX'
const path = require('node:path');
const CASE = process.env.MFIX10_CASE ?? '';
const fail = (m: string): never => { throw new Error(`ratchet-oracle: ${CASE}: ${m}`); };
const show = (v: unknown): string => JSON.stringify(v);
const load = (rel: string, names: string[]): Record<string, any> => {
  let mod: Record<string, any> = {};
  try { mod = require(path.join(process.cwd(), rel)); } catch (e) { fail(`${rel} does not load under jest: ${(e as Error).message}`); }
  for (const n of names) if (mod[n] === undefined) fail(`${rel} exports no ${n}`);
  return mod;
};
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual(require('node:path').join(process.cwd(), 'src/ui/settings/__tests__/native-fakes')).kvStoreModule());
const ITEM = 'settings.swiftly-wifi-only';
const kvMap = (): Map<string, string> => jest.requireMock('expo-sqlite/kv-store').map;
const setting = () => load('src/live/swiftly-wifi', ['readSwiftlyWifiOnly', 'saveSwiftlyWifiOnly', 'DEFAULT_SWIFTLY_WIFI_ONLY']);
const memStore = () => { const map = new Map<string, string>(); return { map, getItemSync: (k: string) => map.get(k) ?? null, setItemSync: (k: string, v: string) => void map.set(k, v) }; };
TSX
  if [ "$kind" = live ]; then cat >> "$dir/wifi.oracle.test.tsx" <<'TSX'
type Net = { type?: string; isConnected?: boolean; isInternetReachable?: boolean };
type Sub = { listener: (s: Net) => void; remove: jest.Mock };
const mockNet = { first: { type: 'CELLULAR', isConnected: true, isInternetReachable: true } as Net | 'never', gets: 0, subs: [] as Sub[], landedAtS: null as number | null };
const mockHttp = { requests: [] as { url: string; at: number }[] };
let mockCopy: unknown = null;
// test-time mock of native module
jest.mock('expo-network', () => ({
  __esModule: true,
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI', BLUETOOTH: 'BLUETOOTH', ETHERNET: 'ETHERNET', WIMAX: 'WIMAX', VPN: 'VPN', OTHER: 'OTHER' },
  getNetworkStateAsync: mockGetNetworkState,
  addNetworkStateListener: mockAddNetworkListener,
  useNetworkState: mockUseNetworkState,
}));
// test-time mock of native module
jest.mock('expo-secure-store', () => jest.requireActual(require('node:path').join(process.cwd(), 'src/ui/settings/__tests__/native-fakes')).secureStoreModule());
// test-time mock of native module
jest.mock('expo/fetch', () => ({ __esModule: true, fetch: mockFetch }));
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockProvider, useSQLiteContext: mockScheduleCopy, openDatabaseSync: mockNoUserDb }));
function mockGetNetworkState(): Promise<Net> {
  mockNet.gets += 1;
  const first = mockNet.first;
  if (first === 'never') return new Promise<Net>(() => undefined);
  const answer = Promise.resolve({ ...first });
  // Registered before the app's own continuation, so it runs first: the fake instant the app can first know the reading.
  void answer.then(() => { if (mockNet.landedAtS === null) mockNet.landedAtS = Date.now() / 1000; });
  return answer;
}
function mockAddNetworkListener(listener: (s: Net) => void) {
  const sub = { listener, remove: jest.fn() };
  mockNet.subs.push(sub);
  return { remove: sub.remove };
}
function mockUseNetworkState(): never { throw new Error('ratchet-oracle: the note watches the network with getNetworkStateAsync + addNetworkStateListener, never useNetworkState'); }
function mockFetch(url: string) {
  mockHttp.requests.push({ url, at: Date.now() / 1000 });
  const body = mockReply(url);
  if (body === null) return Promise.reject(new Error(`ratchet-oracle: no fake route for ${url}`));
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(body.slice().buffer) });
}
function mockReply(url: string): Uint8Array | null {
  const root = require('node:path').join(process.cwd(), 'src/domain');
  const feeds = jest.requireActual(`${root}/gtfsrt/__fixtures__/live-feeds.fixture`);
  const departures = jest.requireActual(`${root}/live/__fixtures__/transitland-departures.fixture`);
  const replies: Record<string, Uint8Array> = {
    'https://api.goswift.ly/real-time/miami/gtfs-rt-vehicle-positions': feeds.LIVE_VEHICLES_FIXTURE_BYTES,
    'https://api.goswift.ly/real-time/miami/gtfs-rt-trip-updates': feeds.LIVE_TRIP_UPDATES_FIXTURE_BYTES,
    'https://transit.land/api/v2/rest/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb': feeds.LIVE_VEHICLES_FIXTURE_BYTES,
    'https://transit.land/api/v2/rest/stops/f-dhw-miamidadetransit:813/departures?next=3600': new TextEncoder().encode(JSON.stringify(departures.DEPARTURES_813)),
  };
  return replies[url] ?? null;
}
function mockProvider({ children }: { children?: unknown }) { return children as never; }
function mockScheduleCopy() {
  if (mockCopy === null) {
    const { DatabaseSync } = jest.requireActual('node:sqlite');
    const { SCHEDULE_DB_NAME } = jest.requireActual(require('node:path').join(process.cwd(), 'src/data/schedule-db-provider'));
    const db = new DatabaseSync(`${process.cwd()}/assets/db/schedule.db`, { readOnly: true });
    const args = (p: unknown) => (Array.isArray(p) ? p : p === undefined ? [] : [p]);
    mockCopy = { databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}`, getAllSync: (sql: string, p?: unknown) => db.prepare(sql).all(...args(p)), getFirstSync: (sql: string, p?: unknown) => db.prepare(sql).get(...args(p)) ?? null };
  }
  return mockCopy;
}
function mockNoUserDb(): never { throw new Error('ratchet-oracle: no user DB in this oracle'); }

const { act, create } = require('react-test-renderer');
const React = require('react');
const { AppState } = require('react-native');
const STATION = 'mover:government-center';
const T0_MS = Date.UTC(2026, 9, 1, 12, 0, 0); // Wed 2026-10-01 08:00 EDT
const SWIFTLY = 'https://api.goswift.ly/', TRANSITLAND = 'https://transit.land/';
const live: { current: any } = { current: null };
const trees: any[] = [];
type Req = { url: string; at: number; provider: 'swiftly' | 'transitland'; capability: 'vehicles' | 'predictions' };
const classify = (r: { url: string; at: number }): Req => {
  const provider = r.url.startsWith(SWIFTLY) ? 'swiftly' : r.url.startsWith(TRANSITLAND) ? 'transitland' : fail(`a request to neither provider: ${r.url}`);
  const capability = /vehicle/.test(r.url) ? 'vehicles' : /trip-updates|\/departures/.test(r.url) ? 'predictions' : fail(`a request for neither capability: ${r.url}`);
  return { ...r, provider, capability };
};
const requests = (from = 0): Req[] => mockHttp.requests.slice(from).map(classify);
const mark = (): number => mockHttp.requests.length;
const nowS = (): number => Date.now() / 1000;
beforeAll(() => { Object.assign(AppState, { currentState: 'active' }); }); // RN's jest AppState mock has currentState = jest.fn()
beforeEach(() => { jest.useFakeTimers({ now: T0_MS, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }); });
afterEach(async () => { await act(async () => { for (const t of trees.splice(0)) t.unmount(); }); jest.useRealTimers(); });

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); });
}
/** Advances the fake clock by `seconds`, ONE second per act (the repo's act() trap), letting each tick's requests settle. */
async function stepS(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
    await flush();
  }
}
/** Steps 1 s at a time, at most `maxS`, until `pred()`; the seconds it took, or null. */
async function untilS(maxS: number, pred: () => boolean): Promise<number | null> {
  for (let s = 0; s <= maxS; s += 1) { if (pred()) return s; await stepS(1); }
  return null;
}
function Watcher(): null {
  const { useLive } = load('src/live/live-context', ['useLive']);
  const value = useLive();
  live.current = value;
  React.useEffect(() => { value.runtime?.watchStations([STATION]); }, [value.runtime]);
  return null;
}
/** The real app's live wiring (and, with `screen`, the real Data & Settings screen) over the fakes; `first` is expo-network's first reading. */
async function mount(first: Net | 'never', opts: { wifiOnly?: boolean; screen?: boolean } = {}): Promise<any> {
  mockNet.first = first; mockNet.gets = 0; mockNet.landedAtS = null; mockNet.subs.splice(0); mockHttp.requests.splice(0);
  const keychain = jest.requireMock('expo-secure-store');
  keychain.items.clear(); kvMap().clear();
  keychain.items.set('live.key.swiftly', 'fake-swiftly-oracle-key');
  keychain.items.set('live.key.transitland', 'fake-transitland-oracle-key');
  if (opts.wifiOnly === false) { const saved = setting().saveSwiftlyWifiOnly(false); if (!saved.ok || saved.value !== false) fail(`saveSwiftlyWifiOnly(false) returned ${show(saved)}`); }
  const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
  const { LiveDataProvider } = load('src/live/live-context', ['LiveDataProvider']);
  const Screen = opts.screen ? load('src/ui/settings/DataSettingsScreen', ['DataSettingsScreen']).DataSettingsScreen : null;
  let tree: any = null;
  await act(async () => { tree = create(React.createElement(ScheduleDbProvider, null, React.createElement(LiveDataProvider, null, React.createElement(Watcher), Screen ? React.createElement(Screen) : null))); });
  trees.push(tree);
  await flush();
  if (live.current?.runtime == null) fail('the live runtime did not start over the schedule DB');
  return tree;
}
/** Every live listener hears `type` (iOS's isConnected for it); `null` is a listener event with NO type (connected, type unknown). */
async function emit(type: string | null): Promise<void> {
  const state = type === null ? { isConnected: true, isInternetReachable: true } : { type, isConnected: type !== 'NONE' && type !== 'UNKNOWN', isInternetReachable: type !== 'NONE' && type !== 'UNKNOWN' };
  const open = mockNet.subs.filter((s) => s.remove.mock.calls.length === 0);
  if (open.length === 0) fail(`no live expo-network listener to hear ${type ?? "an event with no type"} (addNetworkStateListener was called ${mockNet.subs.length} time(s))`);
  await act(async () => { for (const s of open) s.listener(state); });
  await flush();
}
const state = (): any => live.current?.state ?? fail('the live runtime has published no state');
/** Both capabilities' first request after `from`: [vehicles, predictions] (undefined when none yet). */
const firsts = (from: number) => (['vehicles', 'predictions'] as const).map((c) => requests(from).find((r) => r.capability === c));
/** Both capabilities' next request after `from` go to `provider` within `maxS` s (the gate re-read at a poll tick). */
async function nextGoesTo(provider: 'swiftly' | 'transitland', from: number, maxS: number, why: string): Promise<void> {
  const took = await untilS(maxS, () => firsts(from).every((r) => r !== undefined));
  const [v, p] = firsts(from);
  if (took === null) fail(`${why}: within ${maxS} s, vehicles went to ${v?.provider ?? 'nobody'} and predictions to ${p?.provider ?? 'nobody'} — the next fetch of each must start within one cadence`);
  if (v?.provider !== provider || p?.provider !== provider) fail(`${why}: the NEXT fetch of each capability must go to ${provider}; vehicles went to ${v?.provider} (${v?.url}), predictions to ${p?.provider} (${p?.url})`);
}
const noneTo = (provider: string, from: number, why: string): void => {
  const hits = requests(from).filter((r) => r.provider === provider);
  if (hits.length) fail(`${why}: ${provider} must see ZERO new requests, saw ${hits.length}: ${show(hits.slice(0, 3).map((r) => r.url))}`);
};
const serving = (provider: string, why: string): void => {
  const s = state().status;
  if (s.vehicles.provider !== provider || s.predictions.provider !== provider) fail(`${why}: the chain must report ${provider} serving both capabilities, got vehicles ${s.vehicles.provider}, predictions ${s.predictions.provider}`);
  if (s.vehicles.failing || s.predictions.failing) fail(`${why}: nothing is failing, got ${show(s)}`);
};
/**
 * Steps until Swiftly's next poll is ONE second away (its latest request + its cadence - 1): a gate that closes now must
 * stop that poll, so a gate read late (cached, throttled, debounced against flaps) lets a NEW Swiftly request through.
 */
async function toEveOfSwiftlyPoll(): Promise<void> {
  const cadenceS = load('src/domain/live/constants', ['PROVIDER_CONFIG']).PROVIDER_CONFIG.swiftly.cadenceS;
  const last = Math.max(...requests().filter((r) => r.provider === 'swiftly').map((r) => r.at));
  if (!Number.isFinite(last)) fail('premise: Swiftly has polled before the gate closes');
  const wait = Math.round(last + cadenceS - 1 - nowS());
  if (wait < 0) fail(`premise: Swiftly's next poll was due at ${last + cadenceS} s and has not started by ${nowS()} s`);
  await stepS(wait);
}
/** Swiftly's call meter as the app keeps it: the published count and the kv-store quota items, together. */
const swiftlyMeter = (): string => show({ published: state().callsThisMonth.swiftly, kv: [...kvMap()].filter(([k]) => k.startsWith('quota.swiftly.')) });
const CELL: Net = { type: 'CELLULAR', isConnected: true, isInternetReachable: true };
const WIFI: Net = { type: 'WIFI', isConnected: true, isInternetReachable: true };
// ---- Data & Settings ----
const hostNodes = (tree: any): any[] => {
  const out: any[] = [];
  const stack = [tree.root];
  for (let g = 0; stack.length > 0 && g < 200000; g += 1) {
    const n = stack.pop();
    if (typeof n === 'string') continue;
    if (typeof n.type === 'string') out.push(n);
    for (const c of [...(n.children ?? [])].reverse()) stack.push(c);
  }
  return out;
};
const textOf = (node: any): string => {
  let s = '';
  const stack: any[] = [node];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const n = stack.pop();
    if (typeof n === 'string' || typeof n === 'number') { s += String(n); continue; }
    for (const c of [...(n.children ?? [])].reverse()) stack.push(c);
  }
  return s;
};
const rowText = (tree: any, testID: string): string => {
  const hosts = hostNodes(tree).filter((n) => n.props.testID === testID);
  if (hosts.length !== 1) fail(`want one '${testID}' host, found ${hosts.length}`);
  return textOf(hosts[0]);
};
const LABEL = 'Use Swiftly only on Wi-Fi';
const theSwitch = (tree: any): any => {
  const found = tree.root.findAll((n: any) => n.props.testID === 'swiftly-wifi-only' && typeof n.props.onValueChange === 'function');
  if (found.length === 0) fail("Data & Settings renders no Switch with testID 'swiftly-wifi-only' (a host with onValueChange)");
  return found[0];
};
async function toggle(tree: any, value: boolean): Promise<void> {
  await act(async () => { theSwitch(tree).props.onValueChange(value); });
  await flush();
  await stepS(1);
}
TSX
  fi
  cat >> "$dir/wifi.oracle.test.tsx" <<'TSX'
const CASES: Record<string, () => Promise<void>> = {
  network_gate: async () => {
    const { isOnWifi, swiftlyAllowed } = load('src/domain/live/network-gate', ['isOnWifi', 'swiftlyAllowed']);
    const table: [unknown, boolean][] = [
      [{ type: 'WIFI', isConnected: true }, true], [{ type: 'ETHERNET', isConnected: true }, true],
      [{ type: 'CELLULAR', isConnected: true }, false], [{ type: 'NONE', isConnected: false }, false], [{ type: 'UNKNOWN', isConnected: false }, false],
      [{ type: 'VPN', isConnected: true }, false], [{ type: 'OTHER' }, false], [{ type: 'BLUETOOTH' }, false], [{ type: 'WIMAX' }, false],
      [{}, false], [{ type: undefined }, false], [null, false],
    ];
    for (const [s, want] of table) if (isOnWifi(s) !== want) fail(`isOnWifi(${show(s) ?? 'undefined'}) must be ${want} (on Wi-Fi = type WIFI or ETHERNET; anything else and no reading are not), got ${show(isOnWifi(s))}`);
    const combos: [boolean, boolean, boolean][] = [[false, false, true], [false, true, true], [true, false, false], [true, true, true]];
    for (const [wifiOnly, onWifi, want] of combos) if (swiftlyAllowed({ wifiOnly, onWifi }) !== want) fail(`swiftlyAllowed(${show({ wifiOnly, onWifi })}) must be ${want} (= !wifiOnly || onWifi), got ${show(swiftlyAllowed({ wifiOnly, onWifi }))}`);
  },
  setting: async () => {
    const s = setting();
    if (s.DEFAULT_SWIFTLY_WIFI_ONLY !== true) fail(`DEFAULT_SWIFTLY_WIFI_ONLY is ${show(s.DEFAULT_SWIFTLY_WIFI_ONLY)}: the arbiter's default is ON (true)`);
    if (s.readSwiftlyWifiOnly(memStore()) !== true) fail('an empty store reads true (default ON)');
    for (const junk of ['', 'garbage', '{"wifiOnly":', 'yes please', '[]', '2']) {
      const st = memStore(); st.map.set(ITEM, junk);
      if (s.readSwiftlyWifiOnly(st) !== true) fail(`an unreadable item ${show(junk)} reads true (default ON), got ${show(s.readSwiftlyWifiOnly(st))}`);
    }
    const st = memStore();
    for (const value of [false, true, false]) {
      const saved = s.saveSwiftlyWifiOnly(value, st);
      if (!saved.ok || saved.value !== value) fail(`saveSwiftlyWifiOnly(${value}) must return ok(${value}), got ${show(saved)}`);
      if (show([...st.map.keys()]) !== show([ITEM])) fail(`the setting is ONE kv item named ${show(ITEM)}; the store holds ${show([...st.map.keys()])}`);
      if (s.readSwiftlyWifiOnly(st) !== value) fail(`after saving ${value} the setting reads ${show(s.readSwiftlyWifiOnly(st))}`);
    }
    kvMap().clear();
    if (s.readSwiftlyWifiOnly() !== true) fail('readSwiftlyWifiOnly() on the empty app kv-store reads true');
    const saved = s.saveSwiftlyWifiOnly(false);
    if (!saved.ok || s.readSwiftlyWifiOnly() !== false) fail(`saveSwiftlyWifiOnly(false) / readSwiftlyWifiOnly() default to expo-sqlite/kv-store: got ${show(saved)}, then ${show(s.readSwiftlyWifiOnly())}`);
    if (show([...kvMap().keys()]) !== show([ITEM])) fail(`the app kv-store holds ${show([...kvMap().keys()])}: want exactly [${show(ITEM)}]`);
  },
TSX
  if [ "$kind" = live ]; then cat >> "$dir/wifi.oracle.test.tsx" <<'TSX'
  chain_cellular: async () => {
    await mount(CELL);
    await nextGoesTo('transitland', 0, 5, 'ON (the default) + CELLULAR, from mount');
    // Past REPROBE_AFTER_S (300 s), checked every second: a gated Swiftly is never benched, so never re-probed.
    for (let s = 1; s <= 330; s += 1) {
      await stepS(1);
      noneTo('swiftly', 0, `ON + CELLULAR, ${s} s after the first fetches`);
      serving('transitland', `ON + CELLULAR, ${s} s after the first fetches`);
    }
    const tlCadenceS = load('src/domain/live/constants', ['PROVIDER_CONFIG']).PROVIDER_CONFIG.transitland.cadenceS;
    const tlVehicles = requests().filter((r) => r.provider === 'transitland' && r.capability === 'vehicles').length;
    if (tlVehicles < Math.floor(330 / tlCadenceS)) fail(`ON + CELLULAR: Transitland must keep polling vehicles at its cadence (${tlCadenceS} s): ${tlVehicles} poll(s) in 330+ s, want >= ${Math.floor(330 / tlCadenceS)}`);
    serving('transitland', 'ON + CELLULAR');
    if (state().callsThisMonth.swiftly !== 0) fail(`a gated Swiftly records no call: the meter reads ${state().callsThisMonth.swiftly}`);
    const meter = [...kvMap().keys()].filter((k) => k.startsWith('quota.swiftly.'));
    if (meter.length) fail(`a gated Swiftly records no call: the kv-store holds ${show(meter)}`);
  },
  chain_wifi: async () => {
    await mount(WIFI);
    // The oracle answers getNetworkStateAsync at once, but a fetch that starts at the very instant the first reading lands
    // may still precede it (no reading yet = not Wi-Fi). Every fetch that starts AFTER that instant goes to Swiftly, both
    // capabilities within 5 s of mount: a gate read late (cached, throttled) before the reading still sends them to Transitland.
    const landed = await untilS(5, () => mockNet.landedAtS !== null);
    if (landed === null) fail(`ON + WIFI: the first reading never reached the app within 5 s of mount (getNetworkStateAsync asked ${mockNet.gets} time(s))`);
    const at = mockNet.landedAtS as number;
    const after = mockHttp.requests.findIndex((r) => r.at > at);
    await nextGoesTo('swiftly', after === -1 ? mark() : after, 5 - (landed as number), 'ON + WIFI, from mount (every fetch after the first reading landed)');
    const from = mark();
    await stepS(65);
    noneTo('transitland', from, 'ON + WIFI');
    serving('swiftly', 'ON + WIFI');
  },
  chain_off: async () => {
    await mount(CELL, { wifiOnly: false });
    await nextGoesTo('swiftly', 0, 5, 'OFF + CELLULAR, from mount');
    const from = mark();
    await stepS(65);
    noneTo('transitland', from, 'OFF + CELLULAR (today\'s behaviour)');
    serving('swiftly', 'OFF + CELLULAR');
  },
  chain_flip: async () => {
    await mount(CELL);
    await stepS(65);
    noneTo('swiftly', 0, 'CELLULAR');
    const toWifi = mark();
    await emit('WIFI');
    await nextGoesTo('swiftly', toWifi, 30, 'CELLULAR -> WIFI');
    await stepS(35);
    noneTo('transitland', toWifi, 'on WIFI after the switch');
    await toEveOfSwiftlyPoll();
    const toCell = mark();
    const meterAtCell = swiftlyMeter(); // every Swiftly request so far has settled (the fake server answers at once): from here on it holds
    await emit('CELLULAR');
    await nextGoesTo('transitland', toCell, 60, 'WIFI -> CELLULAR');
    await stepS(65);
    noneTo('swiftly', toCell, 'back on CELLULAR (no NEW Swiftly request starts while gated)');
    serving('transitland', 'back on CELLULAR');
    if (swiftlyMeter() !== meterAtCell) fail(`a gated Swiftly records no call after it served: its meter went from ${meterAtCell} to ${swiftlyMeter()}`);
    // ETHERNET counts as Wi-Fi in the live path too; every other reading the LISTENER reports is not Wi-Fi, including the
    // iOS isConnected:false types UNKNOWN and NONE, and an event with NO type (connected, type unknown): it is the latest
    // reading, of "any other value", so it replaces the Wi-Fi reading before it (an unknown network never spends on Swiftly).
    let from = 'CELLULAR';
    for (const [on, offType] of [['ETHERNET', 'UNKNOWN'], ['WIFI', 'NONE'], ['WIFI', null]] as [string, string | null][]) {
      const off = offType ?? 'an event with no type';
      const again = mark();
      await emit(on);
      await nextGoesTo('swiftly', again, 30, `${from} -> ${on} (on Wi-Fi)`);
      await toEveOfSwiftlyPoll();
      const toOff = mark();
      const meterAtOff = swiftlyMeter();
      await emit(offType);
      await nextGoesTo('transitland', toOff, 60, `${on} -> ${off} (not Wi-Fi)`);
      await stepS(35);
      noneTo('swiftly', toOff, `on ${off} (not Wi-Fi: no NEW Swiftly request)`);
      serving('transitland', `on ${off}`);
      if (swiftlyMeter() !== meterAtOff) fail(`on ${off} a gated Swiftly records no call: its meter went from ${meterAtOff} to ${swiftlyMeter()}`);
      from = off;
    }
  },
  chain_no_failures: async () => {
    await mount(CELL);
    await stepS(200); // long enough for 3 would-be Swiftly failures (0, 15, 45 s) and a 300 s bench
    noneTo('swiftly', 0, '200 s on CELLULAR');
    serving('transitland', '200 s on CELLULAR');
    const back = mark();
    await emit('WIFI');
    await nextGoesTo('swiftly', back, 30, 'back on WIFI after 200 gated seconds (a gated Swiftly accrued no failures, so no 300 s re-probe wait)');
    await stepS(2);
    serving('swiftly', 'back on WIFI');
    if (state().status.vehicles.consecutiveFailures !== 0 || state().status.predictions.consecutiveFailures !== 0) fail(`back on WIFI Swiftly has no failures on record, got ${show(state().status)}`);
  },
  chain_no_reading: async () => {
    await mount('never');
    await nextGoesTo('transitland', 0, 5, 'no network reading yet (getNetworkStateAsync pending)');
    await stepS(65);
    noneTo('swiftly', 0, 'no network reading yet');
    if (mockNet.gets < 1) fail('the watch never asked getNetworkStateAsync for the first reading');
    const later = mark();
    await emit('WIFI');
    await nextGoesTo('swiftly', later, 30, 'the first reading (WIFI) arrives by the listener');
  },
  wiring_toggle: async () => {
    const tree = await mount(CELL, { screen: true });
    await stepS(65);
    noneTo('swiftly', 0, 'CELLULAR, the switch ON');
    const off = mark();
    await toggle(tree, false);
    if (setting().readSwiftlyWifiOnly() !== false) fail('turning the switch off saves the setting (readSwiftlyWifiOnly() reads false)');
    await nextGoesTo('swiftly', off, 30, 'the switch turned OFF on CELLULAR');
    await toEveOfSwiftlyPoll();
    const on = mark();
    await toggle(tree, true);
    if (setting().readSwiftlyWifiOnly() !== true) fail('turning the switch on saves the setting (readSwiftlyWifiOnly() reads true)');
    await nextGoesTo('transitland', on, 60, 'the switch turned back ON on CELLULAR');
    await stepS(65);
    noneTo('swiftly', on, 'the switch back ON on CELLULAR');
  },
  wiring_watch: async () => {
    const tree = await mount(CELL, { screen: true });
    await stepS(65);
    if (mockNet.gets !== 1) fail(`getNetworkStateAsync is called ONCE on mount (one app-wide watch), got ${mockNet.gets} call(s) after 65 s`);
    if (mockNet.subs.length !== 1) fail(`addNetworkStateListener is called ONCE (one app-wide watch), got ${mockNet.subs.length}`);
    if (mockNet.subs[0].remove.mock.calls.length !== 0) fail('the network listener is removed only on unmount');
    await act(async () => { tree.unmount(); });
    trees.splice(trees.indexOf(tree), 1);
    await flush();
    if (mockNet.subs[0].remove.mock.calls.length !== 1) fail(`unmounting the live provider removes the network listener once, got ${mockNet.subs[0].remove.mock.calls.length} remove() call(s)`);
  },
  screen_switch: async () => {
    const tree = await mount(CELL, { screen: true });
    const sw = theSwitch(tree);
    if (sw.props.value !== true) fail(`the switch shows readSwiftlyWifiOnly(): ON by default, got value ${show(sw.props.value)}`);
    if (sw.props.accessibilityLabel !== LABEL) fail(`the switch's VoiceOver label is exactly ${show(LABEL)}, got ${show(sw.props.accessibilityLabel)}`);
    const hosts = hostNodes(tree);
    const at = (pred: (n: any) => boolean) => hosts.findIndex(pred);
    const swiftlyHead = at((n) => n.props.accessibilityRole === 'header' && textOf(n) === 'Swiftly');
    const tlHead = at((n) => n.props.accessibilityRole === 'header' && textOf(n) === 'Transitland');
    const swHost = at((n) => n.props.testID === 'swiftly-wifi-only');
    const label = at((n) => n.type === 'Text' && textOf(n) === LABEL);
    if (swiftlyHead < 0 || tlHead < 0) fail('premise: the Swiftly and Transitland headings render');
    if (!(swiftlyHead < swHost && swHost < tlHead)) fail(`the switch sits in the Swiftly card (after the Swiftly heading, before Transitland's): heading ${swiftlyHead}, switch ${swHost}, Transitland ${tlHead}`);
    if (!(swiftlyHead < label && label < tlHead)) fail(`a visible label reading exactly ${show(LABEL)} sits in the Swiftly card, found at ${label}`);
    await act(async () => { tree.unmount(); });
    trees.splice(trees.indexOf(tree), 1);
    const offTree = await mount(CELL, { screen: true, wifiOnly: false });
    if (theSwitch(offTree).props.value !== false) fail(`with the setting saved off, the switch shows off, got ${show(theSwitch(offTree).props.value)}`);
  },
  screen_toggle: async () => {
    const tree = await mount(CELL, { screen: true });
    if (kvMap().has(ITEM)) fail('premise: the default is not written until the rider toggles');
    await toggle(tree, false);
    const items = [...kvMap().keys()].filter((k) => k.startsWith('settings.'));
    if (show(items) !== show([ITEM]) || setting().readSwiftlyWifiOnly() !== false) fail(`toggling off writes the one kv item ${show(ITEM)} (read back false); settings items ${show(items)}, read ${show(setting().readSwiftlyWifiOnly())}`);
    if (theSwitch(tree).props.value !== false) fail('the switch shows the saved value (off)');
    await toggle(tree, true);
    if (setting().readSwiftlyWifiOnly() !== true || theSwitch(tree).props.value !== true) fail('toggling back on writes true and the switch shows it');
  },
  screen_paused_row: async () => {
    const tree = await mount(WIFI, { screen: true });
    await stepS(40);
    if (!rowText(tree, 'provider-status-swiftly').startsWith('Live')) fail(`premise: on WIFI Swiftly serves and reads Live, got ${show(rowText(tree, 'provider-status-swiftly'))}`);
    await emit('CELLULAR');
    await stepS(65);
    const row = rowText(tree, 'provider-status-swiftly');
    if (row !== 'Paused · not on Wi-Fi') fail(`the gated Swiftly row reads exactly "Paused · not on Wi-Fi", got ${show(row)}`);
    if (!rowText(tree, 'key-status-swiftly').startsWith('Saved ')) fail(`a gated Swiftly keeps its saved key (the key row), got ${show(rowText(tree, 'key-status-swiftly'))}`);
  },
  screen_transitland_row: async () => {
    const tree = await mount(WIFI, { screen: true });
    await stepS(40);
    if (!rowText(tree, 'provider-status-transitland').startsWith('Standby · Swiftly serves')) fail(`premise: on WIFI Transitland stands by, got ${show(rowText(tree, 'provider-status-transitland'))}`);
    await emit('CELLULAR');
    await stepS(65);
    const row = rowText(tree, 'provider-status-transitland');
    if (!/^Live · updated (just now|\d+ (s|min) ago) · \d+(\.\d)? (B|KB|MB) per poll$/.test(row)) fail(`while it serves for a gated Swiftly, Transitland shows its own live health ("Live · updated N s ago · X per poll", or "updated just now" at a 0 s age), got ${show(row)}`);
  },
  screen_footer: async () => {
    const tree = await mount(CELL, { screen: true });
    const want = process.env.MFIX10_FOOTER ?? fail('no footer');
    const texts = hostNodes(tree).filter((n) => n.type === 'Text').map(textOf);
    if (!texts.includes(want)) fail(`the Live data footer reads exactly ${show(want)}; footers found: ${show(texts.filter((t) => t.startsWith('Keys stay')))}`);
  },
TSX
  fi
  cat >> "$dir/wifi.oracle.test.tsx" <<'TSX'
};
it('ratchet oracle', async () => {
  const run = CASES[CASE];
  if (run === undefined) fail('unknown oracle case');
  await run();
  expect(CASE.length).toBeGreaterThan(0);
}, 240_000); // a live case steps up to ~600 fake seconds (chain_flip), 1 s per act, over the real schedule DB
TSX
  out=$(MFIX10_CASE="$which" MFIX10_FOOTER="$MFIX10_FOOTER" local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.tsx' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 -o "ratchet-oracle:.*"; else echo "$out" | tail -25; fi
    echo "ratchet: mfix10 oracle '$which' failed"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the mfix10 oracle '$which' did not run"; return 1; }
  echo "ratchet: mfix10 oracle '$which' holds on the shipped app"
}


# no_live_imports_ui — the live runtime, the domain and the data layer never import UI code (arbiter ruling 2026-10-02:
# the Wi-Fi-only setting lives in src/live beside keys.ts; the Data & Settings screen imports it, never the reverse).
no_live_imports_ui() {
  local hits
  hits=$(grep -rlE "from ['\"](\.\./)+ui/|from ['\"]@/ui/|require\(['\"](\.\./)+ui/" src/live src/domain src/data --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '/__tests__/' || true)
  if [ -n "$hits" ]; then
    echo "ratchet: non-test files under src/live, src/domain or src/data import UI code: $(printf '%s ' $hits)— the setting belongs in src/live, beside keys.ts"
    return 1
  fi
  echo "ratchet: no live, domain or data file imports UI code"
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix10_swiftly_wifi_only gate failed at verify script line $LINENO"' ERR

# --- (1) isOnWifi / swiftlyAllowed (src/domain/live/network-gate.ts) --------------------------------------------------
# 1a. Oracle: isOnWifi is true for WIFI and ETHERNET only — CELLULAR, NONE, UNKNOWN, VPN, OTHER, BLUETOOTH, WIMAX, {},
#     { type: undefined } and null are false; swiftlyAllowed is !wifiOnly || onWifi over all four combinations.
mfix10_oracle network_gate
# 1b. One passing test each (src/domain/live/__tests__/network-gate.test.ts).
jest_cases "$MFIX10_GATE_TEST" 'only wifi and ethernet count as on wi-fi' 'swiftly is allowed unless wi-fi only is on and the phone is off wi-fi'

# --- (2) The setting (src/live/swiftly-wifi.ts) ----------------------------------------------------------------
# 2a. Oracle: DEFAULT_SWIFTLY_WIFI_ONLY === true; an empty store and garbage items ('', 'garbage', '{"wifiOnly":',
#     'yes please', '[]', '2') read true; false / true / false round-trip as ok(value) in ONE item named
#     'settings.swiftly-wifi-only'; with no store argument both functions use expo-sqlite/kv-store.
mfix10_oracle setting
# 2b. One passing test each (src/live/__tests__/swiftly-wifi.test.ts).
jest_cases "$MFIX10_SETTING_TEST" 'the wi-fi only setting is on when its item is empty or unreadable' 'the wi-fi only setting round-trips through one kv item'

# --- (3) The chain under the gate (both keys saved; the real LiveDataProvider over fakes) --------------------------------
# 3a. Oracle: ON (the default) + CELLULAR: from mount, vehicles AND predictions go to Transitland (first fetch within
#     5 s); at EVERY second for 330 s (past the 300 s re-probe: a gated Swiftly is never benched) Swiftly has seen ZERO
#     requests and the chain reports Transitland serving both, nothing failing; Transitland polled vehicles at its
#     cadence (>= 330 / 60 polls); Swiftly's call meter (callsThisMonth and its kv-store quota item) never moved.
mfix10_oracle chain_cellular
# 3b. Oracle: ON + WIFI: the first reading (getNetworkStateAsync) lands within 5 s of mount and every fetch that starts
#     after the instant it lands goes to Swiftly, both capabilities within 5 s of mount (a fetch AT that instant may still
#     precede the reading); Transitland then sees no request for 65 s.
mfix10_oracle chain_wifi
# 3c. Oracle: OFF (saved) + CELLULAR: Swiftly serves both capabilities, as today; Transitland sees no request.
mfix10_oracle chain_off
# 3d. Oracle: CELLULAR -> WIFI -> CELLULAR, then -> ETHERNET -> UNKNOWN, -> WIFI -> NONE and -> WIFI -> an event with no
#     type (connected, type unknown: "any other value", the latest reading) (listener events): each
#     switch sends the NEXT fetch of both capabilities to the allowed provider (Swiftly within 30 s, Transitland within
#     60 s: one cadence); each switch off Wi-Fi comes ONE second before Swiftly's next poll is due, and after it Swiftly
#     sees no new request and its call meter (published count + kv quota item) holds.
mfix10_oracle chain_flip
# 3e. Oracle: 200 s on CELLULAR, then WIFI: Swiftly serves both capabilities within 30 s (a gated Swiftly accrued no
#     failure, so no 300 s re-probe wait) with no failures on record.
mfix10_oracle chain_no_failures
# 3f. Oracle: expo-network's first reading never arrives: Transitland serves, Swiftly sees no request for 65 s; a WIFI
#     event on the listener then hands both capabilities to Swiftly within 30 s.
mfix10_oracle chain_no_reading
# 3g. One passing test each (src/live/__tests__/swiftly-wifi-chain.test.ts: fake providers, a Swiftly call spy, fake
#     timers stepped by <= 1 s).
jest_cases "$MFIX10_CHAIN_TEST" 'wi-fi only on cellular serves vehicles and predictions from transitland and swiftly sees zero requests' 'wi-fi only on wi-fi serves from swiftly' 'wi-fi only off on cellular serves from swiftly' 'cellular to wi-fi to cellular switches the provider within one cadence each time' 'gated time adds no swiftly failures so swiftly serves at the next tick back on wi-fi' 'no network reading yet counts as not on wi-fi'
stepped_test "$MFIX10_CHAIN_TEST" spy

# --- (4) The live runtime wiring --------------------------------------------------------------------------------------
# 4a. Oracle: the REAL Data & Settings switch, on CELLULAR: turning it off saves false and sends the next fetch of both
#     capabilities to Swiftly within 30 s; turning it back on (ONE second before Swiftly's next poll is due, so a setting
#     read cached or late lets that poll through) saves true, the next fetches go to Transitland within 60 s, and
#     Swiftly sees no new request.
mfix10_oracle wiring_toggle
# 4b. Oracle: one watch: getNetworkStateAsync called exactly once and addNetworkStateListener exactly once over 65 s
#     with the live provider AND Data & Settings mounted; unmounting removes that subscription exactly once.
mfix10_oracle wiring_watch
# 4c. One passing test each (src/live/__tests__/network-watch.test.tsx: the real LiveDataProvider, the labelled
#     expo-network mock, fake timers stepped by <= 1 s).
jest_cases "$MFIX10_WATCH_TEST" 'a network change sends the next fetch of the real live provider to the allowed provider' 'a toggle saved through the setting sends the next fetch to the allowed provider' 'the network watch is read once on mount and removed on unmount'
stepped_test "$MFIX10_WATCH_TEST"

# --- (5) Data & Settings ----------------------------------------------------------------------------------------------
# 5a. Oracle: one Switch (testID 'swiftly-wifi-only') in the Swiftly card — after the Swiftly heading, before
#     Transitland's — with accessibilityLabel and a visible label exactly "Use Swiftly only on Wi-Fi"; ON on a fresh
#     store, OFF when the setting is saved off.
mfix10_oracle screen_switch
# 5b. Oracle: toggling writes the ONE item 'settings.swiftly-wifi-only' (false, then true) and the switch shows it.
mfix10_oracle screen_toggle
# 5c. Oracle: Swiftly served on WIFI (row "Live …"), then CELLULAR: its row reads exactly "Paused · not on Wi-Fi" and its
#     key row still reads "Saved ••••…".
mfix10_oracle screen_paused_row
# 5d. Oracle: Transitland stood by on WIFI ("Standby · Swiftly serves"); serving for the gated Swiftly it reads its own
#     health, "Live · updated N s ago · X per poll" (or "updated just now": formatAge's wording for a 0 s age).
mfix10_oracle screen_transitland_row
# 5e. Oracle: the Live data footer reads exactly MFIX10_FOOTER.
mfix10_oracle screen_footer
# 5f. One passing test each (src/ui/settings/__tests__/swiftly-wifi-setting.test.tsx).
jest_cases "$MFIX10_SCREEN_TEST" 'the wi-fi only switch renders under swiftly and is on by default' 'toggling the wi-fi only switch writes its kv item' 'a gated swiftly row reads paused not on wi-fi' 'transitland shows its own live health while it serves for a gated swiftly' 'the live data footer states the wi-fi rule'

# --- (6) Grep gates ---------------------------------------------------------------------------------------------------
# 6a. One network-watch site in src/ (outside tests), under src/live/, calling getNetworkStateAsync + addNetworkStateListener;
#     no other non-test file imports expo-network for a value (an alias or namespace import included; `import type` is
#     fine), every require() / import() names a constant module (folded as Metro folds one), and no non-test file names
#     the ExpoNetwork native module ('ExpoNetwork' / 'onNetworkStateChanged' as an identifier, property, string or
#     constant concatenation; comments never count: TypeScript AST).
one_watch_site
# 6b. The domain file imports no expo, react, react-native or '@/' module, and takes the strings 'WIFI' / 'ETHERNET'.
domain_pure
# 6c. expo-network in package.json dependencies at ~57.x.y, locked and installed at 57.x; `expo install --check` clean (offline).
expo_network_installed
# 6d. The tests mock expo-network, every such mock labelled '// test-time mock of native module' on the line DIRECTLY
#     above the jest.mock call; the card's five test files mock only native packages, each labelled (mfix6's helper,
#     over those files).
expo_network_mock_labelled
card_mocks_native_only

# --- (7) The bundle ---------------------------------------------------------------------------------------------------
# 7. (guarded) Metro bundles the app for iOS on a private cache (TMPDIR=$PWD/.cache/metro-tmp-mfix10), and the
#    --no-bytecode bundle carries "Use Swiftly only on Wi-Fi".
card_export_carries 'Use Swiftly only on Wi-Fi'

# --- (8) Earlier cards stay as they were, then the repo-wide gate -----------------------------------------------------
# 8a. m4a's chain cases and m8b's health rows stay green; mfix6's real app (which now mounts the network watch) still
#     opens exactly one location watch.
after_card jest_nonempty src/domain/live/__tests__/chain.test.ts
after_card jest_nonempty src/ui/settings/__tests__/DataSettingsView.health.test.tsx
after_card jest_nonempty src/ui/location/__tests__/one-watch.test.tsx 'the real app opens exactly one location watch$'
# 6f. Layering (arbiter ruling): no live, domain or data file imports UI code.
after_card no_live_imports_ui
# 8b. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every test), node:test — all green.
card_full_gate

echo "mfix10_swiftly_wifi_only: all 33 gate lines green"
