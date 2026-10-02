#!/usr/bin/env bash
# mfix9_routed_walk — every hurry verdict walks a ROUTED street distance when one is known (Jamie 2026-10-02 09:12,
# two screenshots: "Also says chill pace for getting to fifth but estimated walk time from Google Maps would put me
# at 1 min after scheduled arrival"). The Now bar read "Missed · next 9:22 · chill · Fifth Street" at 9:12; Google:
# walk 11 min, 0.5 mi. The engine walked the straight line x 1.3 (476 s); Transitous's one-to-many walk was 789.5 m,
# 1.60 x the straight line (585 s at Jamie's pace, > the 570 s slack). One request to Transitous's one-to-many
# endpoint gives the walking distance to every wanted platform; the verdict walks `distance` at the rider's pace.
# Builds on mfix8_trip_bar (the Now bar's near-trip verdict, hurryShort/hurryInline, "~N min walk", the VoiceOver
# label, CHIP_ROUTED_START_M = 50 and firstLegVerdict's opt-in routed walk) and on mfix8's fix round (ARBITER RULING F2:
# useChipPosition follows the rider for EVERY plan, position = rider.coordinate ?? start). Today (main 0451a6c, mfix8
# built, before its fix round) there is no src/domain/walk and no RoutedWalkProvider.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not stop
# the script); compound checks live inside the card helpers below. Helpers read no variable another gate set.
# NO NETWORK in any gate: the oracles inject fetchWalk; the fixture is committed. Run one gate alone, from the repo
# root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix9_routed_walk.sh
#
# BINDING CONTRACT (the oracles load these by path and name; a parallel copy elsewhere cannot satisfy them):
#   src/domain/routes/transitous.ts  export function transitousUserAgent(appVersion): string — m10a's exact User-Agent
#                                    ("MiamiTransit/<version> (+<APP_REPO_URL>)"), which buildPlanRequest now uses too
#   src/domain/walk/one-to-many.ts   export const WALK_ROUTER_URL = 'https://api.transitous.org/api/v1/one-to-many',
#                                    WALK_MAX_TARGETS = 128, WALK_MAX_S = 3600, WALK_MATCH_M = 250
#                                    export function buildWalkRequest(from: LatLon, targets: readonly LatLon[],
#                                      appVersion: string): Result<{ url, headers }, …> — never throws
#                                    export type WalkPath = { distanceM: number; costS: number }
#                                    export function parseWalkTimes(json: unknown, n: number):
#                                      Result<readonly (WalkPath | null)[], …> — never throws
#   src/domain/walk/walk-cache.ts    export const REFRESH_MOVE_M = 150, MIN_REQUEST_GAP_S = 60, BACKOFF_MAX_S = 600,
#                                    STALE_ORIGIN_M = 300
#                                    export type WalkStop = { stopId: string; latitude: number; longitude: number } (a Platform fits)
#                                    export function walkKey(stop: WalkStop): string — the GTFS stop_id AND the stop's coordinates
#                                      rounded to 5 decimals (ARBITER FIX ROUND Q5: two feeds' stops sharing a raw stop_id never
#                                      share a walk)
#                                    export type WalkCache = { lastRequestAtS: number; entries: ReadonlyMap<string /* walkKey */,
#                                      { path: WalkPath | null; origin: LatLon; straightAtOrigin: number; requestedAtS: number }> }
#                                    export function mergeWalks(cache: WalkCache | null, answer: { origin: LatLon; requestedAtS: number;
#                                      stops: readonly WalkStop[]; paths: readonly (WalkPath | null)[] }): WalkCache — ARBITER FIX ROUND
#                                      Q1 (amends "its answer becomes the cache"): the answer's stops' entries are replaced and every
#                                      other entry stays, unless it was asked more than STALE_ORIGIN_M from the answer's origin
#                                    export function dropStaleWalks(cache: WalkCache, position: LatLon): WalkCache — drops the entries
#                                      asked more than STALE_ORIGIN_M from the rider
#                                    export type WalkEstimate = { walkMeters: number; detour: number; source: 'routed' | 'estimated' }
#                                    export function needsWalkRequest(cache: WalkCache | null, position: LatLon, nowS: number,
#                                      wanted: readonly WalkStop[], backoffUntilS: number): boolean — per entry (Q1): a wanted stop
#                                      with no entry, or whose entry was asked more than REFRESH_MOVE_M from the rider
#                                    export function walkFor(cache: WalkCache | null, stop: WalkStop, position: LatLon): WalkEstimate
#                                      — scaled by the stop's OWN entry's origin
#   src/ui/walk/RoutedWalkProvider.tsx export function RoutedWalkProvider({ children, fetchWalk? }); its default fetchWalk is
#                                    src/live/http.ts's EXPO_FETCH (imported) under the provider's own abort timer and typed
#                                    LiveErrors (http.ts's httpGet is typed to the realtime providers)
#                                    export type WalkFetch = (request: { url: string; headers: Readonly<Record<string, string>> },
#                                      signal: AbortSignal) => Promise<Result<unknown /* the parsed JSON body */, LiveError>>
#                                    export function useWalkTo(stops: readonly WalkStop[]): (stop: WalkStop) => WalkEstimate
#                                      (Q5: a walk is looked up by the stop itself — its stop_id AT its place — never a raw stop_id)
#                                    Its clock is the wall clock (Date.now, which the oracles' fake timers drive).
#   src/ui/routes/route-options.ts   OptionContext gains walk?: (stop: WalkStop) => WalkEstimate (stop = the first ride's boarding
#                                    stop: gtfsStopId(from.stopId) at from's coordinates); used whenever no whole routed first walk
#                                    applies: OFF the plan start (> CHIP_ROUTED_START_M), or AT it when a WALK leg before the first
#                                    ride carries no distanceM (ARBITER FIX ROUND Q4)
#   src/ui/routes/use-route-plan.ts  useChipPosition: the rider's fix for EVERY plan, else the plan's start (mfix8 F2)
#   src/ui/routes/PlanScreen.tsx     registers its itineraries' first-ride boarding stops through useWalkTo for EVERY plan
#                                    while the rider has a fix ("Route from here" and a plan from the rider's own location)
#   src/ui/now/near-trip-walk.ts     export function useNearTripWalk — the Now bar's useWalkTo (its near trip's origin platforms)
#   src/app/_layout.tsx              <UserLocationProvider> … <RoutedWalkProvider> … </RoutedWalkProvider> … </UserLocationProvider>
#   VoiceOver: the bar's label says "estimated" ONLY for an estimated walk; a routed walk's label says "walk along streets".
#
# TEST-NAME CONVENTION (verify-mfix6's): each acceptance case is its OWN passing jest test whose full name (describe
# titles + test title, one space, case-insensitive) ENDS with the case's exact phrase at a word boundary.
MFIX9_JEST_CASES=(
  'the fixture walk says jog where the estimate says chill'
  'without a provider the walk is the estimated fallback'
  'routed walk requests are few, batched and backed off'
  'the bar walks the routed fixture distance instead of the estimate'
  'only an estimated walk is labelled estimated'
  'the station sheet walks the routed fixture distance instead of the estimate'
  'a rider 300 m off the plan start gets the routed walk'
  'alternating stop sets, the rider still for 10 minutes, cost exactly 2 requests'
  '130 wanted stops, the rider jittering 3 m for 10 minutes, ask nothing after the first round'
  'moving 200 m refreshes the wanted stops, and entries from more than 300 m back are dropped'
  'a throwing answer handler reaches the bug channel'
  "at the plan start a first walk missing a leg distance walks the boarding stop's routed walk"
  'reads an answer for a count of targets no request carries as an Err, never a throw'
  'refuses a walk with any key besides its distance and duration, and still reads {} as no walk'
  'an entry whose only key is empty is an Err, never a throw'
  "an abandoned request's late answer is dropped quietly"
  'a walk bug after the provider unmounts still reaches the bug channel'
  'diagnostics shows the live runtime internal error and the routed walks status'
)
# The card's own test files and the committed fixture (the guard for the repo-wide gates and the re-checks).
MFIX9_CLIENT_TEST=src/domain/walk/__tests__/one-to-many.test.ts
MFIX9_CACHE_TEST=src/domain/walk/__tests__/walk-cache.test.ts
MFIX9_PROVIDER_TEST=src/ui/walk/__tests__/RoutedWalkProvider.test.tsx
MFIX9_BAR_TEST=src/ui/now/__tests__/routed-walk-bar.test.tsx
MFIX9_SHEET_TEST=src/ui/hurry/__tests__/routed-walk-sheet.test.tsx
MFIX9_CHIP_TEST=src/ui/routes/__tests__/routed-walk-chip.test.tsx
MFIX9_FIXTURE=src/domain/walk/__fixtures__/transitous-one-to-many.json
# Arbiter fix rounds (Q1-Q8, then Z1-Z5): the churn, bug-channel and Diagnostics tests.
MFIX9_CHURN_TEST=src/ui/walk/__tests__/walk-churn.test.tsx
MFIX9_BUGS_TEST=src/ui/walk/__tests__/walk-bugs.test.tsx
MFIX9_DIAG_TEST=src/ui/diagnostics/__tests__/internal-error.test.tsx

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied from verify-mfix6_one_location_watch.sh (only the card universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX9_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix9_routed_walk.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX9_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX9_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX9_JEST_CASES[@]}" || return 1
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

# The card's own test files and fixture: the guard for the repo-wide gates and the re-checks (a bare full_gate is
# green on the unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files "$MFIX9_CLIENT_TEST" "$MFIX9_CACHE_TEST" "$MFIX9_PROVIDER_TEST" "$MFIX9_BAR_TEST" "$MFIX9_SHEET_TEST" "$MFIX9_CHIP_TEST" "$MFIX9_FIXTURE" || return 1
}

# after_card <gate> <args>... — a re-check run only WITH this card's files (copied from verify-mfix8_trip_bar.sh).
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

# card_export_carries <text> — copied from verify-mfix8_trip_bar.sh (private cache and output dir renamed): guarded on
# this card's files, Metro bundles the app for iOS (lib.sh ios_export) on a PRIVATE Metro cache (TMPDIR), then a
# --no-bytecode export (never a .hbc grep: Hermes bytecode stores strings in its own table) must carry <text> as a
# whole string literal.
card_export_carries() {
  local text="$1" metro_tmp="$PWD/.cache/metro-tmp-mfix9" dir=.cache/export-mfix9-js out rc=0
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
  [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle has no whole string literal \"$text\" — the routed walk client is not shipped"; return 1; }
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  echo "ratchet: the iOS bundle exports and carries \"$text\""
}

# fixture_hygiene — the committed one-to-many capture (PUBLIC repo): its origin is GTFS stop 815 (Third Street) at the
# coordinates the committed assets/db/schedule.db gives it, every target is the GTFS stop it names at its schedule.db
# coordinates, `_provenance` names Transitous and ODbL, the answer has one entry per target, each entry is exactly
# {duration, distance} or {}, and nothing anywhere in it is a key or a geometry (Jamie's own positions never enter
# the repo; only per-target numbers are kept). Reads the DB with node:sqlite; no network.
fixture_hygiene() {
  need_files "$MFIX9_FIXTURE" assets/db/schedule.db || return 1
  node - "$MFIX9_FIXTURE" assets/db/schedule.db <<'NODE' || return 1
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [file, dbPath] = process.argv.slice(2);
const fail = (m) => { console.log(`ratchet: ${file}: ${m}`); process.exit(1); };
let fx;
try { fx = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`is not readable JSON (${e.message})`); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const stop = (id) => db.prepare('SELECT stop_id, lat, lon FROM stop WHERE stop_id = ?').get(String(id));
const prov = fx?._provenance;
if (typeof prov !== 'string' || !/\bTransitous\b/.test(prov) || !/\bODbL\b/.test(prov)) fail('_provenance must name Transitous and the ODbL (OpenStreetMap street data)');
const one = fx?.request?.one;
const s815 = stop('815');
if (s815 === undefined) fail('premise: schedule.db has no stop 815');
if (one?.stopId !== '815' || one.lat !== s815.lat || one.lon !== s815.lon) fail(`the origin must be GTFS stop 815 at schedule.db's ${s815.lat},${s815.lon} (a public stop, never a rider's position), got ${JSON.stringify(one)}`);
const many = fx?.request?.many;
if (!Array.isArray(many) || many.length === 0) fail('request.many lists the targets');
for (const t of many) {
  const s = stop(t?.stopId);
  if (s === undefined || t.lat !== s.lat || t.lon !== s.lon) fail(`target ${JSON.stringify(t)} is not a GTFS stop at its schedule.db coordinates`);
}
const answer = fx?.response;
if (!Array.isArray(answer) || answer.length !== many.length) fail(`the answer must hold one entry per target (${many.length}), got ${Array.isArray(answer) ? answer.length : typeof answer}`);
for (const [i, a] of answer.entries()) {
  const keys = a !== null && typeof a === 'object' ? Object.keys(a).sort().join(',') : null;
  if (keys !== '' && keys !== 'distance,duration') fail(`answer[${i}] must be {} or exactly {duration, distance}, got keys ${JSON.stringify(keys)}`);
}
const BAD = /^(api[-_]?key|key|token|secret|auth|authorization|password|cookie|geometry|legGeometry|polyline|points|path|shape|coordinates|steps)$/i;
const stack = [{ v: fx, at: '$' }];
let seen = 0;
for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
  const { v, at } = stack.pop();
  seen += 1;
  if (v === null || typeof v !== 'object') continue;
  for (const [k, child] of Object.entries(v)) {
    if (BAD.test(k)) fail(`${at}.${k}: no key or geometry field may be committed`);
    stack.push({ v: child, at: `${at}.${k}` });
  }
}
if (/[?&](api[-_]?key|key|token)=/i.test(JSON.stringify(fx))) fail('a key-like URL parameter is in the fixture');
console.log(`ratchet: ${file}: origin is GTFS stop 815 at schedule.db's coordinates, ${many.length} GTFS targets, Transitous + ODbL provenance, no key or geometry (${seen} values scanned)`);
NODE
}

