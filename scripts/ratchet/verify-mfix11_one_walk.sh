#!/usr/bin/env bash
# mfix11_one_walk — ONE walk for a saved trip, everywhere it is shown or used. Jamie, 2026-10-02 09:12: "Also says
# chill pace for getting to fifth but estimated walk time from Google Maps would put me at 1 min after scheduled
# arrival". mfix9 routes the bar's, the station sheet's and the route chip's walk; the mfix9 prover then flagged that
# the saved trips' leave-by countdowns ("Leave in N min") still walk src/domain/trips/walk-estimate.ts (straight line
# x 1.3), and the mfix8 reviewer found that ONE saved trip shows two walks a tap apart: the Now bar walks the straight
# line to the boarding PLATFORM x 1.3 and IGNORES walkOverrideMin (src/ui/hurry/trip-verdict.ts:73-78), while the trip
# card it opens walks the trip's override or the straight line to the station CENTRE x 1.3 (src/ui/trips/trip-card.ts
# tripWalk:132-142), and even the same seconds show different minutes (the bar ceil(walkS / 60), now-strip.ts:90; the
# card max(1, round(walkS / 60)), trip-copy.ts:94). Today (main 0451a6c) the bar says "~6 min walk" and the card
# "a 5 min walk from here" for the same estimated walk, and "~6 min walk" vs "a 7 min walk (your setting)" with a
# 7-minute override. Builds AFTER mfix9_routed_walk (walkFor, useWalkTo, RoutedWalkProvider, WalkEstimate, the
# committed fixture, mfix9's useNearTripWalk) on mfix8_trip_bar (0451a6c plus its fix round).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not stop
# the script); compound checks live inside the card helpers below. Helpers read no variable another gate set.
# NO NETWORK in any gate: the oracles inject mfix9's fetchWalk with the committed fixture. Run one gate alone, from
# the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix11_one_walk.sh
#
# BINDING CONTRACT (the oracles load these by path and name; a parallel copy elsewhere cannot satisfy them):
#   src/ui/trips/trip-walk.ts   export type SavedTripWalk = { source: 'override' | 'routed' | 'estimated';
#                                 from: 'setting' | 'here' | 'start'; walkS: number; minutes: number; stopId: string | null }
#                                 walkS   whole seconds: override = its minutes x 60; otherwise Math.ceil(metres / walkMps),
#                                         metres = the WalkEstimate's walkMeters x detour (routed) or the straight line
#                                         x HURRY_DEFAULTS.detour (estimated) — never rounded DOWN
#                                 minutes what EVERY screen shows: Math.ceil(walkS / 60) (an override: its own minutes)
#                                 stopId  the GTFS stop_id of the boarding platform walked to; null for an override
#                               export type SavedTripWalkInput = { platforms: readonly WalkStop[]; position: LatLon | null;
#                                 walkMps: number /* REQUIRED: readWalkingPace().walkMps, never a default */;
#                                 walk?: WalkTo /* mfix9's useWalkTo: (stop: WalkStop) => WalkEstimate, asked with the
#                                 platform itself (walkKey: its stop_id at its place); walks from the RIDER */ }
#                               export function savedTripWalk(trip: Pick<SavedTrip, 'start' | 'walkOverrideMin'>,
#                                 input: SavedTripWalkInput): SavedTripWalk | null — the ONE place a saved trip's walk is
#                                 decided. Precedence: (1) walkOverrideMin -> 'override' (from 'setting'); (2) the walk
#                                 starts at the rider's position, else (no position) at the trip's saved start, else
#                                 null; the platform is the input platform nearest that origin (straight line; a tie
#                                 keeps the first listed); (3) 'routed' when the walk starts at the rider and walk(that
#                                 platform) is routed; (4) otherwise 'estimated' (from 'here' or 'start'). It throws (invariant)
#                                 on a missing or non-positive walkMps.
#   src/ui/trips/trip-card.ts   TripCardInput gains walk?: WalkTo (mfix9's, asked with the stop); TripCardModel.walk is
#                                 SavedTripWalk | null; tripWalk and TripWalk are gone; tripCards(source, trips, input)
#                                 keeps its signature (TripSource may widen, e.g. platforms())
#   src/ui/trips/reminder-candidates.ts reminderCandidates(source, trips, { nowS, walkMps, bufferS }) keeps its signature
#   src/ui/trips/TripScreen.tsx TripDetail({ trip, settings, remove, clock }) keeps its props
#   The bar (NowAccessory, testID 'now-accessory'): regular line 2 ends " · ~N min walk" (routed, estimated) or
#     " · N min walk" (override, no "~"), N = the one walk's minutes; VoiceOver: "an estimated N-minute walk" ONLY for
#     'estimated'; "N-minute walk along streets" for 'routed' (mfix9's phrase); "your N-minute walk" for 'override'.
#   The trip card (CountdownHero, testID 'countdown-hero', in the Trips tab and on the trip screen): "a N min walk
#     from here" / "a N min walk from your start" / "a N min walk (your setting)", N = the same minutes.
#   The rider's position is the one watch's LATEST fix (mfix6's UserLocationProvider) on every screen, never an older one.
#   The verdict (bar) walks the one walk: routed/estimated metres at Jamie's paces (mfix9's verdicts unchanged); an
#     override walks exactly minutes x 60 s and jogs it in walkS x walkMps / jogMps.
#
# TEST-NAME CONVENTION (verify-mfix6's): each acceptance case is its OWN passing jest test whose full name (describe
# titles + test title, one space, case-insensitive) ENDS with the case's exact phrase at a word boundary.
MFIX11_JEST_CASES=(
  'a saved trip walks its override, else the routed walk, else the estimate'
  'the walk never falls back to a module default pace'
  'the bar and the trip card show the same walk for every source'
  'an override walk shows without a tilde and is voiced as your walk'
  'reminders walk the override, else from the saved start, else none'
)
# The card's own test files (the guard for the repo-wide gates and the re-checks).
MFIX11_WALK_TEST=src/ui/trips/__tests__/trip-walk.test.ts
MFIX11_ONE_WALK_TEST=src/ui/trips/__tests__/one-walk.test.tsx
MFIX11_BAR_TEST=src/ui/now/__tests__/override-walk-bar.test.tsx
MFIX11_REMINDER_TEST=src/ui/trips/__tests__/reminder-walk.test.ts

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied from verify-mfix9_routed_walk.sh (mfix6's helper; only the card universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX11_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix11_one_walk.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX11_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX11_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX11_JEST_CASES[@]}" || return 1
}

# need_files and mocks_native_only: copied VERBATIM from verify-mfix9_routed_walk.sh (mfix6's helpers).
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

# The card's own test files and the one-walk module: the guard for the repo-wide gates and the re-checks (a bare
# full_gate is green on the unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files src/ui/trips/trip-walk.ts "$MFIX11_WALK_TEST" "$MFIX11_ONE_WALK_TEST" "$MFIX11_BAR_TEST" "$MFIX11_REMINDER_TEST" || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built (m7b's reminder rule, mfix9's routed
# label, mfix6's one watch) that this card's edits could break, run only WITH this card's files.
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

# card_ios_export — guarded on this card's files: Metro bundles the app for iOS (lib.sh ios_export) on a PRIVATE
# Metro cache (TMPDIR; the mfix2/m10b/mfix6/mfix9 pattern). The card adds no new user-visible literal to grep for (the
# override's "your N-minute walk" is built from the minutes), so the export itself is the check (never a .hbc grep).
card_ios_export() {
  local metro_tmp="$PWD/.cache/metro-tmp-mfix11"
  card_files || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  echo "ratchet: Metro bundles the app for iOS"
}

