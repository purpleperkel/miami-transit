#!/usr/bin/env bash
# m5b_map_shell — Map/Trips/Stations tab shell + real back titles (M5.5), mapGeometry (M5.6), LinePolylines (M5.7), StationMarker (M5.8).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line: under `set -e`, a failing left side of `a && b` does
# not stop the script, so compound checks live inside the card helpers below.
# Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-m5b_map_shell.sh

# ---- Card helpers (each fails loud with a named reason, like lib.sh) ----

# The CARD-WIDE universe of jest acceptance cases: every case any jest_cases gate below names
# (gates 4, 8, 10, 14, 17), spelled exactly as that gate passes it. A case counts only when a PASSED
# test's full name matches it and NO OTHER case in this universe. Gate 17 runs all of
# src/ui/map/__tests__, which also holds the gate-10 and gate-14 files, so a per-call check would let
# one test named for an M5.7 case AND an M5.8 case satisfy gate 14 and gate 17 at once; checked
# against the universe, that test is nobody's own test. Helpers only read it; no gate sets it.
M5B_JEST_CASES=(
  'Map, Trips and Stations' 'keeps the BottomAccessory' 'No trips yet' 'one row per station'
  'every pushed route has a title' 'no back button reads'
  'zoomBucket\(0\.3\) ?= ?0\b' 'zoomBucket\(0\.01\) ?= ?3\b' 'offsetPolyline.*5 ?± ?0\.5 ?m' 'regionForPoints contains every input point'
  '2 polylines per segment' 'casing is \+3' 'dim.*0\.3 alpha'
  'visual key changes with selection' 'visual key changes with zoom bucket' 'hit area.*44'
)

# Named jest acceptance cases, each proven by ITS OWN passing test. lib.sh's `jest_nonempty -t`
# takes one name and cannot see real skips (jest reports -t-filtered tests as skipped). So: run the
# path unfiltered with --json; nothing may fail, be skipped or be todo; every case must be a member
# of M5B_JEST_CASES; and every case (a case-insensitive regex on the full name, describe titles +
# test title) must match >=1 PASSED test whose full name matches NO other case in the card-wide
# universe — one catch-all test cannot satisfy two cases, in this gate or in any other gate.
jest_cases() {
  local path="$1" report out rc=0; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one case name"; return 1; }
  report=$(mktemp) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(local_bin jest --ci "$path" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; rm -f "$report"; echo "ratchet: jest is red under $path"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; rm -f "$report"; echo "ratchet: jest wrote no JSON report for $path"; return 1; }
  node -e '
    const [file, where, count, ...rest] = process.argv.slice(1);
    const n = Number(count);
    const cases = rest.slice(0, n), universe = rest.slice(n);
    const authoring = [];
    if (!(n >= 1) || universe.length === 0) authoring.push(`bad arguments (${n} case(s), ${universe.length} in the universe)`);
    if (new Set(universe).size !== universe.length) authoring.push("M5B_JEST_CASES lists a case twice");
    cases.filter((c) => !universe.includes(c)).forEach((c) => authoring.push(`/${c}/ is not in M5B_JEST_CASES`));
    if (authoring.length) {
      authoring.forEach((p) => console.log(`ratchet: verify-script authoring error: ${p}`));
      process.exit(1);
    }
    const r = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const passed = r.testResults.flatMap((t) => t.assertionResults)
      .filter((a) => a.status === "passed").map((a) => a.fullName);
    if (r.numFailedTests || r.numFailedTestSuites || r.numPendingTests || r.numTodoTests || passed.length === 0) {
      console.log(`ratchet: ${where}: ${passed.length} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, ${r.numTodoTests} todo`);
      process.exit(1);
    }
    const res = universe.map((c) => new RegExp(c, "iu"));
    const problems = [];
    cases.forEach((c) => {
      const i = universe.indexOf(c);
      const hits = passed.filter((name) => res[i].test(name));
      const own = hits.filter((name) => res.every((re, j) => j === i || !re.test(name)));
      if (hits.length === 0) problems.push(`no PASSED test is named /${c}/`);
      else if (own.length === 0) problems.push(`/${c}/ only matches tests whose full name also matches another card case (${hits.join(" ; ")}) — give it its own test`);
    });
    if (problems.length) {
      problems.forEach((p) => console.log(`ratchet: ${where}: ${p}`));
      console.log(`passed tests: ${passed.join("  ;  ")}`);
      process.exit(1);
    }
    console.log(`OK ${cases.length} named case(s), each its own passing test (distinct across the card), in ${where}`);
  ' "$report" "$path" "$#" "$@" "${M5B_JEST_CASES[@]}" || rc=1
  rm -f "$report"
  return "$rc"
}