# walk_wiring — the ONE runtime (C): outside src/domain/walk and tests, only src/ui/walk/RoutedWalkProvider.tsx
# references WALK_ROUTER_URL or buildWalkRequest, and the endpoint literal lives only in src/domain/walk/one-to-many.ts;
# the provider's default fetch is the app's typed HTTP (it imports EXPO_FETCH from src/live/http.ts: httpGet is typed
# to the realtime providers); and the three verdict paths (D) read the walk through useWalkTo: the Now bar (its
# useNearTripWalk in src/ui/now/near-trip-walk.ts), the station sheet (src/ui/hurry), the route chip (src/ui/routes).
walk_wiring() {
  local provider=src/ui/walk/RoutedWalkProvider.tsx dir
  need_files src/domain/walk/one-to-many.ts src/domain/walk/walk-cache.ts "$provider" || return 1
  node - "$provider" <<'NODE' || return 1
const fs = require('node:fs');
const path = require('node:path');
const provider = process.argv[2];
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
const isTest = (f) => /(^|\/)(__tests__|__fixtures__|__mocks__)\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f);
const files = fs.readdirSync('src', { recursive: true }).map((f) => path.join('src', String(f))).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f));
const text = (f) => fs.readFileSync(f, 'utf8');
const users = files.filter((f) => !f.startsWith('src/domain/walk/') && /\b(WALK_ROUTER_URL|buildWalkRequest)\b/.test(text(f)));
if (users.length !== 1 || users[0] !== provider) fail(`only ${provider} may reference WALK_ROUTER_URL or buildWalkRequest outside src/domain/walk; found ${JSON.stringify(users)}`);
if (!/\bbuildWalkRequest\s*\(/.test(text(provider))) fail(`${provider} must build its request with buildWalkRequest`);
const literal = files.filter((f) => text(f).includes('api/v1/one-to-many'));
if (literal.length !== 1 || literal[0] !== 'src/domain/walk/one-to-many.ts') fail(`the one-to-many endpoint is written only in src/domain/walk/one-to-many.ts; found it in ${JSON.stringify(literal)}`);
const code = (f) => text(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const mounts = files.filter((f) => /<RoutedWalkProvider\b/.test(code(f)));
if (mounts.length !== 1 || mounts[0] !== 'src/app/_layout.tsx') fail(`RoutedWalkProvider is mounted by src/app/_layout.tsx only (ONE cache, every consumer's stops in one request); found <RoutedWalkProvider in ${JSON.stringify(mounts)}`);
const agents = files.filter((f) => f !== 'src/domain/routes/transitous.ts' && /MiamiTransit\/|['"`]User-Agent['"`]\s*:\s*['"`]/.test(code(f)));
if (agents.length !== 0) fail(`the User-Agent is written only by src/domain/routes/transitous.ts's transitousUserAgent, never re-typed; found one written in ${JSON.stringify(agents)}`);
const plan = code('src/domain/routes/transitous.ts');
if ((plan.match(/MiamiTransit\//g) ?? []).length !== 1 || (plan.match(/\btransitousUserAgent\s*\(/g) ?? []).length < 2) fail('src/domain/routes/transitous.ts writes the User-Agent once, in transitousUserAgent, and buildPlanRequest calls it (m10a)');
if (!/import\s*\{[^}]*\bEXPO_FETCH\b[^}]*\}\s*from\s+['"](@\/live\/http|\.\.\/\.\.\/live\/http)['"]/.test(code(provider))) fail(`${provider}'s default fetchWalk is the app's typed HTTP: it must import EXPO_FETCH from src/live/http.ts (httpGet is typed to the realtime providers)`);
const nearTrip = 'src/ui/now/near-trip-walk.ts';
if (!files.includes(nearTrip) || !/export\s+function\s+useNearTripWalk\s*\(/.test(code(nearTrip)) || !/\buseWalkTo\s*\(/.test(code(nearTrip))) fail(`the Now bar's walk lives in ${nearTrip}: export function useNearTripWalk(...), which calls useWalkTo(...)`);
for (const dir of ['src/ui/now/', 'src/ui/hurry/', 'src/ui/routes/']) {
  const readers = files.filter((f) => f.startsWith(dir) && /\buseWalkTo\s*\(/.test(text(f)));
  if (readers.length === 0) fail(`no module under ${dir} reads the routed walk through useWalkTo(...)`);
}
console.log(`ratchet: ${provider} is the only runtime that asks for routed walks; the bar, the station sheet and the route chip read them through useWalkTo`);
NODE
}

# root_mounts_walk — the root layout mounts ONE RoutedWalkProvider INSIDE UserLocationProvider (it reads the rider's
# position) and around the root Stack (every screen sits under it).
root_mounts_walk() {
  local layout=src/app/_layout.tsx
  need_files "$layout" || return 1
  node - "$layout" <<'NODE' || return 1
const fs = require('node:fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const fail = (m) => { console.log(`ratchet: ${file}: ${m}`); process.exit(1); };
const count = (re) => (src.match(re) ?? []).length;
if (!/import\s*\{[^}]*\bRoutedWalkProvider\b[^}]*\}\s*from\s*['"](@\/ui\/walk\/RoutedWalkProvider|\.\.\/ui\/walk\/RoutedWalkProvider)['"]/.test(src)) fail('must import RoutedWalkProvider from src/ui/walk/RoutedWalkProvider');
if (count(/<RoutedWalkProvider\b/g) !== 1 || count(/<\/RoutedWalkProvider>/g) !== 1) fail('must mount exactly one <RoutedWalkProvider>…</RoutedWalkProvider>');
const at = (s) => src.indexOf(s);
const order = [at('<UserLocationProvider>'), at('<RoutedWalkProvider'), at('<Stack'), at('</Stack>'), at('</RoutedWalkProvider>'), at('</UserLocationProvider>')];
if (order.some((i) => i < 0) || order.some((i, k) => k > 0 && i <= order[k - 1])) fail(`RoutedWalkProvider must sit inside UserLocationProvider and around the root Stack (positions ${JSON.stringify(order)})`);
console.log('ratchet: the root layout mounts one RoutedWalkProvider inside UserLocationProvider, around the root Stack');
NODE
}

# mfix9_pure <case> — the PURE domain (A, B, F) called directly under tsx (no jest, no network): the shipped modules
# are imported by their exact paths and checked against values this script computes itself (the repo's own
# haversine, m7c's engine and HURRY_DEFAULTS, m10a's buildPlanRequest). Cases: client cache fixture
mfix9_pure() {
  local which="$1" dir out rc=0
  case "$which" in client|cache|fixture) ;;
    *) echo "ratchet: verify-script authoring error: unknown mfix9 pure case '$which'"; return 1 ;; esac
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-mfix9-pure.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/pure.mjs" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const CASE = process.env.MFIX9_CASE;
const fail = (m) => { console.log(`ratchet: mfix9 ${CASE}: ${m}`); process.exit(1); };
const check = (cond, m) => { if (!cond) fail(m); };
const same = (got, want, m) => { try { assert.deepStrictEqual(got, want); } catch (e) { console.log(e.message.split('\n').slice(0, 14).join('\n')); fail(m); } };
const show = (v) => JSON.stringify(v);
const call = (f, what) => { try { return f(); } catch (e) { return fail(`${what} threw ${e?.name ?? 'an error'}: ${e?.message ?? e} — it must return a Result, never throw`); } };
const load = async (rel, names) => {
  let m;
  try { m = await import(path.join(process.cwd(), rel)); } catch (e) { return fail(`cannot import ${rel}: ${e.message.split('\n')[0]}`); }
  for (const n of names) check(m[n] !== undefined, `${rel} exports no ${n}`);
  return m;
};
const near = (got, want, tol, m) => check(typeof got === 'number' && Math.abs(got - want) <= tol, `${m}: want ${want} (±${tol}), got ${show(got)}`);
const { haversineMeters } = await load('src/lib/geo.ts', ['haversineMeters']);
// GTFS stop 815 (Metromover Third Street) and the fixture's targets, at the committed schedule.db's coordinates.
const O = { latitude: 25.772024, longitude: -80.193508 };
const S805 = { stopId: '805', latitude: 25.769165, longitude: -80.192248 };   // Fifth Street
const S806 = { stopId: '806', latitude: 25.771051, longitude: -80.192558 };   // Riverwalk
const perDeg = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });
const south = (m) => ({ latitude: O.latitude - m / perDeg, longitude: O.longitude });
const north = (m) => ({ latitude: O.latitude + m / perDeg, longitude: O.longitude });

const CASES = {
  // A. The one-to-many client.
  client: async () => {
    const W = await load('src/domain/walk/one-to-many.ts', ['buildWalkRequest', 'parseWalkTimes', 'WALK_ROUTER_URL', 'WALK_MAX_TARGETS', 'WALK_MAX_S', 'WALK_MATCH_M']);
    const T = await load('src/domain/routes/transitous.ts', ['buildPlanRequest', 'transitousUserAgent']);
    same([W.WALK_ROUTER_URL, W.WALK_MAX_TARGETS, W.WALK_MAX_S, W.WALK_MATCH_M], ['https://api.transitous.org/api/v1/one-to-many', 128, 3600, 250], 'the constants are the measured server limits (maxOneToManySize 128) and the brief\'s query');
    const want = 'https://api.transitous.org/api/v1/one-to-many?one=25.772024;-80.193508&many=25.769165;-80.192248,25.771051;-80.192558&mode=WALK&max=3600&maxMatchingDistance=250&arriveBy=false&withDistance=true';
    for (const v of ['1.0.0', '2.3.4']) {
      const r = call(() => W.buildWalkRequest(O, [S805, S806], v), `buildWalkRequest(815, [805, 806], "${v}")`);
      check(r?.ok === true, `buildWalkRequest(815, [805, 806], "${v}") must be ok, got ${show(r)}`);
      check(r.value.url === want, `url\n  got:  ${r.value.url}\n  want: ${want}`);
      const plan = T.buildPlanRequest({ from: O, to: S805, timeEpoch: 1790881200, arriveBy: false }, v).headers['User-Agent'];
      check(T.transitousUserAgent(v) === plan, `transitousUserAgent("${v}") must be the very User-Agent buildPlanRequest sends (m10a): ${show(T.transitousUserAgent(v))} vs ${show(plan)}`);
      same({ ...r.value.headers }, { 'User-Agent': plan }, `the headers are exactly m10a's User-Agent for app version ${v} (Transitous takes no key)`);
    }
    const src = fs.readFileSync('src/domain/walk/one-to-many.ts', 'utf8');
    check(!/MiamiTransit|purpleperkel/.test(src), 'one-to-many.ts re-types the User-Agent: import transitousUserAgent from ../routes/transitous instead');
    check(/import\s*\{[^}]*\btransitousUserAgent\b[^}]*\}\s*from\s*['"]\.\.\/routes\/transitous['"]/.test(src), 'one-to-many.ts must import transitousUserAgent from ../routes/transitous');
    const many = (n) => Array.from({ length: n }, (_, i) => north(10 * (i + 1)));
    check(call(() => W.buildWalkRequest(O, many(128), '1.0.0'), 'buildWalkRequest with 128 targets')?.ok === true, '128 targets (the server limit) are one request');
    const bad = [['no target', O, []], ['129 targets', O, many(129)], ['a NaN origin', { latitude: NaN, longitude: O.longitude }, [S805]],
      ['an infinite target', O, [S805, { latitude: 25.7, longitude: Infinity }]], ['a NaN target', O, [{ latitude: NaN, longitude: -80.19 }]]];
    for (const [what, from, targets] of bad) {
      const r = call(() => W.buildWalkRequest(from, targets, '1.0.0'), `buildWalkRequest with ${what}`);
      check(r !== null && typeof r === 'object' && r.ok === false && r.error !== undefined, `buildWalkRequest with ${what} must be an Err, got ${show(r)}`);
    }
    const parse = (json, n) => call(() => W.parseWalkTimes(json, n), `parseWalkTimes(${show(json)}, ${n})`);
    const good = parse([{ duration: 519, distance: 292.7103862762451 }, {}, { duration: 0, distance: 0 }], 3);
    check(good?.ok === true, `a well-formed answer parses, got ${show(good)}`);
    same(good.value.map((p) => (p === null ? null : { ...p })), [{ distanceM: 292.7103862762451, costS: 519 }, null, { distanceM: 0, costS: 0 }], 'parseWalkTimes keeps distance as distanceM and the routing COST duration as costS; {} is no path (null)');
    const errs = [[[{}], 2, 'a length other than n'], [{}, 1, 'a non-array body'], [null, 1, 'a null body'], [[{ duration: 5 }], 1, 'a duration without a distance'],
      [[{ distance: 5 }], 1, 'a distance without a duration'], [[{ distance: -1, duration: 5 }], 1, 'a negative distance'], [[{ distance: 5, duration: -1 }], 1, 'a negative duration'],
      [[{ distance: '5', duration: 5 }], 1, 'a string distance'], [[{ distance: Infinity, duration: 5 }], 1, 'an infinite distance'], [[{ distance: NaN, duration: 5 }], 1, 'a NaN distance'],
      [[null], 1, 'a null entry'], [[7], 1, 'a number entry'],
      // ARBITER FIX ROUND Q3: never throws — a count outside 1..128 is an Err, and so is any key besides distance/duration.
      [[], 0, 'n = 0'], [[], 129, 'n = 129'], [[{ distance: 5, duration: 5, geometry: 'kv}oC' }], 1, 'a walk carrying a geometry'],
      [[{ distance: 5, duration: 5, steps: [] }], 1, 'a walk carrying steps'],
      // ARBITER Z1 (review of 7c0bab8): a JSON-producible entry whose only key is the empty string.
      [[{ '': 5 }], 1, 'an entry whose only key is empty'], [[{ '': 5, distance: 5, duration: 5 }], 1, 'a walk with an extra empty key']];
    for (const [json, n, what] of errs) {
      const r = parse(json, n);
      check(r !== null && typeof r === 'object' && r.ok === false && r.error !== undefined, `parseWalkTimes on ${what} must be an Err, got ${show(r)}`);
    }
    same(parse([{}], 1)?.value, [null], 'parseWalkTimes still reads {} as no walk (null)');
    console.log('ok: client buildWalkRequest writes the exact one-to-many query with m10a\'s User-Agent (imported); 0, 129 targets and non-finite coordinates are Errs; parseWalkTimes reads {distanceM, costS} | null and Errs on anything else (n outside 1..128, any key besides distance/duration); nothing throws');
  },
  // B. The walk-cache policy (ARBITER FIX ROUND Q1: one entry per stop, MERGED; Q5: keyed by stop_id AND place).
  cache: async () => {
    const C = await load('src/domain/walk/walk-cache.ts', ['needsWalkRequest', 'walkFor', 'mergeWalks', 'dropStaleWalks', 'walkKey', 'REFRESH_MOVE_M', 'MIN_REQUEST_GAP_S', 'BACKOFF_MAX_S', 'STALE_ORIGIN_M']);
    const { HURRY_DEFAULTS } = await load('src/domain/hurry/verdict.ts', ['HURRY_DEFAULTS']);
    same([C.REFRESH_MOVE_M, C.MIN_REQUEST_GAP_S, C.BACKOFF_MAX_S, C.STALE_ORIGIN_M], [150, 60, 600, 300], 'REFRESH_MOVE_M 150, MIN_REQUEST_GAP_S 60, BACKOFF_MAX_S 600, STALE_ORIGIN_M 300');
    const S807 = { stopId: '807', latitude: 25.771865, longitude: -80.191377 };
    const ask = (prev, origin, atS, walks) => call(() => C.mergeWalks(prev, { origin, requestedAtS: atS, stops: walks.map(([s]) => s), paths: walks.map(([, p]) => p) }), 'mergeWalks');
    const cache = ask(null, O, 1000, [[S805, { distanceM: 710.639274597168, costS: 867 }], [S806, null]]);
    const needs = [
      ['no cache', null, O, 1000, [S805], 0, true],
      ['no cache, backing off', null, O, 1000, [S805], 1001, false],
      ['no cache, the backoff just ended', null, O, 1001, [S805], 1001, true],
      ['a wanted stop has no entry, 59 s after the request', cache, O, 1059, [S805, S807], 0, false],
      ['a wanted stop has no entry, 60 s after the request', cache, O, 1060, [S805, S807], 0, true],
      ['every wanted stop has an entry (806: no path), at the origin', cache, O, 5000, [S805, S806], 0, false],
      ['149.99 m from the origin', cache, south(149.99), 5000, [S805], 0, false],
      ['150.5 m from the origin', cache, south(150.5), 5000, [S805], 0, true],
      ['150.5 m from the origin, 59 s after the request', cache, south(150.5), 1059, [S805], 0, false],
      ['150.5 m from the origin, backing off', cache, south(150.5), 5000, [S805], 5001, false],
    ];
    for (const [what, c, pos, nowS, wanted, backoff, want] of needs) {
      const got = call(() => C.needsWalkRequest(c, pos, nowS, wanted, backoff), `needsWalkRequest (${what})`);
      check(got === want, `needsWalkRequest, ${what}: want ${want}, got ${show(got)}`);
    }
    const est = (stop, pos) => ({ walkMeters: haversineMeters(pos, stop), detour: HURRY_DEFAULTS.detour, source: 'estimated' });
    const plain = (e) => (e === null || typeof e !== 'object' ? e : { walkMeters: e.walkMeters, detour: e.detour, source: e.source });
    const walk = (c, stop, pos, what) => plain(call(() => C.walkFor(c, stop, pos), `walkFor (${what})`));
    const close = (got, want, what) => {
      check(got?.source === want.source && got?.detour === want.detour, `walkFor, ${what}: want ${show(want)}, got ${show(got)}`);
      near(got.walkMeters, want.walkMeters, 1e-6, `walkFor, ${what}: walkMeters`);
    };
    const at0 = haversineMeters(O, S805);
    close(walk(cache, S805, O, 'at the origin'), { walkMeters: 710.639274597168, detour: 1, source: 'routed' }, 'at the origin the routed distance, no detour');
    for (const m of [100, 299.99]) {
      const pos = south(m);
      close(walk(cache, S805, pos, `${m} m off`), { walkMeters: 710.639274597168 * haversineMeters(pos, S805) / at0, detour: 1, source: 'routed' }, `${m} m from the origin: distanceM x straightNow / straightAtOrigin`);
    }
    close(walk(cache, S805, south(300.5), '300.5 m off'), est(S805, south(300.5)), '300.5 m from the origin: estimated (straight line, m7c\'s detour)');
    close(walk(cache, S806, O, 'no path'), est(S806, O), 'an entry with no path: estimated');
    close(walk(cache, S807, O, 'no entry'), est(S807, O), 'a stop with no entry: estimated');
    close(walk(null, S805, O, 'no cache'), est(S805, O), 'no cache: estimated');
    const NEAR = { stopId: 'n40', ...north(40) };
    const nearCache = ask(null, O, 1000, [[NEAR, { distanceM: 90, costS: 200 }], [{ stopId: 'o0', ...O }, { distanceM: 12, costS: 100 }]]);
    close(walk(nearCache, NEAR, south(100), 'stop 40 m from the origin'), { walkMeters: 90, detour: 1, source: 'routed' }, 'a stop < 50 m from the origin: just distanceM');
    close(walk(nearCache, { stopId: 'o0', ...O }, south(20), 'stop at the origin'), { walkMeters: 12, detour: 1, source: 'routed' }, 'a stop AT the origin (straightAtOrigin 0): just distanceM, never a division by zero');
    // Q1: a new answer is MERGED — only its own stops' entries are replaced — and each entry keeps the origin it was answered from.
    const later = ask(cache, south(200), 2000, [[S807, { distanceM: 400, costS: 500 }]]);
    same([S805, S806, S807].map((s) => show(later.entries.get(C.walkKey(s))?.origin ?? null)), [show(O), show(O), show(south(200))], 'mergeWalks replaces only the answer\'s stops: 805 and 806 keep their entries asked from 815, 807 is answered from 200 m south');
    check(call(() => C.needsWalkRequest(later, south(100), 5000, [S805, S807], 0), 'needsWalkRequest (per entry)') === false && call(() => C.needsWalkRequest(later, south(260), 5000, [S805], 0), 'needsWalkRequest (per entry)') === true, 'needsWalkRequest judges each wanted stop by its OWN entry\'s origin (strictly > 150 m asks)');
    close(walk(later, S807, south(100), '807 from its own origin'), { walkMeters: 400 * haversineMeters(south(100), S807) / haversineMeters(south(200), S807), detour: 1, source: 'routed' }, 'walkFor scales by the stop\'s own entry\'s origin');
    same([...ask(later, south(400), 3000, [[S806, null]]).entries.keys()].sort(), [S806, S807].map(C.walkKey).sort(), 'a merge drops the entries asked more than 300 m from the answer\'s origin (805, asked at 815, 400 m back) and keeps the rest');
    same([...call(() => C.dropStaleWalks(later, south(350)), 'dropStaleWalks').entries.keys()], [C.walkKey(S807)], 'dropStaleWalks drops the entries asked more than 300 m from the rider');
    // Q5: a stop is keyed by its stop_id AND its place.
    const elsewhere = { stopId: '805', latitude: 25.7801, longitude: -80.2001 };
    close(walk(cache, elsewhere, O, 'another feed\'s 805'), est(elsewhere, O), 'a stop sharing 805\'s raw stop_id at another place never shares its walk');
    const code = fs.readFileSync('src/domain/walk/walk-cache.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check(!/(^|[^\d.])1\.3(?!\d)/m.test(code) && /import\s*\{[^}]*\bHURRY_DEFAULTS\b[^}]*\}\s*from\s*['"]\.\.\/hurry\/verdict['"]/.test(code), 'walk-cache.ts must import m7c\'s HURRY_DEFAULTS from ../hurry/verdict for the estimated detour, never re-type 1.3 in code');
    console.log('ok: cache needsWalkRequest and walkFor follow the brief (150 m strict, 60 s, backoff, missing entries; routed <= 300 m scaled, < 50 m unscaled, else estimated x HURRY_DEFAULTS.detour); answers MERGE per entry, each scaled and refreshed by its own origin, dropped > 300 m back (Q1); keys are stop_id + place (Q5)');
  },
  // F. The committed fixture: Jamie's bug in public data.
  fixture: async () => {
    const W = await load('src/domain/walk/one-to-many.ts', ['parseWalkTimes']);
    const C = await load('src/domain/walk/walk-cache.ts', ['walkFor', 'mergeWalks']);
    const { hurryVerdict } = await load('src/domain/hurry/verdict.ts', ['hurryVerdict']);
    let fx;
    try { fx = JSON.parse(fs.readFileSync(process.env.MFIX9_FIXTURE, 'utf8')); } catch (e) { fail(`${process.env.MFIX9_FIXTURE} is not readable (${e.message})`); }
    const origin = { latitude: fx.request.one.lat, longitude: fx.request.one.lon };
    same(origin, O, 'premise: the fixture rider stands at stop 815');
    const parsed = call(() => W.parseWalkTimes(fx.response, fx.request.many.length), 'parseWalkTimes(fixture)');
    check(parsed?.ok === true && parsed.value.length === 5 && parsed.value.every((p) => p !== null), `the fixture parses into 5 walks, got ${show(parsed)}`);
    const stops = fx.request.many.map((t) => ({ stopId: t.stopId, latitude: t.lat, longitude: t.lon }));
    const ratios = stops.map((s, i) => Number((parsed.value[i].distanceM / haversineMeters(O, s)).toFixed(2)));
    same(ratios, [2.03, 2.08, 1.31, 1.63, 1.19], 'premise: the routed / straight ratios the brief measured (no single detour constant is right)');
    const cache = C.mergeWalks(null, { origin: O, requestedAtS: 0, stops, paths: parsed.value });
    const fifth = stops.find((s) => s.stopId === '805');
    near(haversineMeters(O, fifth), 342.03, 0.01, 'straight line 815 -> 805');
    const est = C.walkFor(null, fifth, O), routed = C.walkFor(cache, fifth, O);
    check(est.source === 'estimated' && routed.source === 'routed', `sources: estimated without a cache, routed with the fixture; got ${est.source}, ${routed.source}`);
    const now = 1_790_000_000;
    const departures = [{ epoch: now + 30 + 400, live: false, lineId: null, headsign: null }];
    const v = (e) => hurryVerdict({ now, walkMeters: e.walkMeters, detour: e.detour, departures, walkMps: 1.35, jogMps: 2.7 });
    const ve = v(est), vr = v(routed);
    near(ve.walkS, 329.36, 0.01, 'estimated walkS (342.03 m x 1.3 / 1.35)');
    near(vr.walkS, 526.40, 0.01, 'routed walkS (710.64 m / 1.35)');
    near(vr.jogS, 263.20, 0.01, 'routed jogS (710.64 m / 2.7)');
    check(ve.kind === 'CHILL' && vr.kind === 'JOG', `one departure at now + 30 + 400 s (slack 400): the estimate says CHILL, the routed walk JOG; got ${ve.kind}, ${vr.kind}`);
    console.log(`ok: fixture straight 342.03 m -> estimated walkS ${ve.walkS.toFixed(2)} CHILL; routed 710.64 m -> walkS ${vr.walkS.toFixed(2)}, jogS ${vr.jogS.toFixed(2)} JOG`);
  },
};
await CASES[CASE]();
JS
  out=$(MFIX9_CASE="$which" MFIX9_FIXTURE="$MFIX9_FIXTURE" node --import tsx "$dir/pure.mjs" 2>&1) || rc=$?
  rm -rf "$dir"
  [ "$rc" -eq 0 ] || { echo "$out" | tail -25; echo "ratchet: mfix9 pure oracle '$which' failed"; return 1; }
  echo "$out" | _qgrep -E "^ok: $which " || { echo "$out" | tail -10; echo "ratchet: mfix9 pure oracle '$which' did not run to its end"; return 1; }
  echo "$out" | tail -1
}

# mfix9_oracle <case> — the card's behaviour on the SHIPPED app, independent of the builder's tests: a throwaway jest
# test in the gitignored .cache (removed whether it passes or fails; mfix8_oracle's pattern) under the repo's own
# jest-expo/ios transform, with labelled native mocks of expo-sqlite, expo-sqlite/kv-store, expo-location and
# expo-crypto only. fetchWalk is ALWAYS the oracle's fake (no network): it records each request (its time on the
# wall clock, `one`, `many`, headers) and answers from a queue — 'ok' (a synthetic answer: distance = 2 x the
# straight line), 'pending' (held until released) or a LiveError — or, for the bar and the sheet, from the
# committed fixture by coordinates ({} for a target the fixture does not hold).
# Request-discipline cases run on jest's fake clock (Date.now included), stepped in 1 s increments inside act (the
# repo's act() trap), with fixes pushed through the real UserLocationProvider's one watch.
# Cases: fallback requests batch backoff default_fetch bar sheet chip chip_screen
mfix9_oracle() {
  local which="$1" dir out rc=0
  case "$which" in fallback|requests|batch|backoff|default_fetch|bar|sheet|chip|chip_screen) ;;
    *) echo "ratchet: verify-script authoring error: unknown mfix9 oracle case '$which'"; return 1 ;; esac
  need_files src/ui/location/UserLocationProvider.tsx src/ui/trips/__tests__/trip-db.ts src/ui/primitives/__tests__/render-primitive.tsx || return 1
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-mfix9-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/walk.oracle.test.tsx" <<'TSX'
const path = require('node:path');
const CASE = process.env.MFIX9_CASE ?? '';
const fail = (m: string): never => { throw new Error(`ratchet-oracle: ${CASE}: ${m}`); };
const show = (v: unknown): string => JSON.stringify(v);
const load = (rel: string, names: string[]): Record<string, any> => {
  let mod: Record<string, any> = {};
  try { mod = require(path.join(process.cwd(), rel)); } catch (e) { fail(`${rel} does not load under jest: ${(e as Error).message.split('\n')[0]}`); }
  for (const n of names) if (mod[n] === undefined) fail(`${rel} exports no ${n}`);
  return mod;
};
type Fix = { latitude: number; longitude: number } | null;
let mockFix: Fix = null;
/** The ONE fix a plan from the rider's own location starts at (getCurrentPositionAsync); null = the watch's mockFix. */
let mockStart: Fix = null;
const mockWatchers: ((f: { coords: Fix }) => void)[] = [];
let mockCopy: unknown = null;
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockProvider, useSQLiteContext: mockScheduleCopy, openDatabaseSync: mockNoUserDbFile }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => mockKvStore());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAsk, getCurrentPositionAsync: mockCurrent, watchPositionAsync: mockWatch }));
// test-time mock of native module
jest.mock('expo-crypto', () => ({ randomUUID: mockUuid }));
// test-time mock of native module
jest.mock('expo/fetch', () => ({ fetch: mockExpoFetch }));
/** expo/fetch's calls, and what it answers next for one-to-many: 'json' (200, 2x the straight line), a status, or 'reject'; /plan gets m10a's fixture. */
const mockExpoCalls: { atS: number; url: string; headers: Record<string, string>; signal: unknown }[] = [];
const mockExpoAnswers: ('json' | number | 'reject')[] = [];
function mockExpoFetch(url: string, init?: { headers?: any; signal?: unknown }) {
  const h = init?.headers ?? {};
  const headers: Record<string, string> = typeof h.get === 'function' ? { 'User-Agent': String(h.get('User-Agent') ?? '') } : { ...h };
  if (String(url).includes('/api/v5/plan')) return Promise.resolve(mockResponse(200, require(require('node:path').join(process.cwd(), 'src/domain/routes/__fixtures__/transitous-plan.json'))));
  mockExpoCalls.push({ atS: Date.now() / 1000, url: String(url), headers, signal: init?.signal });
  const next = mockExpoAnswers.shift() ?? 'json';
  if (next === 'reject') return Promise.reject(new TypeError('Network request failed'));
  if (next !== 'json') return Promise.resolve(mockResponse(next, { error: `HTTP ${next}` }));
  const q = new URLSearchParams(String(url).slice(String(url).indexOf('?') + 1));
  const at = (s: string) => { const [latitude, longitude] = s.split(';').map(Number); return { latitude, longitude }; };
  const { haversineMeters: d } = require(require('node:path').join(process.cwd(), 'src/lib/geo'));
  return Promise.resolve(mockResponse(200, (q.get('many') ?? '').split(',').map((t) => ({ duration: 1, distance: 2 * d(at(q.get('one') ?? ''), at(t)) }))));
}
function mockResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return { ok: status >= 200 && status <= 299, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
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
function mockAsk() { return Promise.resolve({ granted: true, status: 'granted' }); }
function mockCurrent() { return Promise.resolve({ coords: mockStart ?? mockFix ?? undefined, timestamp: Date.now() - 1000 }); }
/** The one watch: each fix the oracle pushes reaches it; remove() ends it. */
function mockWatch(_o: unknown, onFix: (f: { coords: Fix }) => void) {
  mockWatchers.push(onFix);
  if (mockFix !== null) onFix({ coords: mockFix, timestamp: Date.now() } as never);
  return Promise.resolve({ remove: () => { const i = mockWatchers.indexOf(onFix); if (i >= 0) mockWatchers.splice(i, 1); } });
}
const { act } = require('react-test-renderer');
const { AppState, View } = require('react-native');
const { useState } = require('react');
const { renderPrimitive, hostsByTestID, unmountAll } = load('src/ui/primitives/__tests__/render-primitive', ['renderPrimitive', 'hostsByTestID', 'unmountAll']);
const { UserLocationProvider } = load('src/ui/location/UserLocationProvider', ['UserLocationProvider']);
const { useUserPosition } = load('src/ui/map/use-user-location', ['useUserPosition']);
const { haversineMeters } = load('src/lib/geo', ['haversineMeters']);
const { ok, err } = load('src/lib/result', ['ok', 'err']);
afterEach(async () => { jest.useRealTimers(); jest.restoreAllMocks(); await unmountAll(); });
afterAll(() => load('src/ui/trips/__tests__/trip-db', ['closeTripDbs']).closeTripDbs());

// The rider: GTFS stop 815 (Third Street), the fixture's public origin. The wanted stops: the fixture's five targets.
const O = { latitude: 25.772024, longitude: -80.193508 };
const FIVE = [
  { stopId: '806', latitude: 25.771051, longitude: -80.192558 }, { stopId: '805', latitude: 25.769165, longitude: -80.192248 },
  { stopId: '804', latitude: 25.766888, longitude: -80.192121 }, { stopId: '807', latitude: 25.771865, longitude: -80.191377 },
  { stopId: '808', latitude: 25.773099, longitude: -80.187323 },
];
const EXTRA = [{ stopId: 'extra-1', latitude: 25.7745, longitude: -80.1953 }]; // a synthetic stop: another consumer's wanted stop
const perDeg = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });
const south = (m: number) => ({ latitude: O.latitude - m / perDeg, longitude: O.longitude });
const north = (m: number) => ({ latitude: O.latitude + m / perDeg, longitude: O.longitude });
const ll = (p: { latitude: number; longitude: number }) => `${p.latitude};${p.longitude}`;
const E429 = { kind: 'http', status: 429, message: 'api.transitous.org answered HTTP 429' };
const E503 = { kind: 'http', status: 503, message: 'api.transitous.org answered HTTP 503' };
const ENET = { kind: 'network', message: 'api.transitous.org could not be reached: offline' };
const UA = /^MiamiTransit\/\S+ \(\+https:\/\/github\.com\/purpleperkel\/miami-transit\)$/;
const problems: string[] = [];