# old_walk_sites — E. hygiene, the grep gate: no second walk computation for saved trips survives (comments stripped;
# test files, fixtures and mocks excluded).
#   - m7a's estimateWalk / walkSeconds / PLANNING_WALK_MPS / WALK_DETOUR are referenced by NO app file but
#     src/domain/trips/walk-estimate.ts itself (it stays for m7a's own tests and gates; isWalkOverride and
#     MAX_WALK_OVERRIDE_MIN stay in use by the add-trip flow and the repo);
#   - m7b's tripWalk / TripWalk are gone;
#   - savedTripWalk is defined once, in src/ui/trips/trip-walk.ts; trip-card.ts and reminder-candidates.ts call it;
#     trip-verdict.ts (the bar) takes its walk from it (it calls savedTripWalk or receives a SavedTripWalk);
#   - those three no longer measure a walk themselves: no nearestPlatform, haversineMeters, HURRY_DEFAULTS or walkFor;
#   - the bar's and the card's shown minutes are the one walk's `minutes`: no `walkS / 60` in now-strip.ts or trip-copy.ts;
#   - the Trips tab / trip screen read mfix9's routed walk: some module under src/ui/trips calls useWalkTo(...).
old_walk_sites() {
  need_files src/ui/trips/trip-card.ts src/ui/trips/reminder-candidates.ts src/ui/hurry/trip-verdict.ts || return 1
  node - <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const problems = [];
const isTest = (f) => /(^|\/)(__tests__|__fixtures__|__mocks__)\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f);
const files = fs.readdirSync('src', { recursive: true }).map((f) => path.join('src', String(f))).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f));
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const OLD = /\b(estimateWalk|walkSeconds|PLANNING_WALK_MPS|WALK_DETOUR)\b/;
for (const f of files) if (f !== 'src/domain/trips/walk-estimate.ts' && OLD.test(code(f))) problems.push(`${f} still walks a saved trip the old way (${code(f).match(OLD)[0]}: m7a's straight line x 1.3) — every saved-trip walk is savedTripWalk's`);
for (const f of files) if (/\b(tripWalk|TripWalk)\b/.test(code(f))) problems.push(`${f} still has m7b's tripWalk/TripWalk — the second walk computation must be gone`);
const defs = files.filter((f) => /export\s+function\s+savedTripWalk\s*\(/.test(code(f)));
if (defs.length !== 1 || defs[0] !== 'src/ui/trips/trip-walk.ts') problems.push(`savedTripWalk is defined once, in src/ui/trips/trip-walk.ts; found the definition in ${JSON.stringify(defs)}`);
for (const f of ['src/ui/trips/trip-card.ts', 'src/ui/trips/reminder-candidates.ts']) if (!/\bsavedTripWalk\s*\(/.test(code(f))) problems.push(`${f} must decide the trip's walk with savedTripWalk(...)`);
if (!/\b(savedTripWalk|SavedTripWalk)\b/.test(code('src/ui/hurry/trip-verdict.ts'))) problems.push('src/ui/hurry/trip-verdict.ts (the Now bar\'s verdict) must walk savedTripWalk\'s walk (call it, or take a SavedTripWalk)');
for (const f of ['src/ui/trips/trip-card.ts', 'src/ui/trips/reminder-candidates.ts', 'src/ui/hurry/trip-verdict.ts']) {
  const own = code(f).match(/\b(nearestPlatform|haversineMeters|HURRY_DEFAULTS|walkFor)\b/);
  if (own !== null) problems.push(`${f} still measures a walk itself (${own[0]}): the platform and the distance are savedTripWalk's`);
}
for (const f of ['src/ui/now/now-strip.ts', 'src/ui/trips/trip-copy.ts']) if (/walkS\s*\/\s*60\b/.test(code(f))) problems.push(`${f} turns walk seconds into minutes itself — the bar and the card show the one walk's \`minutes\``);
if (!files.some((f) => f.startsWith('src/ui/trips/') && /\buseWalkTo\s*\(/.test(code(f)))) problems.push('no module under src/ui/trips reads mfix9\'s routed walk through useWalkTo(...): the Trips tab and the trip screen would never show the routed walk');
if (problems.length > 0) { for (const p of problems) console.log(`ratchet: ${p}`); process.exit(1); }
console.log('ratchet: one walk computation for saved trips (savedTripWalk); the old call sites are gone');
NODE
}

# pace_wiring — E. hygiene, the pace half (arbiter ONE-PACE ruling, 2026-10-01 22:26: every app caller passes
# readWalkingPace()): savedTripWalk takes the pace and never supplies one (no default, no settings read); no app file
# leans on a module default pace (PLANNING_WALK_MPS only in walk-estimate.ts; DEFAULT_WALK_MPS / DEFAULT_JOG_MPS /
# DEFAULT_WALKING_PACE only under src/ui/settings, where they are the stored-nothing default and its footer;
# HURRY_DEFAULTS.walkMps / .jogMps nowhere in app code); and every app caller of a saved-trip walk entry point
# (tripCards, reminderCandidates, tripVerdict, judgeTrip, savedTripWalk) outside its defining module reads
# readWalkingPace(). judgeTrip is the bar's entry point: src/ui/hurry/useHurryVerdict.ts (useNearTripVerdict) judges the
# near trip through it, so the bar's verdict is one of the callers counted. At least FOUR app files call one: the Trips
# tab, the home context, the reminder sync and the bar's verdict hook (the count names the files it found).
pace_wiring() {
  need_files src/ui/trips/trip-walk.ts || return 1
  node - <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const problems = [];
const isTest = (f) => /(^|\/)(__tests__|__fixtures__|__mocks__)\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f);
const files = fs.readdirSync('src', { recursive: true }).map((f) => path.join('src', String(f))).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f));
const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = code('src/ui/trips/trip-walk.ts');
const leans = walk.match(/\b(PLANNING_WALK_MPS|DEFAULT_WALK_MPS|DEFAULT_JOG_MPS|DEFAULT_WALKING_PACE|readWalkingPace|HURRY_DEFAULTS\s*\.\s*(walkMps|jogMps))\b|walkMps\s*(\?\?|=(?!=|>))/);
if (leans !== null) problems.push(`src/ui/trips/trip-walk.ts must take Jamie's pace from its caller and never supply one (found ${JSON.stringify(leans[0])})`);
for (const f of files) {
  const c = code(f);
  if (f !== 'src/domain/trips/walk-estimate.ts' && /\bPLANNING_WALK_MPS\b/.test(c)) problems.push(`${f} leans on m7a's module default pace PLANNING_WALK_MPS`);
  if (!f.startsWith('src/ui/settings/') && /\b(DEFAULT_WALK_MPS|DEFAULT_JOG_MPS|DEFAULT_WALKING_PACE)\b/.test(c)) problems.push(`${f} leans on the settings' default pace instead of readWalkingPace()`);
  if (/\bHURRY_DEFAULTS\s*\.\s*(walkMps|jogMps)\b/.test(c)) problems.push(`${f} leans on m7c's default pace HURRY_DEFAULTS.walkMps/jogMps`);
}
// judgeTrip: the bar's verdict (useHurryVerdict.ts useNearTripVerdict) judges its near trip through it, not tripVerdict.
const entry = { tripCards: 'src/ui/trips/trip-card.ts', reminderCandidates: 'src/ui/trips/reminder-candidates.ts', tripVerdict: 'src/ui/hurry/trip-verdict.ts', judgeTrip: 'src/ui/hurry/trip-verdict.ts', savedTripWalk: 'src/ui/trips/trip-walk.ts' };
const pure = new Set(Object.values(entry));
const callers = [];
for (const f of files) {
  if (pure.has(f)) continue;
  const called = Object.keys(entry).filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(code(f)));
  if (called.length === 0) continue;
  callers.push(f);
  if (!/\breadWalkingPace\s*\(/.test(code(f))) problems.push(`${f} calls ${called.join(', ')} but never reads readWalkingPace(): Jamie's pace must reach every saved-trip walk`);
}
// Four: the Trips tab (tripCards), the home context (tripCards), the reminder sync (reminderCandidates) and the bar's
// verdict hook (judgeTrip) each call one; fewer means one of them walks a saved trip some other way.
const WANT_CALLERS = 4;
if (callers.length < WANT_CALLERS) problems.push(`only ${callers.length} app file(s) call a saved-trip walk entry point (${callers.join(', ') || 'none'}); the Trips tab, the home context, the reminder sync and the bar's verdict hook do (${WANT_CALLERS})`);
if (problems.length > 0) { for (const p of problems) console.log(`ratchet: ${p}`); process.exit(1); }
console.log(`ratchet: ${callers.length} app caller(s) of the saved-trip walk read readWalkingPace() (${callers.join(', ')}); no module default pace is leaned on`);
NODE
}