# One named node:test acceptance case on the REAL schedule DB, in place. A probe on
# DatabaseSync.prototype.prepare/createTagStore logs every DB file the test process queries; the run
# must have queried assets/db/schedule.db itself (not a copy, not the mini feed). Counting uses
# lib.sh's leaf counter (Node 26 reports an empty file as one passing wrapper test).
nodetest_real_db() {
  local file="$1" pat="$2" out lc n real_db probe
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  need_file assets/db/schedule.db || return 1
  real_db="$(pwd -P)/assets/db/schedule.db"
  probe='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?String(db.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","createTagStore"]){const f=D.prototype[k];D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}'
  # The probe is imported BEFORE tsx so it loads on Node's default loader (the order m3a proved).
  out=$(node --import "$probe" --import tsx --test --test-reporter=tap --test-name-pattern="/$pat/i" "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: tests matching /$pat/i are red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  lc=$(printf '%s' "$pat" | tr '[:upper:]' '[:lower:]')
  n=$(echo "$out" | _nodetest_count "$lc" "$file")
  [ "$n" -ge 1 ] || { echo "$out" | tail -10; echo "ratchet: no passing test named /$pat/i in $file"; return 1; }
  grep -qF "ratchet-db-open: $real_db" <<<"$out" \
    || { grep -F "ratchet-db-open:" <<<"$out" || echo "(no DB was queried)"; echo "ratchet: /$pat/i in $file never queried $real_db — the station list must come from the real DB, in place"; return 1; }
}

# The tab layout declares a NativeTabs.Trigger for each named tab (route name "<tab>" or
# "<tab>/index", one-line JSX as in M1.18) and still renders the <NativeTabs.BottomAccessory>
# element (the JSX tag, not merely a reference such as the layout's invariant on it).
tabs_declared() {
  local layout="$1" tab; shift
  need_file "$layout" || return 1
  for tab in "$@"; do
    grep -qE "<NativeTabs\.Trigger[^>]*name=[\"']${tab}(/index)?[\"']" "$layout" \
      || { echo "ratchet: $layout declares no <NativeTabs.Trigger> for the '$tab' tab (name=\"$tab\" or \"$tab/index\")"; return 1; }
  done
  grep -qF "<NativeTabs.BottomAccessory" "$layout" \
    || { echo "ratchet: $layout no longer renders <NativeTabs.BottomAccessory> — M5.5 extends the M1.18 shell and keeps the accessory"; return 1; }
}

# A non-test module under the given paths imports from src/data (@/data/… or ../data/…): the
# screen or hook reads the schedule DB through the data layer instead of a hardcoded list.
db_backed() {
  local label="$1" p rc=0; shift
  local paths=()
  for p in "$@"; do
    if [ -e "$p" ]; then paths+=("$p"); fi
  done
  [ "${#paths[@]}" -gt 0 ] || { echo "ratchet: $label: none of $* exists yet"; return 1; }
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ \
    "from ['\"](@/data/|(\.\./)+data/)" "${paths[@]}" || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ratchet: $label: no non-test module under ${paths[*]} imports src/data — it must read the schedule DB, not a hardcoded list"; return 1
  fi
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning ${paths[*]}"; return 1; }
}

# Some non-test route or screen-options module sets headerBackTitle (M1.19: Diagnostics' back
# button read "(tabs)"). Tests are excluded so the route-titles test cannot satisfy this by naming it.
back_title_set() {
  local rc=0
  grep -rqF --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ headerBackTitle src/app src/ui || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ratchet: nothing under src/app or src/ui (tests excluded) sets headerBackTitle — pushed routes still show \"(tabs)\" as their back label (M1.19)"; return 1
  fi
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning src/app and src/ui for headerBackTitle"; return 1; }
}

# The test file mocks the native module with jest.mock('<mod>', …) and labels THAT call with
# `// test-time mock of native module` (on the line above, or trailing on the same line).
native_mock_labelled() {
  local file="$1" mod="$2" rc=0
  need_file "$file" || return 1
  awk -v mod="$mod" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    index(line, "jest.mock(\047" mod "\047") == 1 || index(line, "jest.mock(\"" mod "\"") == 1 {
      found = 1
      if (prev ~ /^\/\/ test-time mock of native module/ || line ~ /\/\/ test-time mock of native module/) labelled = 1
    }
    { prev = line }
    END { if (!found) exit 1; if (!labelled) exit 2; exit 0 }' "$file" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) echo "ratchet: $file never calls jest.mock('$mod') — $mod is native and must be a named test-time mock"; return 1 ;;
    2) echo "ratchet: $file mocks $mod without the '// test-time mock of native module' label at the jest.mock call"; return 1 ;;
    *) echo "ratchet: awk failed (rc=$rc) on $file"; return 1 ;;
  esac
}