/** The `one` and `many` of a one-to-many URL (recorded as a problem when it is another endpoint). */
function query(url: string): { one: string; many: string[] } {
  if (!url.startsWith('https://api.transitous.org/api/v1/one-to-many?')) problems.push(`fetchWalk was asked for ${show(url)}, not the one-to-many endpoint`);
  const params = new Map(url.slice(url.indexOf('?') + 1).split('&').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] as [string, string]));
  return { one: params.get('one') ?? '', many: (params.get('many') ?? '').split(',').filter((s) => s.length > 0) };
}
const point = (s: string) => { const [latitude, longitude] = s.split(';').map(Number); return { latitude, longitude }; };
/** A synthetic routed answer: every target reachable, distance = 2 x the straight line. */
const synthetic = (q: { one: string; many: string[] }) => q.many.map((t) => { const d = haversineMeters(point(q.one), point(t)); return { duration: Math.round(d / 1.2) + 90, distance: d * 2 }; });
type Answer = 'ok' | 'pending' | 'garbage' | Record<string, unknown>;
type Call = { atS: number; one: string; many: string[]; headers: Record<string, string> };
/** The oracle's fetchWalk: records every request; answers from `answers` (default 'ok'), with `answer` for 'ok'. */
function fakeFetch(answer: (q: { one: string; many: string[] }) => unknown = synthetic) {
  const calls: Call[] = [];
  const answers: Answer[] = [];
  const held: (() => void)[] = [];
  const fetchWalk = (request: { url: string; headers: Record<string, string> }, signal: AbortSignal) => {
    if (signal === undefined || signal === null || typeof signal.aborted !== 'boolean') problems.push('fetchWalk must be called with an AbortSignal');
    const q = query(String(request?.url));
    calls.push({ atS: Date.now() / 1000, ...q, headers: { ...(request?.headers ?? {}) } });
    const next = answers.shift() ?? 'ok';
    if (next === 'pending') return new Promise((resolve) => held.push(() => resolve(ok(answer(q)))));
    if (next === 'garbage') return Promise.resolve(ok({ error: 'not a list of walks' }));
    return Promise.resolve(next === 'ok' ? ok(answer(q)) : err(next));
  };
  return { calls, answers, fetchWalk, release: () => held.splice(0).forEach((r) => r()) };
}