# mfix11_oracle <case> — the card's behaviour checked on the SHIPPED app, independent of the builder's tests: a
# throwaway jest test in the gitignored .cache (removed whether it passes or fails; m7c copy_is's pattern) under the
# repo's own jest-expo/ios transform. It renders the REAL Now bar (NowAccessory), the REAL Trips tab (TripsTab) and
# the REAL trip screen (TripDetail) in ONE tree inside the REAL ScheduleDbProvider (the committed schedule.db through
# node:sqlite), UserDbProvider (an in-memory user.db, trips saved through the REAL SavedTripsRepo),
# UserLocationProvider and — for the routed walk — mfix9's REAL RoutedWalkProvider fed the committed Transitous fixture
# through its injectable fetchWalk (no network, no mocked app module). Labelled native mocks only: expo-sqlite,
# expo-sqlite/kv-store (an in-memory store, so readWalkingPace / saveWalkingPace are the real module's), expo-location,
# expo-crypto, expo-notifications. Expected values come from the shipped engine (tripRides, nearestPlatform,
# hurryVerdict, nextLeave, hurryShort/hurryInline/hurrySentence) and the app's own haversine.
# The scene (mfix9's): the rider O at GTFS stop 815 (Third Street), the saved trip Fifth Street -> Bayfront Park
# (boarding platform 805, 342.03 m straight; the fixture's street walk 710.64 m), T = 430 s before Wednesday
# 2026-09-30's first ride from 805. At Jamie's default 1.35 m/s: estimated ceil(342.03 x 1.3 / 1.35) = 330 s -> 6 min;
# routed ceil(710.64 / 1.35) = 527 s -> 9 min; the override 7 min -> 420 s, 7 min.
# Cases: precedence consistency pace copy reminder
mfix11_oracle() {
  local which="$1" dir out rc=0
  case "$which" in precedence|consistency|pace|copy|reminder) ;;
    *) echo "ratchet: verify-script authoring error: unknown mfix11 oracle case '$which'"; return 1 ;; esac
  need_files src/ui/now/NowAccessory.tsx src/ui/trips/TripsTab.tsx src/ui/trips/TripScreen.tsx src/ui/location/UserLocationProvider.tsx src/ui/trips/__tests__/trip-db.ts src/ui/primitives/__tests__/render-primitive.tsx || return 1
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-mfix11-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/one-walk.oracle.test.tsx" <<'TSX'
const path = require('node:path');
const CASE = process.env.MFIX11_CASE ?? '';
const fail = (m: string): never => { throw new Error(`ratchet-oracle: ${CASE}: ${m}`); };
const show = (v: unknown): string => JSON.stringify(v);
const load = (rel: string, names: string[]): Record<string, any> => {
  let mod: Record<string, any> = {};
  try { mod = require(path.join(process.cwd(), rel)); } catch (e) { fail(`${rel} does not load under jest: ${(e as Error).message.split('\n')[0]}`); }
  for (const n of names) if (mod[n] === undefined) fail(`${rel} exports no ${n}`);
  return mod;
};
type LL = { latitude: number; longitude: number };
let mockFix: LL | null = null;
let mockCopy: unknown = null;
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockProvider, useSQLiteContext: mockScheduleCopy, openDatabaseSync: mockNoUserDbFile }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => mockKvStore());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAsk, watchPositionAsync: mockWatch }));
// test-time mock of native module
jest.mock('expo-crypto', () => ({ randomUUID: mockUuid }));
// test-time mock of native module
jest.mock('expo-notifications', () => mockNotifications());
let mockUuids = 0;
function mockUuid() { mockUuids += 1; return `00000000-0000-4000-8000-${String(mockUuids).padStart(12, '0')}`; }
function mockProvider({ children }: { children?: unknown }) { return children as never; }
function mockScheduleCopy() {
  if (mockCopy === null) {
    const { nodeBackedDatabase } = require(require('node:path').join(process.cwd(), 'src/ui/trips/__tests__/trip-db'));
    const { SCHEDULE_DB_NAME } = jest.requireActual(require('node:path').join(process.cwd(), 'src/data/schedule-db-provider'));
    mockCopy = { ...nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true), databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}` };
  }
  return mockCopy;
}
function mockNoUserDbFile(): never { throw new Error('ratchet-oracle: the user DB is opened through UserDbProvider open=, never a file'); }
function mockKvStore() { return jest.requireActual(require('node:path').join(process.cwd(), 'src/ui/settings/__tests__/native-fakes')).kvStoreModule(); }
function mockAsk() { return Promise.resolve({ granted: mockFix !== null, status: mockFix !== null ? 'granted' : 'denied' }); }
/** The one watch's callback (mfix6: the app opens exactly one), kept so moveTo can report a newer fix through it. */
let mockOnFix: ((f: { coords: LL | null; timestamp?: number }) => void) | null = null;
function mockWatch(_o: unknown, onFix: (f: { coords: LL | null; timestamp?: number }) => void) {
  mockOnFix = onFix;
  if (mockFix !== null) onFix({ coords: mockFix });
  return Promise.resolve({ remove: () => undefined });
}
/** The phone's pending-notification list, as m7b's notifications test keeps it. */
let mockPending: { identifier: string; content: any; trigger: any }[] = [];
function mockNotifications() {
  return {
    SchedulableTriggerInputTypes: { DATE: 'date' },
    setNotificationHandler: () => undefined,
    requestPermissionsAsync: () => Promise.resolve({ granted: true }),
    getPermissionsAsync: () => Promise.resolve({ granted: true }),
    getAllScheduledNotificationsAsync: () => Promise.resolve([...mockPending]),
    scheduleNotificationAsync: (r: any) => { mockPending = [...mockPending.filter((p) => p.identifier !== r.identifier), { identifier: r.identifier, content: r.content, trigger: r.trigger }]; return Promise.resolve(r.identifier); },
    cancelScheduledNotificationAsync: (id: string) => { mockPending = mockPending.filter((p) => p.identifier !== id); return Promise.resolve(); },
  };
}
const { act } = require('react-test-renderer');
const { AppState } = require('react-native');
const { BottomAccessoryPlacementContext } = require('expo-router/build/native-tabs/hooks');
const { renderPrimitive, hostsByTestID, unmountAll } = load('src/ui/primitives/__tests__/render-primitive', ['renderPrimitive', 'hostsByTestID', 'unmountAll']);
const { haversineMeters } = load('src/lib/geo', ['haversineMeters']);
const { ok } = load('src/lib/result', ['ok']);
const db = () => load('src/ui/trips/__tests__/trip-db', ['realScheduleRepo', 'memoryUserRepos', 'savedTrip', 'closeTripDbs', 'WED_0800']);
afterEach(async () => { jest.restoreAllMocks(); await unmountAll(); });
afterAll(() => db().closeTripDbs());

const O: LL = { latitude: 25.772024, longitude: -80.193508 }; // GTFS stop 815, the fixture's public origin
const FIFTH = 'mover:fifth-street', BAYFRONT = 'mover:bayfront-park';
const NO_LIVE = { state: null, runtime: null };
const SETTINGS = { boardBufferS: 120, reminderLeadS: 0 };
const perDeg = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });
const detour = (): number => load('src/domain/hurry/verdict', ['HURRY_DEFAULTS']).HURRY_DEFAULTS.detour;
const platformsOf = (key: string) => db().realScheduleRepo().platforms().filter((p: any) => p.stationKey === key);
const platform = (stopId: string) => { const p = db().realScheduleRepo().platforms().find((x: any) => x.stopId === stopId); if (p === undefined) fail(`premise: schedule.db has no platform ${stopId}`); return p; };
const pick = (w: any) => (w === null || w === undefined ? w ?? null : { source: w.source, from: w.from, walkS: w.walkS, minutes: w.minutes, stopId: w.stopId });

/** T: 430 s before the first Fifth Street -> Bayfront Park ride of Wednesday 2026-09-30 (platform 805): slack 400 s. */
function fixtureInstant(): number {
  const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
  const got = db().realScheduleRepo().tripRides(FIFTH, BAYFRONT, windowFrom(Date.parse('2026-09-30T04:00:00-04:00') / 1000, 4 * 3600));
  if (!got.ok || got.value.kind !== 'rides') fail('premise: Fifth Street -> Bayfront Park has direct rides');
  const first = Math.min(...got.value.rides.filter((r: any) => r.boardStopId === '805').map((r: any) => r.depEpoch));
  if (!Number.isSafeInteger(first)) fail('premise: a first ride boards at platform 805');
  return first - 430;
}
/** The committed fixture's street walk to 805, and mfix9's fetchWalk answering from it (records every request). */
function fixture() {
  const file = path.join(process.cwd(), 'src/domain/walk/__fixtures__/transitous-one-to-many.json');
  let fx: any = null;
  try { fx = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch (e) { fail(`${file} (mfix9's committed fixture) is not readable: ${(e as Error).message}`); }
  const byPoint = new Map<string, any>(fx.request.many.map((t: any, i: number) => [`${t.lat};${t.lon}`, fx.response[i]]));
  const to805 = fx.response[fx.request.many.findIndex((t: any) => t.stopId === '805')]?.distance;
  if (typeof to805 !== 'number' || Math.abs(to805 - 710.64) > 0.01) fail(`premise: the fixture walks 710.64 m to 805, got ${show(to805)}`);
  const calls: string[] = [];
  const fetchWalk = (request: { url: string }) => {
    calls.push(String(request?.url));
    const q = String(request?.url ?? '');
    const params = new Map(q.slice(q.indexOf('?') + 1).split('&').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] as [string, string]));
    const many = (params.get('many') ?? '').split(',').filter((s) => s.length > 0);
    return Promise.resolve(ok(many.map((t) => byPoint.get(t) ?? {})));
  };
  return { routedM: to805 as number, calls, fetchWalk };
}
async function settle(rounds = 8) { await act(async () => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0)); }); }
/** Real timers: wait (<= 2 s) until fetchWalk was called `n` times, then let the answer land (mfix9's untilCalls). */
async function untilCalls(calls: unknown[], n: number) {
  for (let i = 0; i < 40 && calls.length < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await settle();
}
/** The rider moves: the one watch reports a NEWER fix at `to` (timestamped 30 s on, as expo-location stamps a fix). */
async function moveTo(to: LL) {
  if (mockOnFix === null) fail('premise: the app\'s location watch is running (a scene was rendered with a fix)');
  mockFix = to;
  await act(async () => { mockOnFix?.({ coords: to, timestamp: Date.now() + 30_000 }); });
  await settle();
}
function textOf(node: any): string {
  let s = '';
  const stack: any[] = [node];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const n = stack.pop();
    if (typeof n === 'string' || typeof n === 'number') { s += String(n); continue; }
    for (const c of [...(n.children ?? [])].reverse()) stack.push(c);
  }
  return s;
}
function linesOf(host: any): string[] {
  const out: string[] = [];
  const stack = [{ n: host, inText: false }];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const { n, inText } = stack.pop() as { n: any; inText: boolean };
    const isText = n.type === 'Text';
    if (isText && !inText) out.push(textOf(n));
    for (const c of [...(n.children ?? [])].reverse()) if (typeof c !== 'string') stack.push({ n: c, inText: inText || isText });
  }
  return out;
}
type Seen = { lines: string[]; label: string; barWalk: { tilde: boolean; minutes: number } | null; cards: { minutes: number; from: string }[]; cardTexts: string[] };
/** ONE tree: the REAL Now bar, Trips tab and trip screen for `trip` (saved through the real repo), the rider at O, at T; read it with read(). */
async function scene(trip: any, T: number, fetchWalk: unknown | null, placement: 'regular' | 'inline' = 'regular', at: LL | null = O): Promise<any> {
  const { NowAccessory } = load('src/ui/now/NowAccessory', ['NowAccessory']);
  const { TripsTab } = load('src/ui/trips/TripsTab', ['TripsTab']);
  const { TripDetail } = load('src/ui/trips/TripScreen', ['TripDetail']);
  const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
  const { UserDbProvider } = load('src/data/user-db-provider', ['UserDbProvider']);
  const { LiveValueProvider } = load('src/live/live-context', ['LiveValueProvider']);
  const { UserLocationProvider } = load('src/ui/location/UserLocationProvider', ['UserLocationProvider']);
  mockFix = at;
  Object.assign(AppState, { currentState: 'active' });
  const repos = db().memoryUserRepos();
  if (!repos.ok) fail('the in-memory user DB did not open');
  const made = repos.value.trips.create(trip);
  if (!made.ok) fail(`saving ${show(trip)} failed: ${made.error.message}`);
  const screens = (
    <>
      <BottomAccessoryPlacementContext.Provider value={placement}><NowAccessory clock={() => T} /></BottomAccessoryPlacementContext.Provider>
      <TripsTab clock={() => T} />
      <TripDetail trip={trip} settings={SETTINGS} remove={() => true} clock={() => T} />
    </>
  );
  const Provider = fetchWalk === null ? null : load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider']).RoutedWalkProvider;
  const tree = await renderPrimitive(
    <ScheduleDbProvider><UserDbProvider open={() => repos}><LiveValueProvider value={NO_LIVE}><UserLocationProvider>
      {Provider === null ? screens : <Provider fetchWalk={fetchWalk}>{screens}</Provider>}
    </UserLocationProvider></LiveValueProvider></UserDbProvider></ScheduleDbProvider>,
  );
  await settle();
  return tree;
}
/** What the tree shows now: the bar's lines, label and walk; each countdown card's walk (Trips tab, trip screen). */
function read(tree: any): Seen {
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  if (button === undefined) fail('no \'now-accessory\' host rendered');
  const lines = linesOf(button);
  const bw = /· (~?)(\d+) min walk$/.exec(lines[1] ?? '');
  const heroes = hostsByTestID(tree.root, 'countdown-hero');
  const cardTexts = heroes.map((h: any) => textOf(h));
  const cards = cardTexts.map((t: string) => { const m = /· a (\d+) min walk (from here|from your start|\(your setting\))/.exec(t); return m === null ? fail(`a trip card's countdown says no walk ("a N min walk from here / from your start / (your setting)"): ${show(t)}`) : { minutes: Number(m[1]), from: m[2] as string }; });
  return { lines, label: String(button.props.accessibilityLabel ?? ''), barWalk: bw === null ? null : { tilde: bw[1] === '~', minutes: Number(bw[2]) }, cards, cardTexts };
}
/** What the shipped engine says for the trip at T from O, for one walk source, at `pace`. */
function expected(source: 'override' | 'routed' | 'estimated', T: number, pace: { walkMps: number; jogMps: number }, routedM = 710.64) {
  const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
  const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
  const { nearestPlatform } = load('src/domain/hurry/platform', ['nearestPlatform']);
  const { clockFor } = load('src/ui/hurry/hurry-reading', ['clockFor']);
  const repo = db().realScheduleRepo();
  const window = windowFrom(T, 3 * 3600);
  const got = repo.tripRides(FIFTH, BAYFRONT, window);
  if (!got.ok || got.value.kind !== 'rides') fail('premise: Fifth Street -> Bayfront Park has rides at T');
  const rides = got.value.rides.filter((r: any) => r.depEpoch >= T);
  const boards = new Set(rides.map((r: any) => r.boardStopId));
  const hit = nearestPlatform(O, repo.platforms().filter((p: any) => boards.has(p.stopId)), null);
  if (hit.platform.stopId !== '805' || Math.abs(hit.walkMeters - 342.03) > 0.01) fail(`premise: the trip boards at 805, 342.03 m from O; got ${hit.platform.stopId} at ${hit.walkMeters}`);
  const departures = rides.map((r: any) => ({ epoch: r.depEpoch, live: false, lineId: r.lineId, headsign: null }));
  const exact = source === 'override' ? 420 : source === 'routed' ? routedM / pace.walkMps : (hit.walkMeters * detour()) / pace.walkMps;
  const walkS = source === 'override' ? 420 : Math.ceil(exact);
  const minutes = source === 'override' ? 7 : Math.ceil(walkS / 60);
  const verdict = source === 'override' ? hurryVerdict({ now: T, walkMeters: 420 * pace.walkMps, detour: 1, departures, ...pace })
    : source === 'routed' ? hurryVerdict({ now: T, walkMeters: routedM, detour: 1, departures, ...pace }) : hurryVerdict({ now: T, walkMeters: hit.walkMeters, departures, ...pace });
  const ctx = { now: T, clock: clockFor(repo.serviceDays(window).days.map((d: any) => d.baseEpoch)) };
  return { walkS, minutes, verdict, ctx, rides: got.value.rides };
}
const copy = (name: string) => load('src/ui/hurry/copy', [name])[name];
function statusLine(v: any, ctx: any, walk: string): string {
  const { REGULAR_LINE_MAX_CHARS: max } = load('src/ui/now/now-text', ['REGULAR_LINE_MAX_CHARS']);
  const fits = [`${copy('hurryShort')(v, ctx)} · ${walk}`, `${copy('hurryInline')(v, ctx)} · ${walk}`].find((s) => [...s].length <= max);
  return fits ?? fail(`no status line for ${v.kind} fits ${max} characters`);
}
const here = (extra: Record<string, unknown> = {}) => db().savedTrip('fifth', FIFTH, BAYFRONT, { createdEpoch: 1_790_000_100, ...extra });
/** One saved trip, one walk: the bar's N, the Trips tab card's N and the trip screen's N are all `want`. */
function oneWalk(name: string, seen: Seen, want: number, tilde: boolean, from: string) {
  const all = { bar: seen.barWalk, cards: seen.cards };
  if (seen.barWalk === null) fail(`${name}: the bar shows no walk (want ["Bayfront Park", "<verdict> · ${tilde ? '~' : ''}${want} min walk"]), got ${show(seen.lines)}`);
  if (seen.cards.length !== 2) fail(`${name}: the Trips tab and the trip screen each show the trip's countdown card (2 'countdown-hero'), got ${seen.cards.length}: ${show(seen.cardTexts)}`);
  const got = [seen.barWalk.minutes, ...seen.cards.map((c) => c.minutes)];
  if (got.some((n) => n !== want) || seen.barWalk.tilde !== tilde || seen.cards.some((c) => c.from !== from)) {
    fail(`${name}: one saved trip shows ONE walk — want ${want} min on the bar ("${tilde ? '~' : ''}${want} min walk") and on both cards ("a ${want} min walk ${from}"); got bar ${seen.barWalk.tilde ? '~' : ''}${seen.barWalk.minutes}, Trips tab ${show(seen.cards[0])}, trip screen ${show(seen.cards[1])} (${show(all)})`);
  }
}
// Reminders: Government Center -> Dadeland South boards southbound at 9512, 6.4 m WEST of the station centre; the
// saved start W is 480 m due west of the centre (473.6 m from 9512), so the platform walk and the centre walk differ.
const GOV = 'rail:government-ctr', DADS = 'rail:dadeland-south';
const W: LL = { latitude: 25.7760455, longitude: -80.200887 };