# Metro bundles the app for iOS (lib.sh ios_export: the plan's Hermes export) AND the app's iOS JS
# carries the given text as ONE whole string literal — proof the new tab routes are in the bundle, not
# just in the source tree. The literal is NOT grepped in the Hermes .hbc: its string table packs
# strings back to back, and on the unbuilt tree (2026-10-01) the bytes "No trips yet" already appear
# there across unrelated strings ("…registered for key No trips yetabBarControllerMode"), a false
# green. So the same app is also exported with --no-bytecode, where the text must appear quoted.
ios_bundle_carries() {
  local text="$1" dir=.cache/export-m5b-js out rc=0
  ios_export || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(npx expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  grep -rqF -e "\"$text\"" -e "'$text'" -e "\`$text\`" "$dir/_expo/static/js/ios" || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ratchet: the iOS JS bundle has no whole string literal \"$text\" — the Trips tab's empty state is not shipped"; return 1
  fi
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
}

# The repo-wide gate over THIS card's code. A bare full_gate is green on the unbuilt tree (it proves
# nothing about M5.5–M5.8), so first every module and named test file the card creates must exist —
# tsc strict, eslint --max-warnings 0, the standards checker, jest and node:test then actually run
# over them — and only then must `npm run verify` be green.
m5b_full_gate() {
  local f
  for f in "src/app/(tabs)/trips/index.tsx" "src/app/(tabs)/stations/index.tsx" \
           src/ui/__tests__/tab-shell.test.tsx src/ui/__tests__/route-titles.test.tsx \
           scripts/gtfs/__tests__/repo-stations.test.ts \
           src/ui/map/mapGeometry.ts src/ui/map/__tests__/mapGeometry.test.ts \
           src/ui/map/LinePolylines.tsx src/ui/map/use-line-geometry.ts src/ui/map/__tests__/LinePolylines.test.tsx \
           src/ui/map/StationMarker.tsx src/ui/map/vehicleVisual.ts; do
    need_file "$f" || return 1
  done
  full_gate || return 1
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m5b_map_shell gate failed at verify script line $LINENO"' ERR

# --- M5.5 Tab shell ---
# 1. The Trips tab route exists where the plan puts it (§4 layout; M7.8 builds on it).
need_file "src/app/(tabs)/trips/index.tsx"
# 2. The Stations tab route exists where the plan puts it (§4 layout; M6.5 refines it).
need_file "src/app/(tabs)/stations/index.tsx"
# 3. The tab layout declares Map (index), Trips and Stations triggers and still renders <NativeTabs.BottomAccessory>.
tabs_declared "src/app/(tabs)/_layout.tsx" index trips stations
# 4. Each tab renders real content — named, separate passing tests: the shell's three tabs in order; the accessory kept; Trips shows its EmptyState "No trips yet"; Stations renders one row per station.
jest_cases src/ui/__tests__/tab-shell.test.tsx 'Map, Trips and Stations' 'keeps the BottomAccessory' 'No trips yet' 'one row per station'
# 5. The station list the Stations tab shows comes from the REAL schedule DB: all 44 stations (23 rail + 21 mover), queried in place.
nodetest_real_db scripts/gtfs/__tests__/repo-stations.test.ts 'station list.*44 stations'
# 6. The Stations tab (its route or a src/ui/stations module it renders) reads stations through src/data, not a hardcoded list.
db_backed "Stations tab" "src/app/(tabs)/stations" src/ui/stations
# 7. A non-test route/options module sets headerBackTitle, so no pushed route's back button reads "(tabs)".
back_title_set
# 8. Root-stack contract, as named passing tests: every pushed route has a real title, and no back button reads the "(tabs)" group name.
jest_cases src/ui/__tests__/route-titles.test.tsx 'every pushed route has a title' 'no back button reads'

# --- M5.6 mapGeometry ---
# 9. The geometry module exists where the plan puts it.
need_file src/ui/map/mapGeometry.ts
# 10. M5.6 A, one passing test each: zoomBucket(0.3) = 0; zoomBucket(0.01) = 3; offsetPolyline(·, 5) stays 5 ± 0.5 m; regionForPoints contains every input point.
jest_cases src/ui/map/__tests__/mapGeometry.test.ts 'zoomBucket\(0\.3\) ?= ?0\b' 'zoomBucket\(0\.01\) ?= ?3\b' 'offsetPolyline.*5 ?± ?0\.5 ?m' 'regionForPoints contains every input point'

# --- M5.7 LinePolylines ---
# 11. The line-drawing component exists where the plan puts it.
need_file src/ui/map/LinePolylines.tsx
# 12. use-line-geometry.ts exists and reads line shapes through src/data (the schedule DB), not hardcoded coordinates.
db_backed "line geometry hook" src/ui/map/use-line-geometry.ts
# 13. The LinePolylines test mocks react-native-maps as a labelled test-time mock of a native module.
native_mock_labelled src/ui/map/__tests__/LinePolylines.test.tsx react-native-maps
# 14. M5.7 A, one passing test each (its full name matches no other M5B_JEST_CASES case): 2 polylines per segment; the casing is +3 wide; dim = 0.3 alpha.
jest_cases src/ui/map/__tests__/LinePolylines.test.tsx '2 polylines per segment' 'casing is \+3' 'dim.*0\.3 alpha'

# --- M5.8 StationMarker ---
# 15. The station marker component exists where the plan puts it.
need_file src/ui/map/StationMarker.tsx
# 16. The marker visual-key module exists where the plan puts it.
need_file src/ui/map/vehicleVisual.ts
# 17. M5.8 A, one passing test each (anywhere in src/ui/map tests; its full name matches no other M5B_JEST_CASES case, so no M5.6/M5.7 test can double as one): visual key changes with selection; with zoom bucket; hit area >= 44.
jest_cases src/ui/map/__tests__ 'visual key changes with selection' 'visual key changes with zoom bucket' 'hit area.*44'

# --- Repo-wide ---
# 18. The card's modules and named test files all exist, then tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test — all green with them.
m5b_full_gate
# 19. Metro bundles the app for iOS (Hermes export, the plan's gate) and the app's iOS JS (a --no-bytecode export) carries "No trips yet" as one whole quoted string literal.
ios_bundle_carries 'No trips yet'

echo "m5b_map_shell: all 19 gates green"
