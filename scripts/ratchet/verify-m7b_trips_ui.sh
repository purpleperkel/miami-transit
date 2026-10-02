#!/usr/bin/env bash
# m7b_trips_ui — trips UI (plan M7.5–M7.9): reminder service + leave-now cue, directions route, home context + Now strip, Trips tab, add-trip flow + save trip.
# Re-sequenced 2026-10-01 (lands LAST: after m7a, m7c, m10b, m6b). R5: the Apple Maps handoff module + its tests moved to m6b. R2: NowAccessory
# (file, usePlacement, mount) moved to m7c; this card extends it. R4: m6b's save-trip gate moved here. R6: the saved-trip -> /plan link moved here from m10b.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Under `set -e`, a failure on the LEFT of `&&` does not stop the script, so every gate below is ONE
# simple command (a lib.sh helper, a card helper, or a for-loop of one), and every compound check lives
# inside a helper that returns 1 with a named reason. No gate reads a variable or a file another gate
# created: the constants below are fixed text, and each jest/node:test/export gate runs its own tools.

# Every jest case this card pins (case-insensitive substrings of a test's full name = describe titles +
# test title). A pinned case counts only through a PASSED test whose name carries NO OTHER name from this
# list, so one catch-all test cannot clear several cases or several gates.
JEST_CASES=(
  "shouldCue fires once per departure" "shouldCue fires again for a new departure"
  "schedules added reminders" "cancels removed reminders"
  "120 m" "map gesture" "01:30" "14 char"
  "sorted by leaveAt" "empty state" "never says transfer"
)

# The real schedule DB, and a probe that logs every DB file a node:test process queries (copied from the
# m3a card, where it is proven: imported BEFORE tsx so Node's default loader runs it untouched).
REAL_DB="$(pwd -P)/assets/db/schedule.db"
DB_PROBE='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?String(db.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","createTagStore"]){const f=D.prototype[k];D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}'

# --- card helpers (lib.sh has no multi-case pin, regex need/absence, pure-module load, mock audit or
#     route-in-bundle check; everything else comes from lib.sh) -----------------------------------------

# need_all <file> <ERE>... — the file exists and matches EVERY extended regex.
need_all() {
  local file="$1" re; shift
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  for re in "$@"; do
    grep -qE -- "$re" "$file" || { echo "ratchet: expected /$re/ in $file"; return 1; }
  done
}

# need_re <ERE> <dir>... — every dir exists and >= 1 NON-TEST .ts/.tsx line under them matches.
need_re() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing $p"; return 1; }; done
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ -- "$re" "$@" \
    || { echo "ratchet: expected /$re/ in non-test source under $*"; return 1; }
}

# absent_re <ERE> <file> — the file exists and NO line matches. (A function, not `! grep`: bash's
# `set -e` ignores a failing `!`-negated command.) grep exit 2 is a real error, never a pass.
absent_re() {
  local re="$1" file="$2" hits rc=0
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  hits=$(grep -nE -- "$re" "$file") || rc=$?
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) reading $file"; return 1; }
  [ -z "$hits" ] || { echo "$hits"; echo "ratchet: forbidden /$re/ in $file"; return 1; }
}

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
  report="$PWD/.cache/ratchet/m7b_trips_ui.$(printf '%s' "$path" | tr '/' '_').json"
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