/**
 * B: the bar's COUNTDOWN walks the Trips tab's walk too (the home context's cards). The saved trip Vizcaya -> Dadeland
 * South, the rider at O (> NEAR_TRIP_M from every Vizcaya platform, so the bar counts down instead of judging), and a
 * street walk 1.6 x the straight line (the walk server
 * routed leave-by 5 min out. ARBITER RULING (mfix11 review, 2026-10-02): street walks are asked only for origins within
 * HURRY_RANGE_M (2 km) of the rider (nobody walks further; routing far origins would cost Transitous a request a minute
 * while riding). So this far trip asks the walk server for NOTHING, and the bar's "Leave in N min" is the Trips tab's
 * and the trip screen's hero, all over the ESTIMATE. Consistency is still the claim; only its walk source changed.
 */
async function farCountdown(walkMps: number) {
  const { tripCards } = load('src/ui/trips/trip-card', ['tripCards']);
  const { heroOf } = load('src/ui/trips/trip-copy', ['heroOf']);
  const { NEAR_TRIP_M } = load('src/ui/now/homeContext', ['NEAR_TRIP_M']);
  const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
  const repo = db().realScheduleRepo();
  const VIZ = 'rail:vizcaya', DADS2 = 'rail:dadeland-south';
  if (!platformsOf(VIZ).every((p: any) => haversineMeters(O, p) > NEAR_TRIP_M)) fail(`premise: every Vizcaya platform is more than ${NEAR_TRIP_M} m from O`);
  const calls: string[] = [];
  const fetchWalk = (request: { url: string }) => {
    calls.push(String(request?.url));
    const q = String(request?.url ?? '');
    const many = (new Map(q.slice(q.indexOf('?') + 1).split('&').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] as [string, string])).get('many') ?? '').split(',').filter((t) => t.length > 0);
    return Promise.resolve(ok(many.map((t) => { const [lat, lon] = t.split(';').map(Number); return { duration: 1, distance: 1.6 * haversineMeters(O, { latitude: lat as number, longitude: lon as number }) }; })));
  };
  const rides = repo.tripRides(VIZ, DADS2, windowFrom(db().WED_0800 + 3600, 3600));
  if (!rides.ok || rides.value.kind !== 'rides' || rides.value.rides.length === 0) fail('premise: Vizcaya -> Dadeland South has direct rides after 09:00 on Wednesday');
  const far = db().savedTrip('far', VIZ, DADS2, { createdEpoch: 1_790_000_200 });
  const first = rides.value.rides[0];
  const cardAt = (at: number) => tripCards(repo, [far], { nowS: at, walkMps, bufferS: SETTINGS.boardBufferS, position: O })[0];
  // T: the instant the estimate's own countdown for the FIRST ride reads exactly "Leave in 5 min" (a bounded search
  // back from the train, whatever the estimate's walk works out to).
  let T = Number.NaN;
  for (let m = 1; m <= 240 && Number.isNaN(T); m += 1) {
    const at = first.depEpoch - m * 60;
    const c = cardAt(at);
    if (c?.status.kind === 'leave' && c.status.current.ride.depEpoch === first.depEpoch && heroOf(c.status, at).text === 'Leave in 5 min') T = at;
  }
  if (Number.isNaN(T)) fail('premise: within 4 h before the first ride the far trip counts down "Leave in 5 min" for it over the estimate');
  const estimated = cardAt(T);
  if (estimated?.status.kind !== 'leave') fail('premise: the far trip counts down at T over the estimate');
  const want = heroOf(estimated.status, T).text;
  const tree = await scene(far, T, fetchWalk);
  await settle();
  if (calls.length !== 0) fail(`a trip more than 2 km away asks the walk server for nothing (arbiter ruling), got ${calls.length} request(s)`);
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  const bar = button === undefined ? [] : linesOf(button);
  const heroes = hostsByTestID(tree.root, 'countdown-hero').map((h: any) => linesOf(h));
  const walkMin = estimated.walk?.minutes;
  if (show(bar) !== show(['Dadeland South', want]) || heroes.length !== 2 || heroes.some((h: string[]) => h[0] !== want || !(h[1] ?? '').endsWith(`a ${walkMin} min walk from here`))) fail(`a trip the rider is not near, at ${walkMps} m/s: the bar's countdown is the Trips tab's and the trip screen's, over the estimate (${show(['Dadeland South', want])}, cards "${want}" / "a ${walkMin} min walk from here"); got bar ${show(bar)}, cards ${show(heroes)}`);
  await unmountAll();
}