const plain = (e: any) => (e === null || typeof e !== 'object' ? e : { walkMeters: e.walkMeters, detour: e.detour, source: e.source });
let WALK: Record<string, any> = {};
const seen = new Map<string, Record<string, any>>();
/** A consumer: registers `stops` through useWalkTo and records each stop's WalkEstimate whenever the rider is located. */
function Probe({ name, stops }: { name: string; stops: readonly any[] }) {
  const walk = WALK.useWalkTo(stops);
  const position = useUserPosition();
  if (position.coordinate !== null) seen.set(name, Object.fromEntries(stops.map((s) => [s.stopId, plain(walk(s))])));
  return <View testID={`probe-${name}`} />;
}
let showExtra: () => void = () => fail('no consumers mounted');
function Consumers({ first, extra }: { first: readonly any[]; extra: readonly any[] | null }) {
  const [more, setMore] = useState(false);
  showExtra = () => setMore(true);
  return (<>{[<Probe key="a" name="a" stops={first} />, extra !== null && more ? <Probe key="b" name="b" stops={extra} /> : null]}</>);
}
async function mountWalk(fetchWalk: unknown, first: readonly any[], extra: readonly any[] | null = null, withProvider = true) {
  const Provider = WALK.RoutedWalkProvider;
  const inner = <Consumers first={first} extra={extra} />;
  return renderPrimitive(<UserLocationProvider>{withProvider ? <Provider fetchWalk={fetchWalk}>{inner}</Provider> : inner}</UserLocationProvider>);
}
const nowS = () => Date.now() / 1000;
/** The fake clock stepped `seconds` times by 1 s, each step in its own act (the repo's act() trap). */
async function step(seconds: number) { for (let i = 0; i < seconds; i += 1) await act(async () => { await jest.advanceTimersByTimeAsync(1000); }); }
async function stepUntil(atS: number) { await step(Math.max(0, Math.ceil(atS - nowS()))); }
async function fix(p: { latitude: number; longitude: number }) { mockFix = p; await act(async () => { [...mockWatchers].forEach((w) => w({ coords: p, timestamp: Date.now() } as never)); }); }
function fakeClock() {
  jest.useFakeTimers({ now: Date.parse('2026-09-30T08:00:00-04:00'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  if (Date.now() !== Date.parse('2026-09-30T08:00:00-04:00')) fail('premise: the fake clock drives Date.now');
}
const listeners = () => (jest.isMockFunction(AppState.addEventListener) ? AppState.addEventListener.mock.calls.length : 0);
/** AppState moves to `state`: currentState, and every 'change' listener added since `from`. */
function setAppState(state: string, from: number) {
  Object.assign(AppState, { currentState: state });
  const calls = jest.isMockFunction(AppState.addEventListener) ? AppState.addEventListener.mock.calls.slice(from) : [];
  for (const c of calls) if (c[0] === 'change' && typeof c[1] === 'function') c[1](state);
}
function sourceOf(name: string, stopId: string, want: string, when: string) {
  const got = seen.get(name)?.[stopId];
  if (got?.source !== want) fail(`${when}: stop ${stopId}'s walk must be ${want}, got ${show(got)}`);
  return got;
}
function settled() { if (problems.length > 0) fail(problems[0] as string); }
async function settleReal(rounds = 8) { await act(async () => { for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0)); }); }
/** Real timers: wait (<= 2 s) until fetchWalk was called `n` times, then let the answer land. */
async function untilCalls(calls: unknown[], n: number) {
  for (let i = 0; i < 40 && calls.length < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await settleReal();
}
// ---- the bar and the station sheet over the real schedule (F, E) ----
const FIFTH = 'mover:fifth-street', BAYFRONT = 'mover:bayfront-park';
const NO_LIVE = { state: null, runtime: null };
const PACE = { walkMps: 1.35, jogMps: 2.7 };
const fixtureJson = (): any => {
  const file = path.join(process.cwd(), 'src/domain/walk/__fixtures__/transitous-one-to-many.json');
  try { return JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch (e) { return fail(`${file} is not readable (${(e as Error).message})`); }
};
/** fetchWalk answering from the committed fixture: each target by its coordinates, {} for one it does not hold. */
function fixtureFetch() {
  const fx = fixtureJson();
  const byPoint = new Map<string, unknown>(fx.request.many.map((t: any, i: number) => [`${t.lat};${t.lon}`, fx.response[i]]));
  const f = fakeFetch((q) => {
    if (q.one !== `${fx.request.one.lat};${fx.request.one.lon}`) problems.push(`the request must be made from the rider's position ${fx.request.one.lat};${fx.request.one.lon}, got one=${q.one}`);
    return q.many.map((t) => byPoint.get(t) ?? {});
  });
  return { ...f, routedAt: (p: { latitude: number; longitude: number }): number => { const a: any = byPoint.get(ll(p)); if (a === undefined) fail(`premise: the fixture holds no walk to ${ll(p)}`); return a.distance; } };
}
const trips = () => load('src/ui/trips/__tests__/trip-db', ['realScheduleRepo', 'memoryUserRepos', 'savedTrip', 'closeTripDbs']);
/** T: 430 s before the first Fifth Street -> Bayfront Park ride of Wednesday 2026-09-30 (platform 805), so its slack is 400 s. */
function fixtureInstant(): number {
  const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
  const got = trips().realScheduleRepo().tripRides(FIFTH, BAYFRONT, windowFrom(Date.parse('2026-09-30T04:00:00-04:00') / 1000, 4 * 3600));
  if (!got.ok || got.value.kind !== 'rides') fail('premise: Fifth Street -> Bayfront Park has direct rides');
  const first = Math.min(...got.value.rides.filter((r: any) => r.boardStopId === '805').map((r: any) => r.depEpoch));
  if (!Number.isSafeInteger(first)) fail('premise: a first ride boards at platform 805');
  return first - 430;
}
/** The verdicts the shipped engine gives the saved trip Fifth Street -> Bayfront Park at T from O: estimated and routed. */
function tripVerdicts(T: number, routedM: (p: any) => number) {
  const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
  const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
  const { nearestPlatform } = load('src/domain/hurry/platform', ['nearestPlatform']);
  const { clockFor } = load('src/ui/hurry/hurry-reading', ['clockFor']);
  const repo = trips().realScheduleRepo();
  const window = windowFrom(T, 3 * 3600);
  const got = repo.tripRides(FIFTH, BAYFRONT, window);
  if (!got.ok || got.value.kind !== 'rides') fail('premise: Fifth Street -> Bayfront Park has rides at T');
  const rides = got.value.rides.filter((r: any) => r.depEpoch >= T);
  const boards = new Set(rides.map((r: any) => r.boardStopId));
  const hit = nearestPlatform(O, repo.platforms().filter((p: any) => boards.has(p.stopId)), null);
  const departures = rides.map((r: any) => ({ epoch: r.depEpoch, live: false, lineId: r.lineId, headsign: null }));
  const estimated = hurryVerdict({ now: T, walkMeters: hit.walkMeters, departures, ...PACE });
  const routed = hurryVerdict({ now: T, walkMeters: routedM(hit.platform), detour: 1, departures, ...PACE });
  const ctx = { now: T, clock: clockFor(repo.serviceDays(window).days.map((d: any) => d.baseEpoch)) };
  if (estimated.kind !== 'CHILL' || routed.kind !== 'NOT_WORTH_IT') fail(`premise: at T the estimate says CHILL and the routed walk NOT_WORTH_IT (Jamie's bug on the real schedule: the next train follows within 360 s), got ${estimated.kind} / ${routed.kind}`);
  return { estimated, routed, ctx };
}
const copy = (name: string) => load('src/ui/hurry/copy', [name])[name];
function statusLine(v: any, ctx: any): string {
  const { REGULAR_LINE_MAX_CHARS: max } = load('src/ui/now/now-text', ['REGULAR_LINE_MAX_CHARS']);
  const walk = `~${Math.ceil(v.walkS / 60)} min walk`;
  const fits = [`${copy('hurryShort')(v, ctx)} · ${walk}`, `${copy('hurryInline')(v, ctx)} · ${walk}`].find((s) => [...s].length <= max);
  return fits ?? fail(`no status line for ${v.kind} fits ${max} characters`);
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
/** The REAL Now bar for the saved trip Fifth Street -> Bayfront Park, the rider at O, at T; with the walk provider when fetchWalk is given. */
async function bar(placement: 'regular' | 'inline', T: number, fetchWalk: unknown | null) {
  const { NowAccessory } = load('src/ui/now/NowAccessory', ['NowAccessory']);
  const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
  const { UserDbProvider } = load('src/data/user-db-provider', ['UserDbProvider']);
  const { LiveValueProvider } = load('src/live/live-context', ['LiveValueProvider']);
  const { BottomAccessoryPlacementContext } = require('expo-router/build/native-tabs/hooks');
  const t = trips();
  mockFix = O;
  const repos = t.memoryUserRepos();
  if (!repos.ok) fail('the in-memory user DB did not open');
  const made = repos.value.trips.create(t.savedTrip('fifth', FIFTH, BAYFRONT, { createdEpoch: 1_790_000_100 }));
  if (!made.ok) fail(`saving the trip failed: ${made.error.message}`);
  const Provider = WALK.RoutedWalkProvider;
  const now = <BottomAccessoryPlacementContext.Provider value={placement}><NowAccessory clock={() => T} /></BottomAccessoryPlacementContext.Provider>;
  const tree = await renderPrimitive(
    <ScheduleDbProvider><UserDbProvider open={() => repos}><LiveValueProvider value={NO_LIVE}><UserLocationProvider>
      {fetchWalk === null ? now : <Provider fetchWalk={fetchWalk}>{now}</Provider>}
    </UserLocationProvider></LiveValueProvider></UserDbProvider></ScheduleDbProvider>,
  );
  await settleReal();
  return tree;
}
function read(tree: any) {
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  if (button === undefined) fail('no \'now-accessory\' host rendered');
  return { lines: linesOf(button), label: String(button.props.accessibilityLabel ?? '') };
}
/** The REAL station sheet's verdict slot for Fifth Street, the rider at O, at T. */
async function sheet(T: number, fetchWalk: unknown | null) {
  const { StationHurry } = load('src/ui/hurry/StationHurry', ['StationHurry']);
  const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
  const { LiveValueProvider } = load('src/live/live-context', ['LiveValueProvider']);
  mockFix = O;
  const Provider = WALK.RoutedWalkProvider;
  const slot = <StationHurry stationKey={FIFTH} clock={() => T} />;
  const tree = await renderPrimitive(
    <ScheduleDbProvider><LiveValueProvider value={NO_LIVE}><UserLocationProvider>
      {fetchWalk === null ? slot : <Provider fetchWalk={fetchWalk}>{slot}</Provider>}
    </UserLocationProvider></LiveValueProvider></ScheduleDbProvider>,
  );
  await settleReal();
  return tree;
}
/** m7c's station reading at T from O (estimated walks), and each direction's routed verdict over the SAME departures. */
function sheetVerdicts(T: number, routedM: (p: any) => number) {
  const H = load('src/ui/hurry/hurry-reading', ['stationTimetable', 'hurryReading']);
  const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
  const { hurryDepartures } = load('src/domain/hurry/board', ['hurryDepartures']);
  const { mergeDepartures } = load('src/domain/live/merge-departures', ['mergeDepartures']);
  const { nearestPlatform } = load('src/domain/hurry/platform', ['nearestPlatform']);
  const timetable = H.stationTimetable(trips().realScheduleRepo(), FIFTH, T - (T % 60));
  const reading = H.hurryReading({ db: { kind: 'ready' }, position: { coordinate: O, note: null }, timetable, batch: null, nowS: T, pace: PACE });
  if (reading.kind !== 'boards' || timetable.kind !== 'timetable') fail(`premise: m7c reads Fifth Street's boards at T, got ${reading.kind}`);
  const boards = reading.boards.map((b: any) => {
    const scheduled = timetable.departures.filter((d: any) => d.directionId === b.directionId);
    const stopIds = timetable.platforms.filter((p: any) => p.directionIds.includes(b.directionId)).map((p: any) => p.stopId);
    const departures = hurryDepartures(mergeDepartures(scheduled, [], timetable.window).rows, { stopIds, now: T, liveStale: false });
    const hit = nearestPlatform(O, timetable.platforms, b.directionId);
    if (show(hurryVerdict({ now: T, walkMeters: hit.walkMeters, departures, ...PACE })) !== show(b.verdict)) fail(`premise: the oracle rebuilds m7c's direction ${b.directionId} departures exactly`);
    return { directionId: b.directionId, departures, straightM: hit.walkMeters, estimated: b.verdict, routed: hurryVerdict({ now: T, walkMeters: routedM(hit.platform), detour: 1, departures, ...PACE }) };
  });
  return { boards, ctx: reading.ctx };
}

const CASES: Record<string, () => Promise<void>> = {
  // C. Without a provider, useWalkTo is the estimated fallback and does not throw (mfix8's and m7c's tests stay green).
  fallback: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    const { walkFor } = load('src/domain/walk/walk-cache', ['walkFor']);
    mockFix = O;
    try { await mountWalk(null, FIVE, null, false); } catch (e) { fail(`without a provider useWalkTo must not throw (it is the estimated fallback); it threw: ${(e as Error).message.split('\n')[0]}`); }
    await settleReal();
    const got = seen.get('a');
    if (got === undefined) fail('the consumer never saw the rider\'s position');
    for (const s of FIVE) if (show(got[s.stopId]) !== show(plain(walkFor(null, s, O))) || got[s.stopId].source !== 'estimated') fail(`without a provider, stop ${s.stopId}'s walk is walkFor(null, …) (estimated): want ${show(plain(walkFor(null, s, O)))}, got ${show(got[s.stopId])}`);
  },
  // G. Request discipline on the fake clock.
  requests: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    fakeClock();
    Object.assign(AppState, { currentState: 'active' });
    const f = fakeFetch();
    await mountWalk(f.fetchWalk, FIVE, EXTRA);
    await step(5);
    if (f.calls.length !== 0) fail(`no request without a position, got ${f.calls.length}`);
    await fix(O);
    await step(2);
    if (f.calls.length !== 1) fail(`the first fix with wanted stops makes exactly 1 request (within 2 s), got ${f.calls.length}`);
    const c1 = f.calls[0] as Call;
    if (c1.one !== ll(O)) fail(`the request is made from the rider's position ${ll(O)}, got one=${c1.one}`);
    if (show([...c1.many].sort()) !== show(FIVE.map(ll).sort())) fail(`one request carries every wanted stop: want ${show(FIVE.map(ll).sort())}, got ${show(c1.many)}`);
    if (!UA.test(c1.headers['User-Agent'] ?? '')) fail(`the request names the app with m10a's User-Agent, got ${show(c1.headers)}`);
    sourceOf('a', '805', 'routed', 'after the first answer, at the origin');
    await fix(south(100));
    await stepUntil(c1.atS + 80);
    if (f.calls.length !== 1) fail(`moving 100 m (<= 150) makes no request, got ${f.calls.length - 1} more`);
    sourceOf('a', '805', 'routed', '100 m from the origin');
    await fix(south(120));
    await step(5);
    if (f.calls.length !== 1) fail(`a new fix <= 150 m from where the walks were asked for, after the 60 s gap, makes no request (no refresh on every move); got ${f.calls.length - 1}`);
    await fix(south(200));
    await step(2);
    if (f.calls.length !== 2 || f.calls[1]?.one !== ll(south(200))) fail(`moving 200 m (> 150), >= 60 s after the request, makes 1 request from the new position, got ${show(f.calls.slice(1).map((c) => c.one))}`);
    const c2 = f.calls[1] as Call;
    await step(10);
    await fix(south(400));
    await stepUntil(c2.atS + 59);
    if (f.calls.length !== 2) fail(`moving > 150 m within 60 s of the last request makes none until 60 s have passed (one came ${((f.calls[2] as Call).atS - c2.atS).toFixed(0)} s after it)`);
    await stepUntil(c2.atS + 76);
    if (f.calls.length !== 3) fail(`once 60 s have passed since the last request, the pending move is asked for (by 76 s), got ${f.calls.length - 2} request(s)`);
    const c3 = f.calls[2] as Call;
    f.answers.push('pending');
    await stepUntil(c3.atS + 61);
    await fix(south(600));
    await step(2);
    if (f.calls.length !== 4) fail(`a move > 150 m >= 60 s after the last request is asked for, got ${f.calls.length - 3}`);
    await step(5);
    await fix(south(800));
    await act(async () => showExtra());
    await step(70);
    if (f.calls.length !== 4) fail(`while a request is in flight, new fixes and a new consumer's stop make no second request; got ${f.calls.length - 4} more`);
    await act(async () => f.release());
    await step(1);
    await unmountAll();
    // Only while AppState is active.
    const g = fakeFetch();
    Object.assign(AppState, { currentState: 'background' });
    const from = listeners();
    mockFix = null;
    await mountWalk(g.fetchWalk, FIVE);
    await fix(O);
    await step(90);
    if (g.calls.length !== 0) fail(`in the background no request is made, got ${g.calls.length}`);
    await act(async () => setAppState('active', from));
    await step(16);
    if (g.calls.length !== 1) fail(`back in the foreground, the rider with wanted stops gets 1 request (within 16 s), got ${g.calls.length}`);
    await act(async () => setAppState('background', from));
    await step(61);
    await fix(south(200));
    await step(90);
    if (g.calls.length !== 1) fail(`in the background a move > 150 m makes no request, got ${g.calls.length - 1}`);
    settled();
  },
  // G. Batching: the union over every mounted consumer in ONE request; beyond 128 stops, the nearest 128.
  batch: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    fakeClock();
    Object.assign(AppState, { currentState: 'active' });
    const f = fakeFetch();
    const A = FIVE.slice(0, 2), B = FIVE.slice(3);
    await mountWalk(f.fetchWalk, A, B);
    await act(async () => showExtra());
    await step(2);
    await fix(O);
    await step(2);
    const want = [...A, ...B].map(ll).sort();
    if (f.calls.length !== 1 || show([...(f.calls[0] as Call).many].sort()) !== show(want)) fail(`two consumers' stops go in ONE request: want 1 call with ${show(want)}, got ${show(f.calls.map((c) => c.many))}`);
    await unmountAll();
    const MANY = Array.from({ length: 130 }, (_, i) => ({ stopId: `s${i + 1}`, ...north(10 * (i + 1)) }));
    const g = fakeFetch();
    await mountWalk(g.fetchWalk, [...MANY].reverse());
    await step(1);
    await fix(O);
    await step(2);
    const nearest = MANY.slice(0, 128).map(ll).sort();
    if (g.calls.length !== 1 || show([...(g.calls[0] as Call).many].sort()) !== show(nearest)) fail(`130 wanted stops: ONE request for the nearest 128 (the server's maxOneToManySize), got ${g.calls.length} call(s) with ${(g.calls[0] as Call | undefined)?.many.length ?? 0} target(s)`);
    await step(130);
    if (g.calls.length !== 1) fail(`130 wanted stops: the 2 beyond the nearest 128 never re-trigger a request (needsWalkRequest is asked about the 128 sent); got ${g.calls.length - 1} more in 130 s`);
    settled();
  },
  // G. Backoff on 429 / 5xx / network: 60 s, then 120 s; a success resets it; routed values hold <= 300 m from the origin.
  backoff: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    const { walkFor, mergeWalks } = load('src/domain/walk/walk-cache', ['walkFor', 'mergeWalks']);
    fakeClock();
    Object.assign(AppState, { currentState: 'active' });
    const f = fakeFetch();
    f.answers.push(E429, E429, 'ok', E503, ENET);
    await mountWalk(f.fetchWalk, FIVE);
    await fix(O);
    await step(2);
    if (f.calls.length !== 1) fail(`the first fix makes 1 request, got ${f.calls.length}`);
    const at = (i: number) => (f.calls[i] as Call).atS;
    sourceOf('a', '805', 'estimated', 'after a 429 with no answer yet');
    await stepUntil(at(0) + 59);
    if (f.calls.length !== 1) fail(`after a 429 the next attempt waits >= 60 s (one came ${(at(1) - at(0)).toFixed(0)} s later)`);
    await stepUntil(at(0) + 76);
    if (f.calls.length !== 2) fail(`after a 429 the next attempt comes once 60 s have passed (by 76 s), got ${f.calls.length - 1}`);
    await stepUntil(at(1) + 119);
    if (f.calls.length !== 2) fail(`after a second 429 the next attempt waits >= 120 s (one came ${(at(2) - at(1)).toFixed(0)} s later)`);
    await stepUntil(at(1) + 136);
    if (f.calls.length !== 3) fail(`after a second 429 the next attempt comes once 120 s have passed (by 136 s), got ${f.calls.length - 2}`);
    await step(1);
    const cache = mergeWalks(null, { origin: O, requestedAtS: at(2), stops: FIVE, paths: FIVE.map((s) => ({ distanceM: 2 * haversineMeters(O, s), costS: 1 })) });
    const ok805 = sourceOf('a', '805', 'routed', 'after the answer');
    if (Math.abs(ok805.walkMeters - 2 * haversineMeters(O, FIVE[1] as any)) > 1e-6) fail(`the routed walk is the answer's distance, got ${show(ok805)}`);
    await stepUntil(at(2) + 61);
    await fix(south(200));
    await step(2);
    if (f.calls.length !== 4) fail(`a move > 150 m >= 60 s after the answer is asked for, got ${f.calls.length - 3}`);
    const held = sourceOf('a', '805', 'routed', 'after a failed refresh, 200 m from the origin (<= 300 m)');
    if (show(held) !== show(plain(walkFor(cache, FIVE[1], south(200))))) fail(`the kept cache scales the routed walk: want ${show(plain(walkFor(cache, FIVE[1], south(200))))}, got ${show(held)}`);
    await stepUntil(at(3) + 59);
    if (f.calls.length !== 4) fail('after a 503 the next attempt waits >= 60 s');
    await stepUntil(at(3) + 76);
    if (f.calls.length !== 5) fail(`a success resets the backoff: after the next 503 the attempt comes once 60 s have passed (by 76 s), got ${f.calls.length - 4}`);
    await stepUntil(at(4) + 100);
    await fix(south(350));
    await step(1);
    sourceOf('a', '805', 'estimated', 'after failures, 350 m from the cache origin (> 300 m)');
    await stepUntil(at(4) + 119);
    if (f.calls.length !== 5) fail('after a network failure following the 503, the next attempt waits >= 120 s');
    await stepUntil(at(4) + 136);
    if (f.calls.length !== 6) fail(`after the network failure the next attempt comes once 120 s have passed (by 136 s), got ${f.calls.length - 5}`);
    // Any other failure (another status, an unparseable body) backs off too, and the wait doubles to BACKOFF_MAX_S.
    const E404 = { kind: 'http', status: 404, message: 'api.transitous.org answered HTTP 404' };
    f.answers.push(E404, 'garbage', E429, E429, E429, E429, E429);
    await stepUntil(at(5) + 61);
    await fix(south(550));
    await step(2);
    if (f.calls.length !== 7) fail(`a move > 150 m >= 60 s after the answer is asked for, got ${f.calls.length - 6}`);
    const kinds = ['a 404', 'an unparseable body', 'a 429', 'a 429', 'a 429', 'a 429'];
    for (const [k, gap] of [60, 120, 240, 480, 600, 600].entries()) {
      await stepUntil(at(6 + k) + gap - 1);
      if (f.calls.length !== 7 + k) fail(`after ${kinds[k]} (failure ${k + 1} in a row) the next attempt waits >= ${gap} s (60 -> 120 -> 240 -> 480 -> 600 cap), one came ${((f.calls[7 + k] as Call).atS - at(6 + k)).toFixed(0)} s later`);
      await stepUntil(at(6 + k) + gap + 16);
      if (f.calls.length !== 8 + k) fail(`after ${kinds[k]} (failure ${k + 1} in a row) the next attempt comes once ${gap} s have passed (by ${gap + 16} s), got ${f.calls.length - 7 - k}`);
    }
    settled();
  },
  // C. WITHOUT fetchWalk the provider asks through the app's typed HTTP: expo/fetch (src/live/http.ts's EXPO_FETCH).
  default_fetch: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    fakeClock();
    Object.assign(AppState, { currentState: 'active' });
    mockExpoAnswers.splice(0, mockExpoAnswers.length, 'json', 429, 'reject');
    mockExpoCalls.splice(0);
    await mountWalk(undefined, FIVE);
    await fix(O);
    await step(2);
    const c = mockExpoCalls[0];
    if (mockExpoCalls.length !== 1 || c === undefined) fail(`without fetchWalk the provider asks through expo/fetch (the app's typed HTTP): want 1 call, got ${mockExpoCalls.length}`);
    if (!c.url.startsWith('https://api.transitous.org/api/v1/one-to-many?') || !UA.test(c.headers['User-Agent'] ?? '') || typeof (c.signal as AbortSignal | undefined)?.aborted !== 'boolean') fail(`the default fetch GETs the one-to-many URL with m10a's User-Agent under an AbortSignal, got ${show({ url: c.url, headers: c.headers, signal: typeof c.signal })}`);
    const got = sourceOf('a', '805', 'routed', 'after expo/fetch answered 200 with the walks');
    if (Math.abs(got.walkMeters - 2 * haversineMeters(O, FIVE[1] as any)) > 1e-6) fail(`a 200 body is the routed walk: want ${2 * haversineMeters(O, FIVE[1] as any)} m, got ${show(got)}`);
    const at = (i: number) => (mockExpoCalls[i] as { atS: number }).atS;
    await stepUntil(at(0) + 61);
    await fix(south(200));
    await step(2);
    if (mockExpoCalls.length !== 2) fail(`a move > 150 m >= 60 s later is asked for through expo/fetch, got ${mockExpoCalls.length - 1}`);
    await stepUntil(at(1) + 59);
    if (mockExpoCalls.length !== 2) fail('after expo/fetch answered HTTP 429 (a typed http error) the next attempt waits >= 60 s');
    await stepUntil(at(1) + 76);
    if (mockExpoCalls.length !== 3) fail(`after the 429 the next attempt comes once 60 s have passed (by 76 s), got ${mockExpoCalls.length - 2}`);
    await stepUntil(at(2) + 119);
    if (mockExpoCalls.length !== 3) fail('after expo/fetch rejected (offline: a typed network error) the next attempt waits >= 120 s');
    await stepUntil(at(2) + 136);
    if (mockExpoCalls.length !== 4) fail(`after the network failure the next attempt comes once 120 s have passed (by 136 s), got ${mockExpoCalls.length - 3}`);
    sourceOf('a', '805', 'routed', 'after failures, 200 m from the kept cache\'s origin');
    settled();
  },
  // F + E on the REAL Now bar (mfix8's near-trip verdict) fed the committed fixture.
  bar: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    Object.assign(AppState, { currentState: 'active' });
    const T = fixtureInstant();
    const f = fixtureFetch();
    const { estimated, routed, ctx } = tripVerdicts(T, f.routedAt);
    const routedLines = ['Bayfront Park', statusLine(routed, ctx)], estLines = ['Bayfront Park', statusLine(estimated, ctx)];
    const plainBar = read(await bar('regular', T, null));
    if (show(plainBar.lines) !== show(estLines)) fail(`without a provider the bar walks the estimate: want ${show(estLines)}, got ${show(plainBar.lines)}`);
    if (!/\bestimated\b/i.test(plainBar.label) || /walk along streets/i.test(plainBar.label)) fail(`an estimated walk's label says "estimated", never "walk along streets": ${show(plainBar.label)}`);
    await unmountAll();
    const tree = await bar('regular', T, f.fetchWalk);
    await untilCalls(f.calls, 1);
    const routedBar = read(tree);
    if (f.calls.length !== 1) fail(`the bar costs exactly 1 one-to-many request, got ${f.calls.length}`);
    if (show(routedBar.lines) !== show(routedLines)) fail(`fed the fixture, the bar walks the routed ${f.routedAt(FIVE[1] as any).toFixed(1)} m: want ${show(routedLines)} (estimated: ${show(estLines)}), got ${show(routedBar.lines)}`);
    if (!routedBar.label.includes(copy('hurrySentence')(routed, ctx)) || !/walk along streets/i.test(routedBar.label) || /\bestimated\b/i.test(routedBar.label)) fail(`a routed walk's label carries the routed sentence and "walk along streets", never "estimated": ${show(routedBar.label)}`);
    await unmountAll();
    const g = fixtureFetch();
    const inline = await bar('inline', T, g.fetchWalk);
    await untilCalls(g.calls, 1);
    if (show(read(inline).lines) !== show([copy('hurryInline')(routed, ctx)])) fail(`inline, fed the fixture: want ${show([copy('hurryInline')(routed, ctx)])}, got ${show(read(inline).lines)}`);
    await unmountAll();
    // Under the provider with no routed walk to give (its one request failed), the walk is the estimate, and says so.
    const h = fakeFetch();
    h.answers.push(E503);
    const failed = await bar('regular', T, h.fetchWalk);
    await untilCalls(h.calls, 1);
    const failedBar = read(failed);
    if (h.calls.length !== 1 || show(failedBar.lines) !== show(estLines) || !/\bestimated\b/i.test(failedBar.label) || /walk along streets/i.test(failedBar.label)) fail(`under the provider with its only request failed, the bar walks the estimate ${show(estLines)} and its label says "estimated", never "walk along streets"; got ${show(failedBar)} after ${h.calls.length} request(s)`);
    settled();
  },
  // F on the REAL station sheet (m7c's StationHurry) fed the committed fixture.
  sheet: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    Object.assign(AppState, { currentState: 'active' });
    const T = fixtureInstant();
    const f = fixtureFetch();
    const { boards, ctx } = sheetVerdicts(T, f.routedAt);
    if (boards.length === 0 || boards.some((b: any) => b.estimated.kind !== 'CHILL' || b.routed.kind !== 'NOT_WORTH_IT')) fail(`premise: on every Fifth Street card the estimate says CHILL and the routed walk NOT_WORTH_IT, got ${show(boards.map((b: any) => [b.directionId, b.estimated.kind, b.routed.kind]))}`);
    const labels = (tree: any) => Object.fromEntries(boards.map((b: any) => [b.directionId, hostsByTestID(tree.root, `hurry-card-${b.directionId}`)[0]?.props.accessibilityLabel ?? null]));
    const want = (k: 'estimated' | 'routed') => Object.fromEntries(boards.map((b: any) => [b.directionId, copy('hurrySentence')(b[k], ctx)]));
    const plainSheet = labels(await sheet(T, null));
    if (show(plainSheet) !== show(want('estimated'))) fail(`without a provider the sheet keeps m7c's estimated verdicts: want ${show(want('estimated'))}, got ${show(plainSheet)}`);
    await unmountAll();
    const tree = await sheet(T, f.fetchWalk);
    await untilCalls(f.calls, 1);
    if (f.calls.length !== 1) fail(`the sheet costs exactly 1 one-to-many request, got ${f.calls.length}`);
    if (show(labels(tree)) !== show(want('routed'))) fail(`fed the fixture, every direction's card walks the routed distance: want ${show(want('routed'))}, got ${show(labels(tree))}`);
    await unmountAll();
    // Only a CHILL or JOG sentence shows how FAR the walk is (its spare minutes). 300 s earlier (700 s of slack) every
    // card is CHILL with the spare the routed 710.6 m leaves; a fixed detour or the routing cost would leave another.
    const T2 = T - 300;
    const g = fixtureFetch();
    const second = sheetVerdicts(T2, g.routedAt);
    const say = (v: any) => copy('hurrySentence')(v, second.ctx);
    const { hurryVerdict: judge } = load('src/domain/hurry/verdict', ['hurryVerdict']);
    const fx = fixtureJson();
    const cost805 = fx.response[fx.request.many.findIndex((t: any) => t.stopId === '805')].duration;
    for (const b of second.boards) {
      const asIf = (walkMeters: number) => say(judge({ now: T2, walkMeters, detour: 1, departures: b.departures, ...PACE }));
      if (b.routed.kind !== 'CHILL' || [say(b.estimated), asIf(b.straightM * 1.6), asIf(cost805)].includes(say(b.routed))) fail(`premise: 300 s earlier direction ${b.directionId}'s routed sentence is CHILL and differs from the estimate's, a fixed 1.6 detour's and the routing cost's, got ${say(b.routed)}`);
    }
    const want2 = Object.fromEntries(second.boards.map((b: any) => [b.directionId, say(b.routed)]));
    const labels2 = (t: any) => Object.fromEntries(second.boards.map((b: any) => [b.directionId, hostsByTestID(t.root, `hurry-card-${b.directionId}`)[0]?.props.accessibilityLabel ?? null]));
    const early = await sheet(T2, g.fetchWalk);
    await untilCalls(g.calls, 1);
    if (show(labels2(early)) !== show(want2)) fail(`300 s earlier (700 s of slack), fed the fixture, every card says the spare the routed walk leaves: want ${show(want2)}, got ${show(labels2(early))}`);
    settled();
  },
  // D. The route chip OFF the plan start walks walkFor to the first ride's boarding platform.
  chip: async () => {
    const f = load('src/ui/routes/__tests__/route-fixtures', ['fixtureItineraries', 'FIXTURE_NETWORK', 'START', 'ASKED_AT_S']);
    const { routeOptions, CHIP_ROUTED_START_M } = load('src/ui/routes/route-options', ['routeOptions', 'CHIP_ROUTED_START_M']);
    const { walkFor, mergeWalks, walkKey } = load('src/domain/walk/walk-cache', ['walkFor', 'mergeWalks', 'walkKey']);
    const { gtfsStopId } = load('src/domain/routes/overlay', ['gtfsStopId']);
    if (CHIP_ROUTED_START_M !== 50) fail(`premise: mfix8's CHIP_ROUTED_START_M is 50, got ${show(CHIP_ROUTED_START_M)}`);
    const away = { latitude: f.START.latitude - 300 / perDeg, longitude: f.START.longitude };
    const itineraries = f.fixtureItineraries();
    const rideOf = (it: any) => it.legs.find((l: any) => l.tripId !== null);
    const stops = new Map<string, any>();
    const boardingOf = (r: any) => ({ stopId: gtfsStopId(r.from.stopId), latitude: r.from.latitude, longitude: r.from.longitude });
    for (const it of itineraries) { const r = rideOf(it); if (r !== undefined && r.from.stopId !== null) stops.set(walkKey(boardingOf(r)), boardingOf(r)); }
    const routedM = (s: any) => haversineMeters(away, s) * 1.7;
    const cache = mergeWalks(null, { origin: away, requestedAtS: f.ASKED_AT_S, stops: [...stops.values()], paths: [...stops.values()].map((s) => ({ distanceM: routedM(s), costS: 1 })) });
    const walk = (c: unknown) => (stop: any) => { const s = stop?.stopId === undefined ? undefined : stops.get(walkKey(stop)); if (s === undefined) fail(`the chip asked walk(${show(stop)}), not a first ride's boarding stop (its GTFS stop_id at its coordinates)`); return walkFor(c, s, away); };
    const context = (w: unknown) => ({ position: away, nowS: f.ASKED_AT_S, pace: PACE, ...(w === null ? {} : { walk: w }) });
    const byWalk = routeOptions(itineraries, f.FIXTURE_NETWORK, context(walk(cache)));
    const straightOf = (o: any) => routeOptions([o.itinerary], f.FIXTURE_NETWORK, context(null))[0];
    let checked = 0;
    for (const option of byWalk) {
      const ride = rideOf(option.itinerary);
      if (ride === undefined || option.verdict === null) continue;
      const s = stops.get(walkKey(boardingOf(ride)));
      const want = routedM(s);
      if (Math.abs(option.verdict.walkS - want / 1.35) > 0.05 || Math.abs(option.verdict.jogS - want / 2.7) > 0.05) fail(`option ${option.id}, 300 m off the plan start: the chip walks walkFor's routed ${want.toFixed(1)} m to stop ${s.stopId} (walkS ${(want / 1.35).toFixed(1)}), got walkS ${show(option.verdict.walkS)}`);
      const straight = haversineMeters(away, s) * 1.3 / 1.35;
      const plainV = straightOf(option).verdict;
      if (plainV === null || Math.abs(plainV.walkS - straight) > 0.05) fail(`option ${option.id}: without a walk the chip keeps mfix5's straight line x 1.3 (walkS ${straight.toFixed(1)}), got ${show(plainV?.walkS)}`);
      const estV = routeOptions([option.itinerary], f.FIXTURE_NETWORK, context(walk(null)))[0].verdict;
      if (estV === null || Math.abs(estV.walkS - straight) > 0.05) fail(`option ${option.id}: an estimated walk off the start is the straight line x 1.3 (walkS ${straight.toFixed(1)}), got ${show(estV?.walkS)}`);
      checked += 1;
    }
    if (checked < 2) fail(`only ${checked} fixture option(s) have a first ride — the oracle needs >= 2`);
    // At the start (within 50 m), mfix8's routed plan legs still win.
    let atStart = 0;
    for (const option of routeOptions(itineraries, f.FIXTURE_NETWORK, { position: f.START, nowS: f.ASKED_AT_S, pace: PACE, walk: walk(cache) })) {
      const legs = option.itinerary.legs;
      const first = legs.findIndex((l: any) => l.tripId !== null);
      const before = legs.slice(0, Math.max(first, 0)).filter((l: any) => l.mode === 'WALK');
      if (first < 1 || before.length === 0 || before.some((l: any) => l.distanceM === null) || option.verdict === null) continue;
      const sum = before.reduce((a: number, l: any) => a + l.distanceM, 0);
      if (Math.abs(option.verdict.walkS - sum / 1.35) > 0.05) fail(`option ${option.id} at the plan start: mfix8's routed WALK legs (${sum} m) still set the chip, got walkS ${show(option.verdict.walkS)}`);
      atStart += 1;
    }
    if (atStart < 2) fail(`only ${atStart} option(s) at the start have routed walk legs — the oracle needs >= 2`);
  },
  // D. The REAL route options sheet ("Route from here", mfix5's harness): the rider 400 m north of Government Center,
  // off the plan start, so its chips walk the provider's routed walk to the first ride's boarding stop. Then (mfix8 F2)
  // a plan from the rider's OWN location, the rider 300 m off its start: the same, through the same registration.
  chip_screen: async () => {
    WALK = load('src/ui/walk/RoutedWalkProvider', ['RoutedWalkProvider', 'useWalkTo']);
    const { PlanScreen } = load('src/ui/routes/PlanScreen', ['PlanScreen']);
    const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
    const { recordRecentPlace } = load('src/ui/routes/recent-places', ['recordRecentPlace']);
    const { press } = load('src/ui/stations/__tests__/press', ['press']);
    const R = load('src/ui/routes/__tests__/route-fixtures', ['ASKED_AT_S', 'END', 'START', 'fixtureItineraries']);
    jest.useFakeTimers({ now: R.ASKED_AT_S * 1000, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    Object.assign(AppState, { currentState: 'active' });
    const STATION_AT = { latitude: 25.775864, longitude: -80.196093 };
    mockFix = { latitude: STATION_AT.latitude + 400 / 111_195, longitude: STATION_AT.longitude };
    if (!recordRecentPlace(R.END).ok) fail('premise: the destination is saved as a recent place');
    // Every sheet opens at the fixture's query time, so chips compared across mounts are judged at the same instant.
    const atQueryTime = () => { jest.setSystemTime(R.ASKED_AT_S * 1000); if (Date.now() !== R.ASKED_AT_S * 1000) fail('premise: the fake clock is back at the query time'); };
    const chipOf = async (fetchWalk: unknown | null) => {
      atQueryTime();
      const screen = <PlanScreen fromStation="mover:government-center" />;
      const tree = await renderPrimitive(<UserLocationProvider><ScheduleDbProvider>{fetchWalk === null ? screen : <WALK.RoutedWalkProvider fetchWalk={fetchWalk}>{screen}</WALK.RoutedWalkProvider>}</ScheduleDbProvider></UserLocationProvider>);
      await step(1);
      await press(tree, 'plan-recent-0');
      await step(4);
      const chip = hostsByTestID(tree.root, 'route-option-0-hurry')[0];
      if (chip === undefined) fail('premise: the first option has a hurry chip');
      return String(chip.props.accessibilityLabel);
    };
    const plainChip = await chipOf(null);
    await unmountAll();
    const none = fakeFetch((q) => q.many.map(() => ({})));
    const noWalk = await chipOf(none.fetchWalk);
    await unmountAll();
    const f = fakeFetch();
    const routedChip = await chipOf(f.fetchWalk);
    if (none.calls.length !== 1 || f.calls.length !== 1) fail(`the sheet registers its first rides' boarding stops: 1 one-to-many request each, got ${none.calls.length} and ${f.calls.length}`);
    if (noWalk !== plainChip) fail(`with no routed walk to give (every target {}), the chip is the estimate ${show(plainChip)}, got ${show(noWalk)}`);
    if (routedChip === plainChip) fail(`the rider 400 m off the plan start: the chip must walk the provider's routed walk (2x the straight line) to the first ride's boarding stop, not the estimate (${show(plainChip)})`);
    await unmountAll();
    // A plan from the rider's OWN location starts at the one fix taken as the sheet opens (the fixture's START); the
    // rider has since walked 300 m south (> CHIP_ROUTED_START_M). The chips follow the rider for EVERY plan (mfix8 F2),
    // so the sheet registers its first rides' boarding stops here too: routed when the provider is fed, else the estimate.
    const rider = { latitude: R.START.latitude - 300 / perDeg, longitude: R.START.longitude };
    const rides = R.fixtureItineraries().map((it: any) => it.legs.find((l: any) => l.tripId !== null)).filter((r: any) => r !== undefined && r.from.stopId !== null);
    const wantMany = [...new Set<string>(rides.map((r: any) => ll(r.from)))].sort();
    if (wantMany.length < 2) fail(`premise: m10a's fixture has >= 2 first-ride boarding stops, got ${show(wantMany)}`);
    mockStart = { latitude: R.START.latitude, longitude: R.START.longitude };
    mockFix = rider;
    const fromHere = async (fetchWalk: unknown | null) => {
      atQueryTime();
      const screen = <PlanScreen fromStation={null} />;
      const tree = await renderPrimitive(<UserLocationProvider><ScheduleDbProvider>{fetchWalk === null ? screen : <WALK.RoutedWalkProvider fetchWalk={fetchWalk}>{screen}</WALK.RoutedWalkProvider>}</ScheduleDbProvider></UserLocationProvider>);
      await step(1);
      await press(tree, 'plan-recent-0');
      await step(4);
      const chips = hostsByTestID(tree.root, /^route-option-\d+-hurry$/).map((c: any) => String(c.props.accessibilityLabel));
      if (chips.length === 0) fail('premise: the plan from the rider\'s location has hurry chips');
      return chips;
    };
    const plainHere = await fromHere(null);
    await unmountAll();
    const noneHere = fakeFetch((q) => q.many.map(() => ({})));
    const estHere = await fromHere(noneHere.fetchWalk);
    await unmountAll();
    const fedHere = fakeFetch();
    const routedHere = await fromHere(fedHere.fetchWalk);
    for (const [what, calls] of [['with no routed walk to give', noneHere.calls], ['fed', fedHere.calls]] as const) {
      const c = calls[0] as Call | undefined;
      if (calls.length !== 1 || c === undefined) fail(`a plan from the rider's own location, the rider located (${what}): the sheet registers its first rides' boarding stops (useWalkTo) for EVERY plan — want 1 one-to-many request, got ${calls.length}`);
      if (c.one !== ll(rider)) fail(`a plan from the rider's own location (${what}): the walks are asked from where the rider is now (${ll(rider)}), not the plan's start; got one=${c.one}`);
      if (show([...c.many].sort()) !== show(wantMany)) fail(`a plan from the rider's own location (${what}): the request carries exactly the first rides' boarding stops ${show(wantMany)}, got ${show(c.many)}`);
    }
    if (show(estHere) !== show(plainHere)) fail(`a plan from the rider's own location, 300 m off its start, with no routed walk to give: every chip is the estimate ${show(plainHere)}, got ${show(estHere)}`);
    const same = routedHere.findIndex((label, k) => routedHere.length !== plainHere.length || label === plainHere[k]);
    if (same >= 0) fail(`a plan from the rider's own location, the rider 300 m off its start (mfix8 F2: the chips follow the rider): every chip must walk the provider's routed walk (2x the straight line) to its first ride's boarding stop, not the estimate; chip ${same} says ${show(routedHere[same])} (estimate ${show(plainHere[same])})`);
    settled();
  },
};
it('ratchet oracle', async () => {
  const run = CASES[CASE];
  if (run === undefined) fail('unknown oracle case');
  await run();
  expect(CASE.length).toBeGreaterThan(0);
}, 300_000); // the fake-clock cases step hundreds of 1 s acts; real-DB renders: never trip jest's 5 s default
TSX
  out=$(MFIX9_CASE="$which" local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.tsx' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 -o "ratchet-oracle:.*"; else echo "$out" | tail -25; fi
    echo "ratchet: mfix9 oracle '$which' failed"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the mfix9 oracle '$which' did not run"; return 1; }
  echo "ratchet: mfix9 oracle '$which' holds on the shipped app"
}


# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix9_routed_walk gate failed at verify script line $LINENO"' ERR

# --- (A) The one-to-many client, pure --------------------------------------------------------------------------
# 1. (ARBITER FIX ROUND Q3: parseWalkTimes never throws: n outside 1..128 and any key besides distance/duration are Errs; {} stays null.) Direct tsx call: WALK_ROUTER_URL / WALK_MAX_TARGETS 128 / WALK_MAX_S 3600 / WALK_MATCH_M 250; buildWalkRequest writes the exact query (one=815, many=805,806, mode=WALK, max=3600, maxMatchingDistance=250, arriveBy=false, withDistance=true) with headers exactly { User-Agent: transitousUserAgent(v) } === buildPlanRequest's (m10a) for two versions, imported (no 'MiamiTransit' in one-to-many.ts); 128 targets ok; 0 / 129 targets and non-finite coordinates are Errs; parseWalkTimes reads {distanceM, costS} | null ({} = no path) and Errs on a wrong length, a non-array, a duration without a distance and anything else; nothing throws.
mfix9_pure client
# 2. The client's own jest tests exist and pass.
jest_nonempty "$MFIX9_CLIENT_TEST"

# --- (B) The walk-cache policy, pure ---------------------------------------------------------------------------
# 3. Direct tsx call: the four constants; needsWalkRequest (backoff, 60 s gap, strictly > 150 m, a missing entry, no cache); walkFor routed <= 300 m from the origin (distanceM x straightNow / straightAtOrigin; just distanceM under 50 m, never a division by zero; detour 1), estimated otherwise (straight line x HURRY_DEFAULTS.detour, imported — no literal 1.3 in walk-cache.ts). ARBITER FIX ROUND Q1: mergeWalks keeps every entry the answer does not replace (each with its own origin; needsWalkRequest and walkFor judge each stop by it), dropped > 300 m from the answer's origin, and dropStaleWalks drops > 300 m from the rider; Q5: a stop sharing a raw stop_id at another place never shares a walk.
mfix9_pure cache

# --- (F) The committed fixture: Jamie's bug in public data -----------------------------------------------------
# 4. Direct tsx call: the fixture parses into 5 walks with routed/straight ratios 2.03, 2.08, 1.31, 1.63, 1.19; 815 -> 805 straight 342.03 m -> estimated walkS 329.36; routed 710.64 m -> walkS 526.40, jogS 263.20; one departure at now + 30 + 400 s: estimated CHILL, routed JOG.
mfix9_pure fixture
# 5. One passing test (src/domain/walk/__tests__/walk-cache.test.ts).
jest_cases "$MFIX9_CACHE_TEST" 'the fixture walk says jog where the estimate says chill'

# --- (H) Fixture hygiene (public repo) ------------------------------------------------------------------------
# 6. src/domain/walk/__fixtures__/transitous-one-to-many.json: origin = GTFS stop 815 at schedule.db's coordinates; every target a GTFS stop at its schedule.db coordinates; _provenance names Transitous and ODbL; one {duration, distance} or {} per target; no key or geometry field anywhere.
fixture_hygiene

# --- (C) ONE runtime, mounted once ----------------------------------------------------------------------------
# 7. Grep: outside src/domain/walk and tests only src/ui/walk/RoutedWalkProvider.tsx references WALK_ROUTER_URL or buildWalkRequest (and calls buildWalkRequest); the endpoint literal is only in one-to-many.ts; only src/app/_layout.tsx mounts <RoutedWalkProvider; the User-Agent is written only by transitous.ts's transitousUserAgent, which buildPlanRequest calls; the provider imports EXPO_FETCH from src/live/http.ts (its default fetch); src/ui/now/near-trip-walk.ts exports useNearTripWalk, which calls useWalkTo; src/ui/now, src/ui/hurry and src/ui/routes each read the walk through useWalkTo(...).
walk_wiring
# 8. The root layout mounts exactly one RoutedWalkProvider inside UserLocationProvider, around the root Stack.
root_mounts_walk
# 9. Oracle: WITHOUT a provider, useWalkTo returns walkFor(null, …) (estimated) for every stop and does not throw.
mfix9_oracle fallback
# 10. One passing test (src/ui/walk/__tests__/RoutedWalkProvider.test.tsx).
jest_cases "$MFIX9_PROVIDER_TEST" 'without a provider the walk is the estimated fallback'

# --- (G) Request discipline (fake fetch, fake clock stepped 1 s at a time) -------------------------------------
# 11. Oracle: no fix -> no request; the first fix -> exactly 1 (within 2 s) from the rider's position, every wanted stop, m10a's User-Agent; <= 150 m -> none; > 150 m and >= 60 s -> 1; > 150 m inside 60 s -> none until 60 s, then 1 (by 76 s); a pending request + new fixes + a new consumer -> still 1 call; backgrounded -> none, foregrounded -> 1 (within 16 s).
mfix9_oracle requests
# 12. Oracle: two consumers' stops go in ONE request; 130 wanted stops (registered farthest first) -> one request for the nearest 128.
mfix9_oracle batch
# 13. Oracle: 429 -> the next attempt >= 60 s later (by 76), a second 429 -> >= 120 s (by 136); a success resets it (503 -> 60 s); network -> 120 s; after failures the routed walk holds (scaled, from the kept cache) <= 300 m from the origin and is estimated beyond.
mfix9_oracle backoff
# 13b. Oracle: WITHOUT fetchWalk the provider asks through the app's typed HTTP (expo/fetch, mocked as the native module): the one-to-many URL with m10a's User-Agent under an AbortSignal; a 200 body is the routed walk; a 429 backs off 60 s; a rejection (offline) 120 s.
mfix9_oracle default_fetch
# 14. One passing test (src/ui/walk/__tests__/RoutedWalkProvider.test.tsx).
jest_cases "$MFIX9_PROVIDER_TEST" 'routed walk requests are few, batched and backed off'

# --- (D, E, F) Every verdict walks the routed distance when one is known ---------------------------------------
# 15. Oracle, REAL Now bar (mfix8's near-trip verdict), saved trip Fifth Street -> Bayfront Park, rider at stop 815, T = the first 805 ride - 430 s (premise, the shipped engine: estimated CHILL, routed NOT_WORTH_IT): without a provider ["Bayfront Park", <estimated CHILL status>] and a label saying "estimated"; fed the fixture (exactly 1 request) ["Bayfront Park", <routed NOT_WORTH_IT status, "~9 min walk">] and a label with the routed sentence and "walk along streets", never "estimated"; inline [hurryInline(routed)]; under the provider with its one request failed, the estimate, labelled "estimated".
mfix9_oracle bar
# 16. One passing test each (src/ui/now/__tests__/routed-walk-bar.test.tsx).
jest_cases "$MFIX9_BAR_TEST" 'the bar walks the routed fixture distance instead of the estimate' 'only an estimated walk is labelled estimated'
# 17. Oracle, REAL station sheet (StationHurry, Fifth Street, rider at 815, T): without a provider every card says m7c's estimated sentence (CHILL); fed the fixture (exactly 1 request) every card says the routed verdict over the same departures (NOT_WORTH_IT); 300 s earlier every card is CHILL with the spare the routed 710.6 m leaves (not the estimate's, a fixed 1.6 detour's or the routing cost's).
mfix9_oracle sheet
# 18. One passing test (src/ui/hurry/__tests__/routed-walk-sheet.test.tsx).
jest_cases "$MFIX9_SHEET_TEST" 'the station sheet walks the routed fixture distance instead of the estimate'
# 19. Oracle on m10a's fixture: 300 m off the plan start with OptionContext.walk, every chip walks walkFor to its first ride's GTFS boarding stop (its stop_id at its coordinates; routed, no detour); without walk, or with an estimated walk, mfix5's straight line x 1.3; at the start mfix8's routed WALK legs still set it.
mfix9_oracle chip
# 19b. Oracle, the REAL route options sheet under RoutedWalkProvider: "Route from here", the rider 400 m off the start -> 1 one-to-many request for its first rides' boarding stops; its chip walks the routed walk, not the estimate; with no routed walk to give, the estimate. Then (mfix8 F2) a plan from the rider's OWN location, the rider 300 m off its start: 1 request from the rider for exactly the first rides' boarding stops; fed, every chip walks the routed walk; with no routed walk to give, every chip is the no-provider estimate.
mfix9_oracle chip_screen
# 20. One passing test (src/ui/routes/__tests__/routed-walk-chip.test.tsx).
jest_cases "$MFIX9_CHIP_TEST" 'a rider 300 m off the plan start gets the routed walk'
# 20b. The arbiter fix rounds' named tests, each its own passing test (Q1 churn, Q2/Z2/Z5 bugs, Q3/Z1 never throws, Q4 at-start chip, Z4 Diagnostics).
jest_cases "$MFIX9_CHURN_TEST" 'alternating stop sets, the rider still for 10 minutes, cost exactly 2 requests' '130 wanted stops, the rider jittering 3 m for 10 minutes, ask nothing after the first round' 'moving 200 m refreshes the wanted stops, and entries from more than 300 m back are dropped'
jest_cases "$MFIX9_BUGS_TEST" 'a throwing answer handler reaches the bug channel' "an abandoned request's late answer is dropped quietly" 'a walk bug after the provider unmounts still reaches the bug channel'
jest_cases "$MFIX9_CHIP_TEST" "at the plan start a first walk missing a leg distance walks the boarding stop's routed walk"
jest_cases "$MFIX9_CLIENT_TEST" 'reads an answer for a count of targets no request carries as an Err, never a throw' 'refuses a walk with any key besides its distance and duration, and still reads {} as no walk' 'an entry whose only key is empty is an Err, never a throw'
jest_cases "$MFIX9_DIAG_TEST" 'diagnostics shows the live runtime internal error and the routed walks status'

# --- Tests mock only native packages (guarded on this card's files) --------------------------------------------
# 21. mfix6's helper over every directory this card's tests live in.
after_card mocks_native_only src/domain/walk/__tests__
after_card mocks_native_only src/ui/walk/__tests__
after_card mocks_native_only src/ui/now/__tests__
after_card mocks_native_only src/ui/hurry/__tests__
after_card mocks_native_only src/ui/routes/__tests__
after_card mocks_native_only src/ui/diagnostics/__tests__

# --- Repo-wide ----------------------------------------------------------------------------------------------------
# 22. (guarded) Metro bundles the app for iOS on a private cache (TMPDIR=.cache/metro-tmp-mfix9), and the --no-bytecode bundle carries the one-to-many URL.
card_export_carries 'https://api.transitous.org/api/v1/one-to-many'
# 23. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every test), node:test — all green.
card_full_gate

echo "mfix9_routed_walk: all 35 gate lines green"