# nodetest_real_cases <file> <case>... — ONE node:test run (tsx) of the file: green with no
# fail/skip/todo/cancel (lib's _nodetest_clean), every <case> names its own passing REAL leaf (suites,
# parents of t.test() and Node 26's empty-file wrapper do not count — lib's leaf rules), and the run
# queried assets/db/schedule.db in place.
nodetest_real_cases() {
  local file="$1" out names; shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  out=$(node --import "$DB_PROBE" --import tsx --test --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  names=$(echo "$out" | awk -v fp="$file" '
    BEGIN { f1 = fp; sub(/^\.\//, "", f1); n2 = split(fp, parts, "/"); f2 = parts[n2] }
    { match($0, /^ */); d = RLENGTH; line = substr($0, d + 1) }
    line ~ /^# Subtest: / {
      nm = line; sub(/^# Subtest: /, "", nm); stack[d] = nm; kids[d] = 0
      if (d >= 4) kids[d - 4] = 1
      next }
    line ~ /^ok [0-9]+ - / { okd = d; okline = line; pending = 1; next }
    line ~ /^not ok / { pending = 0; next }
    pending && line ~ /^type: / {
      pending = 0
      if (line !~ /test/ || okline ~ / # (SKIP|TODO)/ || kids[okd]) next
      leaf = okline; sub(/^ok [0-9]+ - /, "", leaf)
      if (okd == 0 && (leaf == fp || leaf == f1 || leaf == f2 || leaf ~ ("/" f1 "$"))) next
      full = ""
      for (i = 0; i <= okd; i += 4) full = full " " stack[i]
      print "passed\t" substr(full, 2)
    }')
  printf '%s\n' "$names" | CASE_UNIVERSE="" named_cases "$file (node:test)" "$@" || return 1
  grep -qF "ratchet-db-open: $REAL_DB" <<<"$out" \
    || { grep -F "ratchet-db-open:" <<<"$out" || echo "(no DB was queried)"; echo "ratchet: $file never queried $REAL_DB — the acceptance must run on the real DB, in place"; return 1; }
}

# native_mocks_labelled <test-dir>... — every jest.mock/doMock in these test dirs names a module by
# literal, carries the '// test-time mock of native module' label on its line or the line above, and
# mocks a NATIVE module (expo*, @expo/*, react-native*, @react-native*). Mocking our own code is a stub.
native_mocks_labelled() {
  local d
  for d in "$@"; do [ -d "$d" ] || { echo "ratchet: missing $d — the milestone's tests do not exist yet"; return 1; }; done
  node -e '
const fs = require("node:fs"), path = require("node:path");
const LABEL = "test-time mock of native module";
const NATIVE = /^(expo([-/][\w./-]*)?|@expo\/[\w./-]+|react-native([-/][\w./-]*)?|@react-native(-[\w-]+)?\/[\w./-]+)$/;
const files = [], todo = process.argv.slice(1), problems = [];
for (let guard = 0; todo.length > 0 && guard < 10000; guard++) {
  const p = todo.pop();
  if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
  else if (/\.(ts|tsx|js|jsx)$/.test(p)) files.push(p);
}
let mocks = 0;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8"), lines = text.split("\n");
  const calls = (text.match(/jest\.(mock|doMock)\(/g) || []).length;
  const re = /jest\.(mock|doMock)\(\s*([\x27"`])([^\x27"`]+)\2/g;
  let m, literal = 0;
  while ((m = re.exec(text)) !== null) {
    literal++; mocks++;
    const n = text.slice(0, m.index).split("\n").length - 1;
    const near = `${lines[n] ?? ""}\n${lines[n - 1] ?? ""}`;
    if (!near.includes(LABEL)) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") lacks the "// ${LABEL}" label`);
    if (!NATIVE.test(m[3])) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") mocks a non-native module (a stub of our own code)`);
  }
  if (literal !== calls) problems.push(`${f}: ${calls - literal} jest.mock call(s) without a literal module name`);
}
if (problems.length > 0) { console.log(problems.join("\n")); console.log("ratchet: test-time mocks must be labelled native modules only"); process.exit(1); }
console.log(`ratchet: ${files.length} test files, ${mocks} labelled native-module mocks`);
' "$@" || return 1
}

# _pin_anchored / jest_pin — copied verbatim from verify-m6b_sheets_stations.sh with its save-trip gate (R4).
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

# closure_links <entry> <href> — m10b's `_m10b_graph links` (the TypeScript-AST value-import closure of
# <entry>, tests and the href's own route file excluded, must hold a quoted href to <href> in CODE: comments
# and JSX display text are blanked first), reused rather than duplicated: m10b lands before this card, so its
# script is in the tree. It runs in its own bash, sourced by its repo-relative path from the repo root (this
# script has cd'd there), so m10b's `dirname "$0"` resolves wherever this script was started from.
closure_links() {
  need_file "$1" || return 1
  need_file scripts/ratchet/verify-m10b_routes_ui.sh || return 1
  bash -c 'source "$0" || exit 1; _m10b_graph links "$1" "$2"' scripts/ratchet/verify-m10b_routes_ui.sh "$1" "$2" || return 1
}

# footer_opens_add_trip — R4: m6b's StationSheetFooter really opens the add-trip flow. M7.9's flow is
# src/app/trip/new/{_layout,from,to,start,confirm}.tsx with NO index route, so a bare '/trip/new' link lands
# on no screen. The footer's non-test closure must link a step route this card creates — '/trip/new/to'
# (this station as the origin) or '/trip/new/from' — or '/trip/new' only if src/app/trip/new/index.tsx exists.
footer_opens_add_trip() {
  local footer=src/ui/stations/StationSheetFooter.tsx href route out tried=''
  need_file "$footer" || return 1
  for href in /trip/new/to /trip/new/from /trip/new; do
    case "$href" in /trip/new) route=src/app/trip/new/index.tsx ;; *) route="src/app$href.tsx" ;; esac
    if [ ! -f "$route" ]; then tried="$tried; $href: no route file $route"; continue; fi
    if out=$(closure_links "$footer" "$href"); then echo "$out"; return 0; fi
    tried="$tried; $href: ${out##*$'\n'}"
  done
  echo "ratchet: $footer opens no add-trip route that exists${tried}"
  return 1
}

# full_gate_over_card — the repo-wide gate, run once this card's tests exist (the tree passing it today
# says nothing about m7b).
full_gate_over_card() {
  local p
  for p in src/ui/trips/__tests__ src/ui/now/__tests__ scripts/gtfs/__tests__/repo-reachable.test.ts; do
    [ -e "$p" ] || { echo "ratchet: missing $p — the repo-wide gate must run over this card's tests"; return 1; }
  done
  full_gate || return 1
}

# export_bundles_routes <route>... — guarded by this card's route files: Metro bundles the app for iOS
# (lib's ios_export, the plan's Hermes export), then a --no-bytecode export of the same app registers
# expo-router's require.context key "./<route>" as a whole quoted string for every route. The Hermes .hbc is
# never grepped (its string table packs strings back to back — see m5b). Both exports run on a Metro cache
# private to THIS tree (TMPDIR -> .cache/metro-tmp-m7b): on the shared cache a tree whose node_modules is a
# symlink reused the MAIN repo's cached require.context and bundled the main repo's src/app (m10b, proven
# 2026-10-01), and a private cache never writes into the shared one.
export_bundles_routes() {
  local dir=.cache/export-m7b-js metro_tmp="$PWD/.cache/metro-tmp-m7b" r out rc
  for r in "$@"; do need_file "src/app/$r" || return 1; done
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  for r in "$@"; do
    rc=0
    grep -rqF -- "\"./$r\"" "$dir/_expo/static/js/ios" || rc=$?
    [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) scanning $dir"; return 1; }
    [ "$rc" -eq 0 ] || { echo "ratchet: the iOS JS bundle registers no route \"./$r\" — Metro did not bundle this tree's src/app/$r"; return 1; }
  done
  echo "ratchet: the iOS JS bundle registers all $# routes of this card"
}

# Sourcing this file (to run one gate alone) stops here, before gate 1:
#   bash -c 'source "$0"; footer_opens_add_trip' scripts/ratchet/verify-m7b_trips_ui.sh
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m7b_trips_ui gate failed at verify script line $LINENO"' ERR

# --- M7.5 Notification service + leave-now cue ------------------------------------------------------
# 1. useLeaveNowCue.ts exports shouldCue and cues "Leave now" with one haptic (expo-haptics) plus a VoiceOver announcement (plan §4 UX)
need_all src/ui/trips/useLeaveNowCue.ts 'export (async )?(function|const) shouldCue([^A-Za-z0-9_$]|$)' "from ['\"]expo-haptics['\"]" 'announceForAccessibility'
# 2. A (M7.5): shouldCue fires once per departure, and fires again for a new departure (keyed per departure, not a global once-flag)
jest_cases src/ui/trips "shouldCue fires once per departure" "shouldCue fires again for a new departure"
# 3. notifications.ts applies M7.4's reminder plan through expo-notifications: schedules by identifier, cancels removed ids
need_all src/ui/trips/notifications.ts "from ['\"]expo-notifications['\"]" 'domain/trips/notification-plan' 'scheduleNotificationAsync' 'identifier' 'cancelScheduledNotificationAsync'
# 4. the service is behaviour-tested (expo-notifications as a labelled test-time mock): added reminders scheduled, removed ones cancelled
jest_cases src/ui/trips "schedules added reminders" "cancels removed reminders"
# 5. the notification service is wired: a non-test module under src/app or src/ui imports it
need_re "from ['\"][^'\"]*/notifications['\"]" src/app src/ui
# 6. the leave-now cue is wired: a non-test module under src/app or src/ui imports useLeaveNowCue
need_re "from ['\"][^'\"]*/useLeaveNowCue['\"]" src/app src/ui

# --- M7.6 Directions route (the handoff module + its gates moved to m6b, ruling R5) --------------------
# 7. src/app/directions.tsx builds the link with the domain module and hands Linking's openURL to it
need_all src/app/directions.tsx 'domain/handoff/apple-maps' 'openURL'
# 8. directions.tsx never awaits or .then()s openURL itself — every open goes through the tested handoff rule
absent_re 'await[[:space:]]+[A-Za-z_$.]*openURL[[:space:]]*\(|openURL\([^)]*\)[[:space:]]*\.then' src/app/directions.tsx

# --- M7.7 Home context + Now strip -------------------------------------------------------------------
# (NowAccessory.tsx, its usePlacement and its BottomAccessory mount are m7c's gates now — ruling R2.)
# 9. the Now strip modules exist where the plan puts them
for f in src/ui/now/homeContext.ts src/ui/now/nowStore.ts src/ui/now/NowStripContent.tsx; do need_file "$f"; done
# 10. homeContext.ts has the no-service state (plan: noService; m7a's rides kind is 'no-service') so the strip never claims a train at 01:30
need_all src/ui/now/homeContext.ts 'noService|no-service'
# 11. A (M7.7, plan V `npx jest src/ui/now --ci`): 120 m from a station -> station context + auto-present; after a map gesture -> no auto-present; 01:30 -> noService; inline text <= 14 chars (ruling R1)
jest_cases src/ui/now "120 m" "map gesture" "01:30" "14 char"
# 12. map gestures reach the Now store: a non-test module under src/app or src/ui/map imports ui/now/nowStore
need_re 'now/nowStore' src/app src/ui/map

# --- M7.8 Trips tab + TripCard + CountdownHero -------------------------------------------------------
# 13. the Trips tab renders TripCards (m5b's route + EmptyState gain the card list): a non-test module under the tab route or src/ui/trips imports TripCard
need_re "from ['\"][^'\"]*/TripCard['\"]" 'src/app/(tabs)/trips' src/ui/trips
# 14. leaveAt comes from M7.1's pure leave-by (m7a), not a UI re-implementation
need_re 'domain/trips/leave-by' 'src/app/(tabs)/trips' src/ui/trips
# 15. TripCard renders the CountdownHero
need_all src/ui/trips/TripCard.tsx "from ['\"][^'\"]*/CountdownHero['\"]"
# 16. the hero's states come from M7.2's countdown module (m7a's src/ui/trips/countdown.ts)
need_re "from ['\"][^'\"]*/countdown['\"]" src/ui/trips
# 17. A (M7.8) + the m3a input: trips sorted by leaveAt; the empty state; at night (no service) the card never says "transfer"
jest_cases src/ui/trips "sorted by leaveAt" "empty state" "never says transfer"
# 18. the trips tests assert the plan's empty-state copy (M5.5) literally
need_lits src/ui/trips/__tests__ 'No trips yet'

# --- M7.9 Add-trip flow ------------------------------------------------------------------------------
# 19. the add-trip routes exist where the plan puts them
for f in src/app/trip/new/_layout.tsx src/app/trip/new/from.tsx src/app/trip/new/to.tsx src/app/trip/new/start.tsx src/app/trip/new/confirm.tsx 'src/app/trip/[tripId].tsx'; do need_file "$f"; done
# 20. the add-trip flow is a Stack whose steps carry real titles (M1.19: no "(tabs)" back labels)
need_all src/app/trip/new/_layout.tsx '\bStack\b' 'title'
# 21. A (M7.9) on the REAL schedule DB: directReachable(Dadeland South) includes Government Center and excludes Bayfront Park
nodetest_real_cases scripts/gtfs/__tests__/repo-reachable.test.ts "includes government center" "excludes bayfront park"
# 22. the real-DB test calls directReachable and asserts the exclusion reason needs-transfer literally
need_lits scripts/gtfs/__tests__/repo-reachable.test.ts 'directReachable' 'needs-transfer'
# 23. directReachable lives in the engine (non-test src/data or src/domain), where node:test can load it
need_re '(^|[^A-Za-z0-9_$])directReachable([^A-Za-z0-9_$]|$)' src/data src/domain
# 24. the add-trip flow consumes directReachable (non-test src/app/trip or src/ui/trips)
need_re '(^|[^A-Za-z0-9_$])directReachable([^A-Za-z0-9_$]|$)' src/app/trip src/ui/trips
# 25. the add-trip flow persists through M7.3's saved-trips repo
need_re 'saved-trips-repo' src/app/trip src/ui/trips
# 26. A (M6.4, moved from m6b gate 8 by ruling R4): the footer offers save trip, starting a trip from this station — its own test.
jest_pin src/ui/stations/__tests__/StationSheetFooter.test.tsx '(^| )save trip starts a trip from this station$'
# 27. R4: m6b's StationSheetFooter really opens the add-trip flow: its non-test closure links an add-trip route that exists ('/trip/new/to' with the station as origin, or '/trip/new/from'; bare '/trip/new' only with a trip/new/index.tsx).
footer_opens_add_trip
# 28. R6 (moved from m10b gate 7): a saved trip opens route options — src/app/trip/[tripId].tsx's non-test closure links '/plan'.
closure_links 'src/app/trip/[tripId].tsx' /plan

# --- whole card --------------------------------------------------------------------------------------
# 29. every jest.mock in this card's tests — and in m6b's handoff tests (R5 moved them to m6b, which has no mock audit) — is a LABELLED NATIVE-module mock (no stubs of our own code)
native_mocks_labelled src/ui/trips/__tests__ src/ui/now/__tests__ src/domain/handoff/__tests__
# 30. repo-wide gate over this card's code: tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test
full_gate_over_card
# 31. Metro bundles the app for iOS, and a --no-bytecode export on a private Metro cache registers every route this card adds
export_bundles_routes directions.tsx 'trip/new/_layout.tsx' 'trip/new/from.tsx' 'trip/new/to.tsx' 'trip/new/start.tsx' 'trip/new/confirm.tsx' 'trip/[tripId].tsx' '(tabs)/trips/index.tsx'

echo "m7b_trips_ui: all 31 gates green"