/**
 * B: every screen walks to the trip's BOARDING platform — never the station centre, never the other direction's
 * platform. Government Center -> Dadeland South boards southbound at 9512 only (6.4 m WEST of the centre; northbound
 * 9513 is 6.4 m EAST). The rider E stands due east of 9512 — 8 min 2 s of walking at the pace — so 9513 and the centre
 * are nearer, and the minutes split: 9 to 9512, 8 to the centre or 9513. The bar, both cards and tripCards walk to 9512.
 */
async function railPlatform(walkMps: number) {
  const { tripCards } = load('src/ui/trips/trip-card', ['tripCards']);
  const P9512 = platform('9512');
  const centre = db().realScheduleRepo().stations().find((s: any) => s.stationKey === GOV).coordinate;
  const minutesTo = (to: LL) => Math.ceil(Math.ceil((haversineMeters(E, to) * detour()) / walkMps) / 60);
  const eastM = ((8 * 60 + 2) * walkMps) / detour(); // the walk to 9512 is 8 min 2 s: 9 min; the centre and 9513 are 8
  const E: LL = { latitude: P9512.latitude, longitude: P9512.longitude + eastM / haversineMeters({ latitude: P9512.latitude, longitude: 0 }, { latitude: P9512.latitude, longitude: 1 }) };
  const want = minutesTo(P9512);
  if (!(minutesTo(centre) === want - 1 && minutesTo(platform('9513')) === want - 1)) fail(`premise: from E (${eastM.toFixed(1)} m east of 9512) at ${walkMps} m/s the walk to 9512 is a minute more than to the centre or to 9513: ${want} / ${minutesTo(centre)} / ${minutesTo(platform('9513'))}`);
  const rail = db().savedTrip('rail', GOV, DADS, { createdEpoch: 1_790_000_300 });
  const [card] = tripCards(db().realScheduleRepo(), [rail], { nowS: db().WED_0800, walkMps, bufferS: SETTINGS.boardBufferS, position: E });
  const walkS = Math.ceil((haversineMeters(E, P9512) * detour()) / walkMps);
  if (show(pick(card?.walk)) !== show({ source: 'estimated', from: 'here', walkS, minutes: want, stopId: '9512' })) fail(`tripCards walks a Government Center -> Dadeland South trip from E to its boarding platform 9512 (${walkS} s), never the centre or 9513: got ${show(pick(card?.walk))}`);
  oneWalk(`a rail trip from E at ${walkMps} m/s (the boarding platform 9512, not the centre or 9513)`, read(await scene(rail, db().WED_0800, null, 'regular', E)), want, true, 'from here');
  await unmountAll();
}

/**
 * E: the bar's VERDICT walks Jamie's STORED pace too — never hurryVerdict's module default (an omitted pace), never a
 * constant that turns the trip's own minutes into metres — for the estimate, the routed walk and the 7-minute
 * override. At `TV` every one has minutes to spare and its line moves with each minute of walk (premise), so a verdict
 * walked at any pace but the stored one reads differently: the bar's line 2 and its sentence must be the engine's
 * hurryVerdict over the one walk at `pace` (the contract: routed/estimated metres at Jamie's paces; an override walks
 * minutes x 60 s and jogs it in walkS x walkMps / jogMps).
 */
async function storedPaceVerdicts(TV: number, pace: { walkMps: number; jogMps: number }) {
  const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
  const runs: ['override' | 'routed' | 'estimated', any, boolean][] = [['estimated', here(), false], ['routed', here(), true], ['override', here({ walkOverrideMin: 7 }), false]];
  for (const [source, trip, routedKnown] of runs) {
    const want = expected(source, TV, pace, routedKnown ? fixture().routedM : undefined);
    const walkText = source === 'override' ? `${want.minutes} min walk` : `~${want.minutes} min walk`;
    const line = statusLine(want.verdict, want.ctx, walkText);
    const departures = want.rides.filter((r: any) => r.depEpoch >= TV).map((r: any) => ({ epoch: r.depEpoch, live: false, lineId: r.lineId, headsign: null }));
    for (const dS of [-60, 60]) {
      const off = hurryVerdict({ now: TV, walkMeters: (want.walkS + dS) * pace.walkMps, detour: 1, departures, ...pace });
      if (statusLine(off, want.ctx, walkText) === line) fail(`premise: at TV the ${source} line (${line}) moves with a minute of walk`);
    }
    const g = routedKnown ? fixture() : null;
    const tree = await scene(trip, TV, g === null ? null : g.fetchWalk);
    if (g !== null) await untilCalls(g.calls, 1);
    const seen = read(tree);
    if (show(seen.lines) !== show(['Bayfront Park', line])) fail(`${source} at Jamie's stored ${pace.walkMps} / ${pace.jogMps} m/s: the bar's verdict walks that pace (${show(['Bayfront Park', line])}), got ${show(seen.lines)}`);
    const sentence = copy('hurrySentence')(want.verdict, want.ctx);
    if (!seen.label.includes(sentence)) fail(`${source} at Jamie's stored ${pace.walkMps} / ${pace.jogMps} m/s: the bar's label says the verdict sentence at that pace ${show(sentence)}: ${show(seen.label)}`);
    await unmountAll();
  }
}

