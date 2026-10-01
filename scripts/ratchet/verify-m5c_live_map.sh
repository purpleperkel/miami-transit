#!/usr/bin/env bash
# m5c_live_map — vehicle markers (live/scheduled/stale), tick plan + track-following frames + live reconciliation, dataStatus + StatusPill + MapControlStack, TransitMap wired to schedule + live context, Layers sheet (plan M5.9–M5.12).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line: under `set -e`, a failing left side of `a && b` does
# not stop the script, so compound checks live inside the card helpers below.
# Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-m5c_live_map.sh
#
# TEST-NAME CONVENTION the jest gates rely on: each acceptance case is its OWN passing jest test whose
# full name ("describe … test", matched case-insensitively) ENDS with the quoted phrase. A name can
# end only one way and no phrase in this card is a suffix of another, so one catch-all test can never
# satisfy two cases — in one gate or across gates.

# ---- Card helpers (each fails loud with a named reason, like lib.sh) ----

# jest_named <path> <pattern$>... — lib.sh's jest_nonempty, once per pattern (jest -t: a
# case-insensitive regex on the full test name). Each pattern must end in `$` (see the convention).
jest_named() {
  local path="$1" pat; shift
  [ "$#" -ge 1 ] || { echo "ratchet: jest_named needs at least one test-name pattern"; return 1; }
  for pat in "$@"; do
    case "$pat" in
      *'$') ;;
      *) echo "ratchet: jest_named pattern '$pat' must end in \$ so each case needs its own test"; return 1 ;;
    esac
    jest_nonempty "$path" "$pat" || return 1
  done
}

# need_files <file>... — lib.sh's need_file for each.
need_files() {
  local f
  [ "$#" -ge 1 ] || { echo "ratchet: need_files needs at least one path"; return 1; }
  for f in "$@"; do need_file "$f" || return 1; done
}

# src_imports <specifier-suffix> <path>... — a NON-test .ts/.tsx file under the paths imports (or
# re-exports) a module whose specifier ends in the suffix ('@/ui/map/TransitMap' and './TransitMap'
# both end in '/TransitMap'): the module is wired in, not dead code.
src_imports() {
  local mod="$1" p rc=0; shift
  [ "$#" -ge 1 ] || { echo "ratchet: src_imports needs at least one path to scan"; return 1; }
  for p in "$@"; do
    [ -e "$p" ] || { echo "ratchet: missing $p — not built yet"; return 1; }
  done
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ "from ['\"][^'\"]*${mod}['\"]" "$@" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: no non-test module under $* imports a module ending in '${mod}' — it is not wired in"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning $* for imports of '${mod}'"; return 1
}