const CASES: Record<string, () => Promise<void>> = {
  // A. The precedence, by direct calls: override -> routed (from the rider) -> estimated; the rider first, the saved start without a fix.
  precedence: async () => {
    const { savedTripWalk } = load('src/ui/trips/trip-walk', ['savedTripWalk']);
    const P805 = platform('805'), P806 = platform('806');
    const platforms = [P805, P806]; // from O, 806 (144.07 m) is the nearer; from S1, 805 (100 m) is
    const S1: LL = { latitude: P805.latitude - 100 / perDeg, longitude: P805.longitude };
    const asked: string[] = [];
    // mfix9's WalkTo is asked with the stop itself (walkKey: its stop_id at its place); `asked` records the stop_ids.
    // walkKey parity: every ask must key the SAME cache entry as the schedule's platform of that stop_id — the right
    // stop_id at another place keys another entry (another stop's walk). `misplaced` records each ask that does not.
    const { walkKey } = load('src/domain/walk/walk-cache', ['walkKey']);
    if (walkKey({ ...P806, latitude: P806.latitude + 0.001 }) === walkKey(P806) || walkKey({ ...P806, stopId: '805' }) === walkKey(P806)) fail('premise: mfix9\'s walkKey keys a stop by its stop_id AND its place');
    const misplaced: string[] = [];
    const atItsPlace = (stop: any): any => {
      const p = typeof stop?.stopId === 'string' ? db().realScheduleRepo().platforms().find((x: any) => x.stopId === stop.stopId) : undefined;
      let why: string | null = typeof stop?.stopId !== 'string' ? 'not a WalkStop: it has no stopId (a raw stop_id string?)' : p === undefined ? 'no schedule platform has that stop_id' : null;
      try { if (why === null && walkKey(stop) !== walkKey(p)) why = `walkKey ${walkKey(stop)}, the platform's is ${walkKey(p)}`; } catch (e) { why = `walkKey refuses it: ${(e as Error).message.split('\n')[0]}`; }
      if (why !== null) misplaced.push(`${show(stop)} (${why})`);
      return p;
    };
    const routed = (stop: { stopId: string }) => { atItsPlace(stop); asked.push(stop?.stopId); return { walkMeters: 300, detour: 1, source: 'routed' }; };
    const estimate = (stop: { stopId: string }) => { const p = atItsPlace(stop); return { walkMeters: p === undefined ? 0 : haversineMeters(O, p), detour: detour(), source: 'estimated' }; };
    const est = (from: LL, p: any, mps: number) => Math.ceil((haversineMeters(from, p) * detour()) / mps);
    const walk = (source: string, from: string, walkS: number, stopId: string | null, minutes = Math.ceil(walkS / 60)) => ({ source, from, walkS, minutes, stopId });
    const none = { start: null, walkOverrideMin: null };
    const table: [string, any, any, any][] = [
      ['an override beats a known routed walk', { start: null, walkOverrideMin: 7 }, { platforms, position: O, walkMps: 1.35, walk: routed }, walk('override', 'setting', 420, null, 7)],
      ['an override needs no position', { start: null, walkOverrideMin: 7 }, { platforms, position: null, walkMps: 1.35 }, walk('override', 'setting', 420, null, 7)],
      ['a 0-minute override is 0 minutes', { start: null, walkOverrideMin: 0 }, { platforms, position: O, walkMps: 1.35, walk: routed }, walk('override', 'setting', 0, null, 0)],
      ['routed to the nearest boarding platform', none, { platforms, position: O, walkMps: 1.35, walk: routed }, walk('routed', 'here', Math.ceil(300 / 1.35), '806')],
      ['routed at the pace passed in', none, { platforms, position: O, walkMps: 1.1, walk: routed }, walk('routed', 'here', Math.ceil(300 / 1.1), '806')],
      ['an estimated WalkEstimate is the estimate', none, { platforms, position: O, walkMps: 1.35, walk: estimate }, walk('estimated', 'here', est(O, P806, 1.35), '806')],
      ['no routed walk at all: the estimate', none, { platforms, position: O, walkMps: 1.35 }, walk('estimated', 'here', est(O, P806, 1.35), '806')],
      ['the estimate at the pace passed in', none, { platforms, position: O, walkMps: 1.1 }, walk('estimated', 'here', est(O, P806, 1.1), '806')],
      ['a saved start, the rider located: the rider\'s walk', { start: S1, walkOverrideMin: null }, { platforms, position: O, walkMps: 1.35, walk: routed }, walk('routed', 'here', Math.ceil(300 / 1.35), '806')],
      ['a saved start, no fix: the estimate from the start', { start: S1, walkOverrideMin: null }, { platforms, position: null, walkMps: 1.35, walk: routed }, walk('estimated', 'start', est(S1, P805, 1.35), '805')],
      ['no override, no start, no fix: no walk', none, { platforms, position: null, walkMps: 1.35, walk: routed }, null],
    ];
    for (const [name, trip, input, want] of table) {
      asked.length = 0;
      misplaced.length = 0;
      let got: unknown;
      let threw: string | null = null;
      try { got = savedTripWalk(trip, input); } catch (e) { threw = (e as Error).message.split('\n')[0] ?? ''; }
      if (misplaced.length > 0) fail(`${name}: mfix9's WalkTo is asked with the boarding platform itself — its stop_id AT ITS PLACE (walkKey parity with the schedule's platform ${show(want?.stopId ?? null)}); asked with ${misplaced.join('; ')}`);
      if (threw !== null) fail(`${name}: savedTripWalk threw ${threw}`);
      if (show(pick(got)) !== show(want)) fail(`${name}: want ${show(want)}, got ${show(pick(got))}`);
      if (want?.source === 'routed' && show(asked) !== show(['806'])) fail(`${name}: the routed walk is asked for the chosen platform only (["806"]), asked ${show(asked)}`);
    }
    // A rail station: the walk goes to the boarding PLATFORM (9512, 6.4 m west of the centre), never the station centre.
    const rail = savedTripWalk(none, { platforms: platformsOf(GOV), position: W, walkMps: 1.35 });
    if (show(pick(rail)) !== show(walk('estimated', 'here', est(W, platform('9512'), 1.35), '9512'))) fail(`from W the walk goes to platform 9512 (${est(W, platform('9512'), 1.35)} s), not the Government Center centre (${est(W, { latitude: 25.7760455, longitude: -80.1960935 }, 1.35)} s); got ${show(pick(rail))}`);
  },
  // B + C. ONE walk for a saved trip on the REAL bar, Trips tab and trip screen, for each source, plus the cards' leave-by.
  consistency: async () => {
    const T = fixtureInstant();
    const pace = { walkMps: 1.35, jogMps: 2.7 };
    // The override first: the bar today ignores it (trip-verdict.ts:73-78).
    oneWalk('override 7 min, no routed walk', read(await scene(here({ walkOverrideMin: 7 }), T, null)), 7, false, '(your setting)');
    await unmountAll();
    oneWalk('estimated (no walk provider)', read(await scene(here(), T, null)), expected('estimated', T, pace).minutes, true, 'from here');
    await unmountAll();
    const f = fixture();
    const routedTree = await scene(here(), T, f.fetchWalk);
    await untilCalls(f.calls, 1);
    if (f.calls.length !== 1) fail(`the bar, the Trips tab and the trip screen share ONE routed-walk request (mfix9's batching), got ${f.calls.length}`);
    oneWalk('routed (the fixture)', read(routedTree), expected('routed', T, pace, f.routedM).minutes, true, 'from here');
    await unmountAll();
    const g = fixture();
    const overTree = await scene(here({ walkOverrideMin: 7 }), T, g.fetchWalk);
    await untilCalls(g.calls, 1);
    oneWalk('override 7 min while a routed walk is known', read(overTree), 7, false, '(your setting)');
    await unmountAll();
    // The cards' leave-by counts down with the SAME walk (m7a's nextLeave over the trip's rides, the 120 s buffer).
    const { tripCards } = load('src/ui/trips/trip-card', ['tripCards']);
    const { nextLeave } = load('src/domain/trips/leave-by', ['nextLeave']);
    const routedWalk = (stop: { stopId: string }) => (stop.stopId === '805' ? { walkMeters: f.routedM, detour: 1, source: 'routed' } : { walkMeters: haversineMeters(O, platform(stop.stopId)), detour: detour(), source: 'estimated' }); // mfix9's WalkTo
    const runs: [string, any, unknown, 'override' | 'routed' | 'estimated'][] = [['override', here({ walkOverrideMin: 7 }), routedWalk, 'override'], ['routed', here(), routedWalk, 'routed'], ['estimated', here(), undefined, 'estimated']];
    for (const [name, trip, w, source] of runs) {
      const want = expected(source, T, pace, f.routedM);
      const input = { nowS: T, walkMps: pace.walkMps, bufferS: SETTINGS.boardBufferS, position: O, ...(w === undefined ? {} : { walk: w }) };
      const [card] = tripCards(db().realScheduleRepo(), [trip], input);
      const plan = nextLeave(want.rides, T, want.walkS, SETTINGS.boardBufferS);
      if (card?.walk?.source !== source || card.walk.walkS !== want.walkS || card.walk.minutes !== want.minutes) fail(`${name}: tripCards' walk is savedTripWalk's {source ${source}, walkS ${want.walkS}, minutes ${want.minutes}}, got ${show(pick(card?.walk))}`);
      if (plan === null || card.status.kind !== 'leave' || card.status.current.leaveByEpoch !== plan.leaveByEpoch) fail(`${name}: the card's leave-by counts down with the one walk (${want.walkS} s + ${SETTINGS.boardBufferS} s buffer -> leave-by ${plan?.leaveByEpoch}), got ${show(card?.status.kind === 'leave' ? card.status.current.leaveByEpoch : card?.status)}`);
    }
    await farCountdown(pace.walkMps);
    await railPlatform(pace.walkMps);
    // The walk follows the rider's LATEST fix: the scene starts at P (100 m due south of 805), then the one watch
    // reports a newer fix at O. Before the move the bar and both cards walk from P; after it, every screen walks from
    // O — never from a fix older than the one the bar's plan and verdict are judged from.
    const P: LL = { latitude: platform('805').latitude - 100 / perDeg, longitude: platform('805').longitude };
    const fromP = Math.ceil(Math.ceil((haversineMeters(P, platform('805')) * detour()) / pace.walkMps) / 60);
    const fromO = expected('estimated', T, pace).minutes;
    if (fromP === fromO) fail(`premise: the walk from P (${fromP} min) differs from the walk from O (${fromO} min)`);
    const moving = await scene(here(), T, null, 'regular', P);
    oneWalk('estimated from the first fix P (100 m south of 805)', read(moving), fromP, true, 'from here');
    await moveTo(O);
    oneWalk('estimated after the rider moved from P to O (the watch\'s newer fix; P is stale)', read(moving), fromO, true, 'from here');
    await unmountAll();
  },
  // E. The pace: savedTripWalk never supplies one; Jamie's STORED pace reaches the bar, both cards and the reminders.
  pace: async () => {
    const { savedTripWalk } = load('src/ui/trips/trip-walk', ['savedTripWalk']);
    for (const bad of [undefined, 0, Number.NaN, -1.35]) {
      let threw = false;
      try { savedTripWalk({ start: null, walkOverrideMin: null }, { platforms: [platform('805')], position: O, walkMps: bad }); } catch { threw = true; }
      if (!threw) fail(`savedTripWalk(..., { walkMps: ${String(bad)} }) must throw: a walk without Jamie's pace never falls back to a module default`);
    }
    const { saveWalkingPace, readWalkingPace } = load('src/ui/settings/walking-pace', ['saveWalkingPace', 'readWalkingPace']);
    const pace = { walkMps: 1.1, jogMps: 2.2 };
    const saved = saveWalkingPace(pace);
    if (!saved.ok || readWalkingPace().walkMps !== 1.1) fail(`premise: Jamie's pace 1.1 / 2.2 m/s is stored and read back, got ${show(saved)}`);
    const T = fixtureInstant();
    const est = expected('estimated', T, pace);
    if (est.minutes === expected('estimated', T, { walkMps: 1.35, jogMps: 2.7 }).minutes) fail('premise: the stored pace changes the estimated minutes');
    oneWalk('estimated at Jamie\'s stored 1.1 m/s', read(await scene(here(), T, null)), est.minutes, true, 'from here');
    await unmountAll();
    const f = fixture();
    const routedTree = await scene(here(), T, f.fetchWalk);
    await untilCalls(f.calls, 1);
    oneWalk('routed at Jamie\'s stored 1.1 m/s', read(routedTree), expected('routed', T, pace, f.routedM).minutes, true, 'from here');
    await unmountAll();
    await farCountdown(pace.walkMps);
    await railPlatform(pace.walkMps);
    // The bar's VERDICT walks the stored pace for every source (T - 470: the first 805 ride - 900 s).
    await storedPaceVerdicts(T - 470, pace);
    // The reminder sync reads the stored pace too (ReminderSync.syncReminders -> reminderCandidates).
    const fixed = db().savedTrip('fixed', GOV, DADS, { start: W, reminder: { days: 0b0011111, atMin: 8 * 60 + 30 } });
    const got = await syncedLeaveBys([fixed]);
    const walkS = Math.ceil((haversineMeters(W, platform('9512')) * detour()) / pace.walkMps);
    if (got.length < 3 || got.some((r) => r.leaveByEpoch !== r.departureEpoch - walkS - SETTINGS.boardBufferS)) fail(`the reminders walk from the saved start to 9512 at Jamie's stored 1.1 m/s (${walkS} s): want leave-by = departure - ${walkS} - ${SETTINGS.boardBufferS}, got ${show(got.slice(0, 3))}`);
  },
  // D. The copy: the bar's visible walk and its VoiceOver phrase per source; the card's phrase.
  copy: async () => {
    const T = fixtureInstant();
    const pace = { walkMps: 1.35, jogMps: 2.7 };
    // The override first (no provider): the bar today walks the estimate and ignores it. mfix9's fixture is read only for a routed walk.
    const runs: ['override' | 'routed' | 'estimated', any, boolean][] = [['override', here({ walkOverrideMin: 7 }), false], ['estimated', here(), false], ['routed', here(), true], ['override', here({ walkOverrideMin: 7 }), true]];
    for (const [source, trip, routedKnown] of runs) {
      const name = `${source}${routedKnown ? ' (a routed walk known)' : ''}`;
      const want = expected(source, T, pace, routedKnown ? fixture().routedM : undefined);
      const walkText = source === 'override' ? `${want.minutes} min walk` : `~${want.minutes} min walk`;
      const lines = ['Bayfront Park', statusLine(want.verdict, want.ctx, walkText)];
      const g = routedKnown ? fixture() : null;
      const tree = await scene(trip, T, g === null ? null : g.fetchWalk);
      if (g !== null) await untilCalls(g.calls, 1);
      const seen = read(tree);
      if (show(seen.lines) !== show(lines)) fail(`${name}: the bar reads ${show(lines)}, got ${show(seen.lines)}`);
      if (!seen.label.includes(copy('hurrySentence')(want.verdict, want.ctx))) fail(`${name}: the label says the verdict sentence ${show(copy('hurrySentence')(want.verdict, want.ctx))}: ${show(seen.label)}`);
      const N = want.minutes;
      const says = { estimated: seen.label.includes(`an estimated ${N}-minute walk`), streets: new RegExp(`\\b${N}-minute walk along streets`, 'i').test(seen.label), yours: seen.label.includes(`your ${N}-minute walk`), anyEstimated: /\bestimated\b/i.test(seen.label), anyStreets: /walk along streets/i.test(seen.label), anyYours: /\byour \d+-minute walk/i.test(seen.label) };
      const right = source === 'estimated' ? says.estimated && !says.anyStreets && !says.anyYours : source === 'routed' ? says.streets && !says.anyEstimated && !says.anyYours : says.yours && !says.anyEstimated && !says.anyStreets;
      if (!right) fail(`${name}: VoiceOver says ${source === 'estimated' ? `"an estimated ${N}-minute walk"` : source === 'routed' ? `"${N}-minute walk along streets"` : `"your ${N}-minute walk"`} and neither of the other two phrases: ${show(seen.label)}`);
      const card = seen.cardTexts.find((t) => t.includes(' min walk ')) ?? '';
      if (!card.includes(`· a ${N} min walk ${source === 'override' ? '(your setting)' : 'from here'}`) || card.includes('~')) fail(`${name}: the card says "a ${N} min walk ${source === 'override' ? '(your setting)' : 'from here'}" (no "~"): ${show(seen.cardTexts)}`);
      await unmountAll();
      const h = routedKnown ? fixture() : null;
      const inlineTree = await scene(trip, T, h === null ? null : h.fetchWalk, 'inline');
      if (h !== null) await untilCalls(h.calls, 1);
      const inline = read(inlineTree).lines;
      if (show(inline) !== show([copy('hurryInline')(want.verdict, want.ctx)])) fail(`${name}, inline: the bar reads [${show(copy('hurryInline')(want.verdict, want.ctx))}] (the verdict over the one walk), got ${show(inline)}`);
      await unmountAll();
    }
    // The card's third phrase: a trip with a saved start S, read before the first fix, walks from S to 805 (the estimate).
    const S: LL = { latitude: platform('805').latitude - 300 / perDeg, longitude: platform('805').longitude };
    const fromStart = Math.ceil(Math.ceil((haversineMeters(S, platform('805')) * detour()) / pace.walkMps) / 60);
    const cards = read(await scene(here({ start: S }), T, null, 'regular', null)).cards;
    if (cards.length !== 2 || cards.some((c) => c.minutes !== fromStart || c.from !== 'from your start')) fail(`a saved start with no fix: both cards say "a ${fromStart} min walk from your start", got ${show(cards)}`);
    await unmountAll();
  },
  // B. Reminders (no live position): the override, else the walk from the trip's saved start (the estimate: the
  // routed walk walks from the rider), else no reminder — through savedTripWalk, at Jamie's pace.
  reminder: async () => {
    const { reminderCandidates } = load('src/ui/trips/reminder-candidates', ['reminderCandidates']);
    const repo = db().realScheduleRepo();
    const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
    const rides = repo.tripRides(GOV, DADS, windowFrom(db().WED_0800, 3 * 3600));
    if (!rides.ok || rides.value.kind !== 'rides' || rides.value.rides.some((r: any) => r.boardStopId !== '9512')) fail('premise: Government Center -> Dadeland South boards at platform 9512 only');
    const centre = repo.stations().find((s: any) => s.stationKey === GOV).coordinate;
    if (!(haversineMeters(W, centre) - haversineMeters(W, platform('9512')) > 5)) fail('premise: W is > 5 m nearer 9512 than the station centre');
    const remind = { reminder: { days: 0b0011111, atMin: 8 * 60 + 30 } };
    const fixed = db().savedTrip('fixed', GOV, DADS, { start: W, ...remind });
    const minutes = db().savedTrip('minutes', GOV, DADS, { start: W, walkOverrideMin: 6, ...remind });
    const roaming = db().savedTrip('roaming', GOV, DADS, remind);
    const walkS = Math.ceil((haversineMeters(W, platform('9512')) * detour()) / 1.35);
    const check = (where: string, got: { tripId: string; departureEpoch: number; leaveByEpoch: number }[]) => {
      const of = (id: string) => got.filter((c) => c.tripId === id);
      if (of('fixed').length < 3 || of('fixed').some((c) => c.leaveByEpoch !== c.departureEpoch - walkS - 120)) fail(`${where}: a trip with a saved start walks from it to platform 9512 (${walkS} s at 1.35 m/s, rounded up), not to the station centre: want leave-by = departure - ${walkS} - 120, got ${show(of('fixed').slice(0, 3))}`);
      if (of('minutes').length < 3 || of('minutes').some((c) => c.leaveByEpoch !== c.departureEpoch - 360 - 120)) fail(`${where}: the override (6 min) beats the saved start: want leave-by = departure - 360 - 120, got ${show(of('minutes').slice(0, 3))}`);
      if (of('roaming').length !== 0) fail(`${where}: a trip with neither an override nor a saved start has no fixed walk, so no reminder (m7b), got ${show(of('roaming'))}`);
    };
    check('reminderCandidates', reminderCandidates(repo, [fixed, minutes, roaming], { nowS: db().WED_0800, walkMps: 1.35, bufferS: 120 }));
    check('the reminder sync (Jamie\'s default pace, nothing stored)', await syncedLeaveBys([fixed, minutes, roaming]));
  },
};
/** The scheduled reminders after ReminderSync.syncReminders over the real schedule at Wed 08:00 (lead 0). */
async function syncedLeaveBys(tripsToSync: unknown[]) {
  const { syncReminders } = load('src/ui/trips/ReminderSync', ['syncReminders']);
  const { ReminderStatusStore } = load('src/ui/trips/reminder-status', ['ReminderStatusStore']);
  mockPending = [];
  const status = new ReminderStatusStore();
  await syncReminders({ repo: db().realScheduleRepo(), trips: tripsToSync, settings: SETTINGS, nowS: db().WED_0800 }, mockNotifications(), status);
  if (status.read() !== null) fail(`the reminder sync reported a problem: ${show(status.read())}`);
  return mockPending.map((p) => ({ tripId: String(p.content?.data?.tripId), departureEpoch: Number(p.content?.data?.departureEpoch), leaveByEpoch: Number(p.content?.data?.leaveByEpoch) }));
}
it('ratchet oracle', async () => {
  const run = CASES[CASE];
  if (run === undefined) fail('unknown oracle case');
  await run();
  expect(CASE.length).toBeGreaterThan(0);
}, 300_000); // real-DB renders of three screens per source: never trip jest's 5 s default on a busy machine
TSX
  out=$(MFIX11_CASE="$which" local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.tsx' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 -o "ratchet-oracle:.*"; else echo "$out" | tail -25; fi
    echo "ratchet: mfix11 oracle '$which' failed"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the mfix11 oracle '$which' did not run"; return 1; }
  echo "ratchet: mfix11 oracle '$which' holds on the shipped app"
}


# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix11_one_walk gate failed at verify script line $LINENO"' ERR

# --- (A) One function decides a saved trip's walk: override -> routed -> estimated -------------------------------
# 1. Oracle, direct calls of src/ui/trips/trip-walk.ts savedTripWalk: the override beats a known routed walk and needs no position (7 -> 420 s, 7 min; 0 -> 0); routed = ceil(walkMeters / walkMps) to the platform NEAREST the origin (806 from O), asked for that platform only, with the platform itself at its place (walkKey parity with the schedule's platform: a raw stop_id, or the right stop_id at another place, fails — also for the estimated WalkEstimate); an estimated WalkEstimate, or no walk function, is ceil(straight x HURRY_DEFAULTS.detour / walkMps); the pace passed in is the pace walked (1.1 m/s); a saved start yields to the rider's position, and without a fix the walk is the estimate from the start (805 from S1, 'start'); no override, no start, no fix -> null; at a rail station the walk goes to the boarding platform (Government Center 9512), never the station centre.
mfix11_oracle precedence
# 2. One passing test (src/ui/trips/__tests__/trip-walk.test.ts).
jest_cases "$MFIX11_WALK_TEST" 'a saved trip walks its override, else the routed walk, else the estimate'

# --- (B, C) Every place that shows or uses a saved trip's walk shows the same one -------------------------------
# 3. Oracle, ONE tree of the REAL Now bar + Trips tab + trip screen (saved trip Fifth Street -> Bayfront Park, rider at stop 815, T = the first 805 ride - 430 s): the bar's "~N min walk" / "N min walk" equals both cards' "a N min walk ..." for the override 7 min (no provider: 7, no "~", "(your setting)"), the estimate (no provider: 6, "from here"), the routed fixture (mfix9's provider, exactly ONE request for all three screens: 9) and the override while a routed walk is known (7); and tripCards' walk is savedTripWalk's (source, walkS 420 / 527 / 330, minutes) with the leave-by m7a's nextLeave gives that walk + the 120 s buffer. And for a trip the rider is NOT near (Vizcaya -> Dadeland South, its origin more than 2 km away: arbiter ruling, no street walk is asked for it, so the oracle's injected fetchWalk gets no request), the bar's countdown ("Leave in N min", from the home context's cards) is the Trips tab's and the trip screen's hero over the estimate; and a Government Center -> Dadeland South trip walks to its boarding platform 9512 (not the centre, not northbound 9513) on the bar, both cards and in tripCards, from a rider due east where the minutes split; and when the one watch reports a newer fix (the rider moves from P, 100 m due south of 805, to O: 2 min -> 6 min) the bar and both cards walk from the LATEST fix, never the first one seen.
mfix11_oracle consistency
# 4. One passing test (src/ui/trips/__tests__/one-walk.test.tsx).
jest_cases "$MFIX11_ONE_WALK_TEST" 'the bar and the trip card show the same walk for every source'