# M5.10 wiring: tickPlan.ts, reconcileLive.ts and useVehicleFrames.ts exist; each is imported by a
# non-test map module (src/ui/map) or the Map route; and nothing under src/ui or src/app moves markers
# with AnimatedRegion (§4: motion follows the track by frame ticks, never AnimatedRegion).
frames_wired() {
  local m hits rc=0
  need_files src/ui/map/tickPlan.ts src/ui/map/reconcileLive.ts src/ui/map/useVehicleFrames.ts || return 1
  for m in tickPlan reconcileLive useVehicleFrames; do
    src_imports "/$m" src/ui/map "src/app/(tabs)/index.tsx" || return 1
  done
  hits=$(grep -rlF --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ AnimatedRegion src/ui src/app) || rc=$?
  [ "$rc" -eq 1 ] && return 0
  [ "$rc" -eq 0 ] && { echo "ratchet: AnimatedRegion used in: $hits — §4: markers move along the shape by frame ticks, never AnimatedRegion"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning src/ui and src/app for AnimatedRegion"; return 1
}

# M5.12 Layers wiring: the PURE reducer module src/ui/map/layers.ts (no react / react-native / expo
# import, so persistence I/O lives outside it) is imported by the Layers sheet route AND by the map
# side (a src/ui/map module other than layers* itself, or the Map route), so a toggle changes the map.
layers_wired() {
  local rc=0
  need_files src/ui/map/layers.ts src/app/layers.tsx || return 1
  grep -qE "from ['\"](react|react-native|expo)([-/][^'\"]*)?['\"]" src/ui/map/layers.ts || rc=$?
  [ "$rc" -eq 0 ] && { echo "ratchet: src/ui/map/layers.ts imports react/react-native/expo — the layers reducer must stay pure (persistence I/O belongs in the sheet or a hook)"; return 1; }
  [ "$rc" -eq 1 ] || { echo "ratchet: grep failed (rc=$rc) on src/ui/map/layers.ts"; return 1; }
  src_imports '/ui/map/layers[A-Za-z-]*' src/app/layers.tsx || return 1
  rc=0
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude='layers*' \
    "from ['\"][^'\"]*/layers[A-Za-z-]*['\"]" src/ui/map "src/app/(tabs)/index.tsx" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: no map module (src/ui/map, layers* excluded) or the Map route imports the layers state — the toggles would not change the map"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning the map for layers imports"; return 1
}

# Every jest.mock / jest.doMock in the map tests targets a PACKAGE — never an app module ('@/…',
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
  for (const m of text.matchAll(/\bjest\.(?:mock|doMock)\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    mocks += 1;
    const lineNo = text.slice(0, m.index).split("\n").length;
    const where = `${path.join(dir, rel)}:${lineNo}`;
    const mod = m[2];
    if (mod === undefined) {
      problems.push(`${where}: the jest.mock target is not a string literal`);
      continue;
    }
    if (/^(@\/|\.|src\/)/.test(mod)) problems.push(`${where}: mocks app module '${mod}' — only native modules may be mocked`);
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

# Metro bundles the app for iOS (lib.sh ios_export: the plan's Hermes export) AND the app's iOS JS
# carries the text — proof the component is reachable from a route. The text is NOT grepped in the
# Hermes .hbc: its string table packs strings back to back, so the bytes can appear across unrelated
# strings (m5b found "No trips yet" that way on its unbuilt tree, 2026-10-01; the arbiter found
# "Scheduled" and "position" each already present here at 18:01). So the same app is also exported
# with --no-bytecode, where string literals stay whole and comments are stripped. The text may sit
# inside a longer label or template literal, so it is matched as plain text, not as a whole quoted
# literal (arbiter hardening before the m5c build, 2026-10-01).
ios_bundle_carries() {
  local text="$1" dir=.cache/export-m5c-js out rc=0
  ios_export || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(npx expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  grep -rqF -- "$text" "$dir/_expo/static/js/ios" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: the iOS JS bundle does not contain \"$text\" — VehicleMarker is not reachable from the Map route (dead code) or lost its label"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1
}

# card_full_gate — the repo-wide gate, run only WITH this card's modules in the tree: every M5.9–M5.12
# source file exists first (so tsc strict, eslint --max-warnings 0 and the standards checker actually
# ran over them), then `npm run verify` is green. A bare full_gate is green on the unbuilt tree.
card_full_gate() {
  need_files src/ui/map/VehicleMarker.tsx \
    src/ui/map/tickPlan.ts src/ui/map/reconcileLive.ts src/ui/map/useVehicleFrames.ts \
    src/ui/dataStatus.ts src/ui/map/StatusPill.tsx src/ui/map/MapControlStack.tsx \
    src/ui/map/TransitMap.tsx src/ui/map/emphasis.ts src/ui/map/layers.ts src/app/layers.tsx || return 1
  full_gate || return 1
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m5c_live_map gate failed at verify script line $LINENO"' ERR

# --- M5.9 VehicleMarker: live / scheduled / stale ---
# 1. The vehicle marker component exists where the plan puts it.
need_file src/ui/map/VehicleMarker.tsx
# 2. M5.9 A: bearingOctant(359) = 0 — the heading nose wraps to north (floor(359/45) would give 7).
jest_named src/ui/map 'bearingOctant\(359\) is 0$'
# 3. §4 + M5.9 A, one passing test each: live is solid; scheduled is hollow; the scheduled marker's accessibility label contains "Scheduled position".
jest_named src/ui/map 'VehicleMarker.*live is solid$' 'VehicleMarker.*scheduled is hollow$' 'VehicleMarker.*scheduled a11y label contains Scheduled position$'
# 4. Swiftly staleness (§3 fresh <= 75 s; arbiter ruling 2026-10-01 in §4 + M5.9 supersedes the flat 60 s), one passing test each: a Swiftly fix exactly 75 s old renders live (opacity 1, no clock badge); one above 75 s renders stale (opacity 0.5 + clock badge).
jest_named src/ui/map 'VehicleMarker.*swiftly at 75 s is not stale$' 'VehicleMarker.*swiftly stale above 75 s$'
# 5. Transitland staleness (§3 fresh <= 150 s, same ruling), one passing test each: a Transitland fix 120 s old renders live (a flat 60 s rule, or Swiftly's 75 s applied to every provider, fails it); exactly 150 s renders live; above 150 s renders stale (opacity 0.5 + clock badge).
jest_named src/ui/map 'VehicleMarker.*transitland at 120 s is not stale$' 'VehicleMarker.*transitland at 150 s is not stale$' 'VehicleMarker.*transitland stale above 150 s$'

# --- M5.10 Tick plan + vehicle frames + live reconciliation ---
# 6. M5.10 A: tickPlan gives 250 ms when focused, 5000 ms under Reduce Motion, 0 (no timer) when inactive.
jest_named src/ui/map 'tickPlan.*focused -> 250 ms$' 'tickPlan.*reduce motion -> 5000 ms$' 'tickPlan.*inactive -> 0 ms$'
# 7. M5.10 A: reconcileLive never moves a marker back for a correction under 50 m; snaps at >= 50 m (50 m exactly snaps); the forward projection is clamped to the next stop + 20 s.
jest_named src/ui/map 'reconcileLive.*never moves back under 50 m$' 'reconcileLive.*snaps at 50 m$' 'reconcileLive.*projection clamped to next stop \+ 20 s$'
# 8. tickPlan.ts, reconcileLive.ts and useVehicleFrames.ts exist and are each imported by a map module or the Map route; no AnimatedRegion under src/ui or src/app.
frames_wired

# --- M5.11 dataStatus + StatusPill + MapControlStack ---
# 9. The status model and both floating controls exist where the plan puts them.
need_files src/ui/dataStatus.ts src/ui/map/StatusPill.tsx src/ui/map/MapControlStack.tsx
# 10. M5.11 A, one passing test per adjacent pair: expired > offline > stale > live > expiring > scheduled.
jest_named src/ui 'dataStatus.*expired beats offline$' 'dataStatus.*offline beats stale$' 'dataStatus.*stale beats live$' 'dataStatus.*live beats expiring$' 'dataStatus.*expiring beats scheduled$'
# 11. §4 (never color alone): the pill shows an icon AND a word for every status; the control stack's Layers button opens the Layers sheet (the sheet is reachable).
jest_named src/ui/map 'StatusPill.*icon and word for every status$' 'MapControlStack.*layers button opens the layers sheet$'

# --- M5.12 TransitMap wired to schedule + live context; Layers sheet ---
# 12. TransitMap, emphasis and the Layers route exist where the plan puts them.
need_files src/ui/map/TransitMap.tsx src/ui/map/emphasis.ts src/app/layers.tsx
# 13. M5.12 A, one passing test each: TransitMap's MapView gets mapType mutedStandard, showsPointsOfInterests false, pitchEnabled false, showsBuildings false.
jest_named src/ui/map 'TransitMap.*mapType is mutedStandard$' 'TransitMap.*points of interest off$' 'TransitMap.*pitch off$' 'TransitMap.*buildings off$'
# 14. The Map tab route renders TransitMap (src/app/(tabs)/index.tsx imports it).
src_imports '/TransitMap' "src/app/(tabs)/index.tsx"
# 15. The map reads the schedule DB context: a map module or the Map route imports src/data/schedule-db-provider (useScheduleDb, m3b).
src_imports '/schedule-db-provider' src/ui/map "src/app/(tabs)/index.tsx"
# 16. The map reads the live context: a map module or the Map route imports src/live/live-context (m4b).
src_imports '/live-context' src/ui/map "src/app/(tabs)/index.tsx"
# 17. emphasis.ts is used by the map (a map module or the Map route imports it).
src_imports '/emphasis' src/ui/map "src/app/(tabs)/index.tsx"
# 18. Layers toggles, as pure reducer tests: a toggle flips only that layer; the persisted form round-trips to the same state.
jest_named src/ui/map 'layers reducer.*toggle flips only that layer$' 'layers reducer.*persisted state round-trips$'
# 19. src/ui/map/layers.ts stays pure and is imported by both the Layers route and the map side.
layers_wired
# 20. §4 Sheets + M1.19 (real route titles): the root stack presents the layers route as a formSheet titled "Layers".
jest_named src 'layers route opens as a formSheet titled Layers$'
# 21. The map tests mock only native packages, each labelled '// test-time mock of native module' (no app module is mocked).
mocks_native_only src/ui/map/__tests__

# --- Repo-wide ---
# 22. With every M5.9–M5.12 source file in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test — all green.
card_full_gate
# 23. Metro bundles the app for iOS and the shipped bundle carries "Scheduled position" (VehicleMarker is reachable from the Map route).
ios_bundle_carries 'Scheduled position'

echo "m5c_live_map: all 23 gates green"