# --- (E) Jamie's pace, never a module default --------------------------------------------------------------------
# 5. Oracle: savedTripWalk throws without a usable walkMps (undefined, 0, NaN, negative); with Jamie's pace STORED at 1.1 / 2.2 m/s (the real saveWalkingPace), the bar and both cards walk it (estimated 7 min, routed 11 min, where 1.35 gives 6 and 9), so do the bar's countdown for a trip the rider is not near and the rail platform run (gate 3's, at 1.1 m/s); the bar's VERDICT walks the stored 1.1 / 2.2 m/s too — line 2 and the label's sentence are the engine's hurryVerdict over the one walk at that pace for the estimate, the routed walk and the 7-minute override (minutes x 60 s, jogged at walkS x walkMps / jogMps), at the first 805 ride - 900 s, where each minute of walk changes the line (so hurryVerdict's module default pace, or a constant pace turning the override into metres, reads differently); and the reminder sync's leave-bys walk from the saved start at 1.1 m/s.
mfix11_oracle pace
# 6. Grep: trip-walk.ts never supplies a pace (no default, no settings read); no app file leans on PLANNING_WALK_MPS (outside walk-estimate.ts), the settings' DEFAULT_* (outside src/ui/settings) or HURRY_DEFAULTS.walkMps/jogMps; every app caller of tripCards / reminderCandidates / tripVerdict / judgeTrip / savedTripWalk reads readWalkingPace(), and at least four app files call one (the Trips tab, the home context, the reminder sync and the bar's verdict hook src/ui/hurry/useHurryVerdict.ts, which judges through judgeTrip).
pace_wiring
# 7. One passing test (src/ui/trips/__tests__/trip-walk.test.ts).
jest_cases "$MFIX11_WALK_TEST" 'the walk never falls back to a module default pace'

# --- (E) No second walk computation survives ----------------------------------------------------------------------
# 8. Grep: estimateWalk / walkSeconds / PLANNING_WALK_MPS / WALK_DETOUR only in walk-estimate.ts; tripWalk / TripWalk gone; savedTripWalk defined once (trip-walk.ts) and called by trip-card.ts and reminder-candidates.ts, and the bar's trip-verdict.ts walks it; those three measure nothing themselves (no nearestPlatform / haversineMeters / HURRY_DEFAULTS / walkFor); no walkS / 60 in now-strip.ts or trip-copy.ts; src/ui/trips reads useWalkTo(...).
old_walk_sites

# --- (D) Copy: the visible walk and its VoiceOver phrase per source -----------------------------------------------
# 9. Oracle, the REAL bar per source (override without and with a routed walk known, estimated, routed): line 2 is exactly the richest "<short> · ~N min walk" (override: "· 7 min walk", no "~") that fits; the label holds the verdict sentence and "an estimated N-minute walk" ONLY for estimated, "N-minute walk along streets" ONLY for routed, "your N-minute walk" ONLY for the override; inline is [hurryInline] of the verdict over the one walk; the card says "a N min walk from here" / "a 7 min walk (your setting)", and, for a trip with a saved start read before the first fix, "a N min walk from your start".
mfix11_oracle copy
# 10. One passing test (src/ui/now/__tests__/override-walk-bar.test.tsx).
jest_cases "$MFIX11_BAR_TEST" 'an override walk shows without a tilde and is voiced as your walk'

# --- (B) Reminders: the rule this card pins -----------------------------------------------------------------------
# 11. Oracle, Government Center -> Dadeland South (boards 9512, 6.4 m west of the centre), reminders Mon-Fri 08:30, synced at Wed 08:00: a saved start W (480 m west) walks ceil(|W -> 9512| x 1.3 / 1.35) = 457 s (today: |W -> centre|, rounded, 462 s); an override (6 min) beats the start (360 s); a trip with neither gets no reminder — for reminderCandidates and for ReminderSync.syncReminders end to end (leave-by = departure - walk - 120 s).
mfix11_oracle reminder
# 12. One passing test (src/ui/trips/__tests__/reminder-walk.test.ts).
jest_cases "$MFIX11_REMINDER_TEST" 'reminders walk the override, else from the saved start, else none'

# --- Earlier cards stay as they were (re-checks, guarded on this card's files) -----------------------------------
# 13. m7b: a week of reminders for a fixed walk, none for a trip without one; mfix9: only an estimated walk is labelled estimated; mfix6: one location watch.
after_card jest_nonempty src/ui/trips/__tests__/notifications.test.ts 'plans a week of weekday reminders for a trip with a fixed walk, and none for one without$'
after_card jest_nonempty src/ui/now/__tests__/routed-walk-bar.test.tsx 'only an estimated walk is labelled estimated$'
after_card jest_nonempty src/ui/location/__tests__/one-watch.test.tsx 'the real app opens exactly one location watch$'
# 14. The card's tests mock only native packages, each labelled (mfix6's helper).
after_card mocks_native_only src/ui/trips/__tests__
after_card mocks_native_only src/ui/now/__tests__

# --- Repo-wide ----------------------------------------------------------------------------------------------------
# 15. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every test), node:test — all green.
card_full_gate
# 16. (guarded) Metro bundles the app for iOS on a private cache (TMPDIR=.cache/metro-tmp-mfix11).
card_ios_export

echo "mfix11_one_walk: all 19 gate lines green"
