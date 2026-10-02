#!/usr/bin/env bash
# mfix8_trip_bar — the Now bar judges a SAVED trip, or says "Where to?" (decision.miami_transit_bar_uses_saved_trips,
# Jamie 2026-10-02 08:40: "By biggest gripe is how it says 'not worth it next in 10 min fifth street' without me even
# entering where I wanna go"), plus his 08:41 asks: save a trip from route options, an honest routed walk on the route
# chip, labelled numbers, a bar that fits and names what it judges, and a labelled walk estimate.
# Today (main 370191b) the bar judges the NEAREST station (Fifth Street) in whichever direction leaves first.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not stop
# the script); compound checks live inside the card helpers below. Helpers read no variable another gate set.
# Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix8_trip_bar.sh
#
# BINDING CONTRACT (the oracles below load these by name; the card note spells out the copy):
#   src/ui/now/homeContext.ts   export const NEAR_TRIP_M  (=== HURRY_RANGE_M, 2000): a saved trip is NEAR when the
#                               straight-line metres from the rider to its origin station's nearest platform <= it
#   src/ui/now/now-text.ts      export const REGULAR_LINE_MAX_CHARS (30..38): every line of the regular bar fits it
#   src/ui/hurry/copy.ts        export function hurryShort(verdict, ctx) — the labelled short copy (chip + bar);
#                               hurryInline (<= 14) changes to the labelled/word-only strings; hurryCopy, hurryParts
#                               and hurrySentence (the station sheet's cards) do not change
#   NowAccessory (testID 'now-accessory'), its regular placement: one host <Text> per line, numberOfLines 1
#   ItineraryDetail: testID 'itinerary-save-trip' (a single-ride itinerary) / 'itinerary-save-trip-why' (multi-ride)
#   src/domain/routes/overlay.ts firstLegVerdict(itinerary, position, now, pace = {}, routedWalk = false) — opt-in routed walk
#   src/ui/routes/route-options.ts export const CHIP_ROUTED_START_M = 50 (the chip opts in only within it of the plan start)
#
# TEST-NAME CONVENTION (verify-mfix6's): each acceptance case is its OWN passing jest test whose full name (describe
# titles + test title, one space, case-insensitive) ENDS with the case's exact phrase at a word boundary.
MFIX8_JEST_CASES=(
  'with no saved trip near the bar says where to and gives no verdict'
  'tapping where to opens route options'
  'a near saved trip is judged from its origin with only rides that reach its destination'
  'the near saved trip with the soonest leave-by takes the bar'
  'an active trip countdown keeps priority over a near trip'
  'a trip origin at the near limit is near and one metre beyond is not'
  'the bar watches only the judged trip origin'
  'an estimated walk is labelled as estimated'
  'every bar line fits the measured budget'
  'every verdict number is labelled'
  'the hurry chip walks the routed first walk leg'
  'a single-ride itinerary saves as a trip'
  'a multi-ride itinerary offers no save and says why'
)
# The card's own test files (the guard for the repo-wide and re-check gates).
MFIX8_BAR_TEST=src/ui/now/__tests__/trip-bar.test.tsx
MFIX8_ROUTE_TEST=src/ui/routes/__tests__/save-and-walk.test.tsx
MFIX8_COPY_TEST=src/ui/hurry/__tests__/labelled-copy.test.ts

# ---- card helpers (each fails loud with a named reason, like lib.sh) ----
# jest_cases: copied from verify-mfix6_one_location_watch.sh (only the card universe and report names adjusted).
# jest_cases <file-or-dir> <phrase>... — ONE unfiltered local-jest run over EXACTLY the path (a file by
# --runTestsByPath; a directory by its anchored, escaped absolute prefix — lib.sh jest_nonempty's selection)
# with a JSON report: jest green, >= 1 test passed, none failed/skipped/todo; then every phrase must be in
# MFIX8_JEST_CASES and must END the full name of >= 1 PASSED test whose name ends with no other card phrase.
jest_cases() {
  local path="$1" report out sel=(); shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one phrase"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -f "$path" ]; then sel=(--runTestsByPath "$path")
  else sel=("^$(cd "$path" && pwd -P | sed 's/[][\.*^$+?(){}|]/\\&/g')/"); fi
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report="$PWD/.cache/ratchet/mfix8_trip_bar.$(printf '%s' "$path" | tr '/' '_').json"
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
if (new Set(universe).size !== universe.length) authoring.push("MFIX8_JEST_CASES lists a phrase twice");
for (const a of universe) for (const b of universe) if (a !== b && ends(b, a)) authoring.push(`"${b}" ends with "${a}"`);
for (const w of wanted) if (!universe.includes(w)) authoring.push(`"${w}" is not in MFIX8_JEST_CASES`);
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
' "$report" "$path" "$#" "$@" "${MFIX8_JEST_CASES[@]}" || return 1
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

# The card's own test files: the guard for the repo-wide gates and the re-checks (a bare full_gate is green on the
# unbuilt tree, so it runs only once every file this card adds exists).
card_files() {
  need_files "$MFIX8_BAR_TEST" "$MFIX8_ROUTE_TEST" "$MFIX8_COPY_TEST" || return 1
}

# after_card <gate> <args>... — a re-check of behaviour an EARLIER card built (m7c's station-sheet cards, m7b's
# night/at-station context, mfix6's one watch) that this card's edits could break, run only WITH this card's files.
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
# PRIVATE Metro cache (TMPDIR; mfix2/m10b/mfix6 pattern), then a --no-bytecode export (never a .hbc grep: Hermes
# bytecode stores strings in its own table) must carry <text> as a whole string literal.
card_export_carries() {
  local text="$1" metro_tmp="$PWD/.cache/metro-tmp-mfix8" dir=.cache/export-mfix8-js out rc=0
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
  [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle has no whole string literal \"$text\" — the bar's no-trip text is not shipped"; return 1; }
  [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  echo "ratchet: the iOS bundle exports and carries \"$text\""
}

# mfix8_oracle <case> — the card's behaviour checked on the SHIPPED app, independent of the builder's tests: a
# throwaway jest test in the gitignored .cache (removed whether it passes or fails; m7c copy_is's pattern) under the
# repo's own jest-expo/ios transform. It renders the REAL NowAccessory inside the REAL UserLocationProvider,
# ScheduleDbProvider (the committed assets/db/schedule.db through node:sqlite) and UserDbProvider (an in-memory
# user.db migrated by the app's own migrations, saved trips written through the REAL SavedTripsRepo), pinned to
# 08:00 Wed 2026-09-30, with labelled native mocks of expo-sqlite, expo-sqlite/kv-store and expo-location only.
# Expected values come from the shipped engine (tripRides, nearestPlatform, hurryVerdict, tripCards, heroOf).
# The rider P = (25.7690, -80.1940): 301 m from Brickell City Centre, 176 m from Fifth Street (the nearest station).
# Cases: where_to trip_verdict soonest countdown near_boundary near_exact live_merge watch budget copy copy_unchanged chip_walk
# first_leg_optin save_trip
mfix8_oracle() {
  local which="$1" dir out rc=0
  case "$which" in where_to|trip_verdict|soonest|countdown|near_boundary|near_exact|live_merge|watch|budget|copy|copy_unchanged|chip_walk|first_leg_optin|save_trip) ;;
    *) echo "ratchet: verify-script authoring error: unknown mfix8 oracle case '$which'"; return 1 ;; esac
  need_files src/ui/now/NowAccessory.tsx src/ui/location/UserLocationProvider.tsx src/data/user-db-provider.tsx src/ui/trips/__tests__/trip-db.ts || return 1
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-mfix8-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/bar.oracle.test.tsx" <<'TSX'
const path = require('node:path');
const CASE = process.env.MFIX8_CASE ?? '';
const fail = (m: string): never => { throw new Error(`ratchet-oracle: ${CASE}: ${m}`); };
const show = (v: unknown): string => JSON.stringify(v);
const load = (rel: string, names: string[]): Record<string, any> => {
  let mod: Record<string, any> = {};
  try { mod = require(path.join(process.cwd(), rel)); } catch (e) { fail(`${rel} does not load under jest: ${(e as Error).message}`); }
  for (const n of names) if (mod[n] === undefined) fail(`${rel} exports no ${n}`);
  return mod;
};
type Fix = { latitude: number; longitude: number } | null;
let mockFix: Fix = { latitude: 25.769, longitude: -80.194 };
let mockCopy: unknown = null;
// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockProvider, useSQLiteContext: mockScheduleCopy, openDatabaseSync: mockNoUserDbFile }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => mockKvStore());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockAsk, watchPositionAsync: mockWatch }));
// test-time mock of native module
jest.mock('expo-crypto', () => ({ randomUUID: mockUuid }));
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
function mockWatch(_o: unknown, onFix: (f: { coords: Fix }) => void) {
  if (mockFix !== null) onFix({ coords: mockFix });
  return Promise.resolve({ remove: () => undefined });
}
const { act } = require('react-test-renderer');
const { router } = require('expo-router');
const { BottomAccessoryPlacementContext } = require('expo-router/build/native-tabs/hooks');
const { StyleSheet } = require('react-native');
const { renderPrimitive, hostsByTestID, unmountAll } = load('src/ui/primitives/__tests__/render-primitive', ['renderPrimitive', 'hostsByTestID', 'unmountAll']);
const { realScheduleRepo, memoryUserRepos, savedTrip, closeTripDbs, WED_0800, WED_0130 } = load('src/ui/trips/__tests__/trip-db', ['realScheduleRepo', 'memoryUserRepos', 'savedTrip', 'closeTripDbs', 'WED_0800']);
const { NowAccessory } = load('src/ui/now/NowAccessory', ['NowAccessory']);
const { UserLocationProvider } = load('src/ui/location/UserLocationProvider', ['UserLocationProvider']);
const { ScheduleDbProvider } = load('src/data/schedule-db-provider', ['ScheduleDbProvider']);
const { UserDbProvider } = load('src/data/user-db-provider', ['UserDbProvider']);
const { LiveValueProvider } = load('src/live/live-context', ['LiveValueProvider']);
const { windowFrom } = load('src/domain/gtfs/service-day', ['windowFrom']);
const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
const { nearestPlatform } = load('src/domain/hurry/platform', ['nearestPlatform']);
const { clockFor, HURRY_RANGE_M } = load('src/ui/hurry/hurry-reading', ['clockFor', 'HURRY_RANGE_M']);
const { tripCards, sortByLeaveAt } = load('src/ui/trips/trip-card', ['tripCards', 'sortByLeaveAt']);
const { heroOf } = load('src/ui/trips/trip-copy', ['heroOf']);
const { countdown } = load('src/ui/trips/countdown', ['countdown']);
const { haversineMeters } = load('src/lib/geo', ['haversineMeters']);
const P = { latitude: 25.769, longitude: -80.194 };
const BCC = 'mover:brickell-city-centre', BAYFRONT = 'mover:bayfront-park';
const VERDICT_WORDS = /\b(chill|jog|not worth it|missed|hurry)\b/i;
const NO_LIVE = { state: null, runtime: null };
afterEach(async () => { jest.restoreAllMocks(); await unmountAll(); });
afterAll(() => closeTripDbs());

/** The host <Text> lines inside a host (outermost Text nodes only), each with its own text, joined across nested Texts. */
function linesOf(host: any): { text: string; node: any }[] {
  const out: { text: string; node: any }[] = [];
  const stack = [{ n: host, inText: false }];
  for (let g = 0; stack.length > 0 && g < 100000; g += 1) {
    const { n, inText } = stack.pop() as { n: any; inText: boolean };
    const isText = n.type === 'Text';
    if (isText && !inText) out.push({ text: textOf(n), node: n });
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
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); });
}
type Bar = { lines: string[]; nodes: any[]; label: string; button: any };
/** The REAL bar in `placement` for `trips` (saved in order through the real repo), the rider at `fix`, at `nowS`. */
async function bar(placement: 'regular' | 'inline', trips: unknown[], fix: Fix, nowS: number = WED_0800, live: unknown = NO_LIVE): Promise<Bar> {
  mockFix = fix;
  const repos = memoryUserRepos();
  if (!repos.ok) fail('the in-memory user DB did not open');
  for (const t of trips) { const made = repos.value.trips.create(t); if (!made.ok) fail(`saving ${show(t)} failed: ${made.error.message}`); }
  const tree = await renderPrimitive(
    <UserLocationProvider><ScheduleDbProvider><UserDbProvider open={() => repos}><LiveValueProvider value={live}>
      <BottomAccessoryPlacementContext.Provider value={placement}><NowAccessory clock={() => nowS} /></BottomAccessoryPlacementContext.Provider>
    </LiveValueProvider></UserDbProvider></ScheduleDbProvider></UserLocationProvider>,
  );
  await settle();
  const button = hostsByTestID(tree.root, 'now-accessory')[0];
  if (button === undefined) fail(`no 'now-accessory' host rendered (${placement})`);
  const found = linesOf(button);
  return { lines: found.map((l) => l.text), nodes: found.map((l) => l.node), label: String(button.props.accessibilityLabel ?? ''), button };
}
const trip = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => savedTrip(id, from, to, { createdEpoch: 1_790_000_000 + id.charCodeAt(0), ...extra });
const station = (key: string) => { const s = realScheduleRepo().stations().find((x: any) => x.stationKey === key); if (s === undefined) fail(`no station ${key}`); return s; };
/** The verdict the shipped engine gives for a saved trip from `fix` at `nowS`: its rides only, walked from the rider. */
function tripVerdict(from: string, to: string, fix: { latitude: number; longitude: number }, nowS: number) {
  const repo = realScheduleRepo();
  const window = windowFrom(nowS, 3 * 3600);
  const got = repo.tripRides(from, to, window);
  if (!got.ok || got.value.kind !== 'rides') fail(`the schedule has no direct rides ${from} -> ${to}`);
  const rides = got.value.rides.filter((r: any) => r.depEpoch >= nowS);
  const boards = new Set(rides.map((r: any) => r.boardStopId));
  const platforms = repo.platforms().filter((p: any) => boards.has(p.stopId));
  if (rides.length < 3 || platforms.length === 0) fail('the oracle needs >= 3 rides and their boarding platform');
  const walkMeters = nearestPlatform(fix, platforms, null).walkMeters;
  const departures = rides.map((r: any) => ({ epoch: r.depEpoch, live: false, lineId: r.lineId, headsign: null }));
  const verdict = hurryVerdict({ now: nowS, walkMeters, departures, walkMps: 1.35, jogMps: 2.7 });
  const days = repo.serviceDays(window);
  const ctx = { now: nowS, clock: clockFor(days.days.map((d: any) => d.baseEpoch)) };
  return { verdict, ctx, walkMeters };
}
/** The trip cards m7b computes (Jamie's pace, the default 120 s platform buffer), soonest leave-by first. */
function cards(trips: unknown[], fix: Fix, nowS: number = WED_0800) {
  return sortByLeaveAt(tripCards(realScheduleRepo(), trips, { nowS, walkMps: 1.35, bufferS: 120, position: fix }));
}
const nearM = (fix: { latitude: number; longitude: number }, key: string) => nearestPlatform(fix, realScheduleRepo().platforms().filter((p: any) => p.stationKey === key), null).walkMeters;
/** A live runtime that is never started (m7c's idleRuntime): what the bar asks of it is which station to watch. */
function idleRuntime() {
  const { LiveRuntime } = load('src/live/runtime', ['LiveRuntime']);
  const { FakeServer, runtimeNetwork } = load('src/live/__tests__/live-fakes', ['FakeServer', 'runtimeNetwork']);
  const keys = new Map<string, string>(), quota = new Map<string, number>();
  return new LiveRuntime({ network: runtimeNetwork(), onChange: () => undefined, fetch: new FakeServer({}).fetch, nowS: () => WED_0800,
    keychain: { getItemAsync: (k: string) => Promise.resolve(keys.get(k) ?? null), setItemAsync: (k: string, v: string) => Promise.resolve(void keys.set(k, v)), deleteItemAsync: (k: string) => Promise.resolve(void keys.delete(k)) },
    quotaStore: { get: (k: string) => quota.get(k) ?? null, set: (k: string, n: number) => void quota.set(k, n) } });
}
const pushed = (spy: any) => spy.mock.calls.map((c: any[]) => (typeof c[0] === 'string' ? c[0] : show(c[0])));
const hurryFn = (name: 'hurryShort' | 'hurryInline' | 'hurrySentence') => load('src/ui/hurry/copy', [name])[name];
const hurryShort = (v: any, ctx: any) => hurryFn('hurryShort')(v, ctx);
const hurryInline = (v: any, ctx: any) => hurryFn('hurryInline')(v, ctx);
const hurrySentence = (v: any, ctx: any) => hurryFn('hurrySentence')(v, ctx);
const budget = (): number => {
  const { REGULAR_LINE_MAX_CHARS: max } = load('src/ui/now/now-text', ['REGULAR_LINE_MAX_CHARS']);
  if (!Number.isInteger(max) || max < 30 || max > 38) fail(`REGULAR_LINE_MAX_CHARS is ${show(max)}: the measured budget is 30..38 (Jamie's phone showed 40 characters at 15 pt before the ellipsis)`);
  return max;
};
/** The status line the note defines for a saved trip's verdict: the richest of short / inline copy, with the labelled estimated walk. */
function statusLine(v: any, ctx: any): string {
  const walk = `~${Math.ceil(v.walkS / 60)} min walk`;
  const fits = [`${hurryShort(v, ctx)} · ${walk}`, `${hurryInline(v, ctx)} · ${walk}`].find((s) => [...s].length <= budget());
  if (fits === undefined) fail(`no status line for ${v.kind} fits ${budget()} characters`);
  return fits as string;
}
const CASES: Record<string, () => Promise<void>> = {
  where_to: async () => {
    for (const fix of [P, null] as Fix[]) for (const placement of ['regular', 'inline'] as const) {
      const b = await bar(placement, [], fix);
      if (show(b.lines) !== show(['Where to?'])) fail(`no saved trip (${fix === null ? 'no fix' : 'rider at P'}, ${placement}): the bar must read exactly ["Where to?"], got ${show(b.lines)}`);
      if (VERDICT_WORDS.test(b.label) || b.label.length === 0) fail(`no saved trip: the VoiceOver label must give no verdict, got ${show(b.label)}`);
      await unmountAll();
    }
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const nav = jest.spyOn(router, 'navigate').mockImplementation(() => undefined);
    const b = await bar('regular', [], P);
    await act(async () => b.button.props.onClick());
    const went = [...pushed(push), ...pushed(nav)];
    if (show(went) !== show(['/plan']) && show(went) !== show([show({ pathname: '/plan' })])) fail(`tapping "Where to?" must open route options (/plan) once, got ${show(went)}`);
  },
  trip_verdict: async () => {
    const nearest = nearestPlatform(P, realScheduleRepo().platforms(), null).platform.stationKey;
    if (nearest !== 'mover:fifth-street') fail(`premise: the nearest station to P is Fifth Street, got ${nearest}`);
    const { verdict, ctx } = tripVerdict(BCC, BAYFRONT, P, WED_0800);
    const want = ['Bayfront Park', statusLine(verdict, ctx)];
    const regular = await bar('regular', [trip('bayfront', BCC, BAYFRONT)], P);
    if (show(regular.lines) !== show(want)) fail(`regular bar for the saved trip Brickell City Centre -> Bayfront Park: want ${show(want)}, got ${show(regular.lines)}`);
    for (const part of [hurrySentence(verdict, ctx), 'Bayfront Park', 'Brickell City Centre']) if (!regular.label.includes(part)) fail(`the VoiceOver label must include ${show(part)}: ${show(regular.label)}`);
    if (!/\bestimated\b/i.test(regular.label) || regular.label.includes('Fifth Street')) fail(`the label must call the walk estimated and never name Fifth Street: ${show(regular.label)}`);
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    await act(async () => regular.button.props.onClick());
    if (show(push.mock.calls) !== show([[{ pathname: '/trip/[tripId]', params: { tripId: 'bayfront' } }]])) fail(`a tap opens that saved trip, got ${show(push.mock.calls)}`);
    await unmountAll();
    const inline = await bar('inline', [trip('bayfront', BCC, BAYFRONT)], P);
    if (show(inline.lines) !== show([hurryInline(verdict, ctx)])) fail(`inline: want ${show([hurryInline(verdict, ctx)])}, got ${show(inline.lines)}`);
    // 08:04: the soonest Brickell City Centre train (either way) is NOT a Bayfront Park ride, so judging both directions shows.
    await unmountAll();
    const T = WED_0800 + 240;
    const { stationTimetable, hurryReading, soonestBoard } = load('src/ui/hurry/hurry-reading', ['stationTimetable', 'hurryReading', 'soonestBoard']);
    const m7c = hurryReading({ db: { kind: 'ready' }, position: { coordinate: P, note: null }, timetable: stationTimetable(realScheduleRepo(), BCC, T - (T % 60)), batch: null, nowS: T, pace: { walkMps: 1.35, jogMps: 2.7 } });
    const later = tripVerdict(BCC, BAYFRONT, P, T);
    if (m7c.kind !== 'boards' || soonestBoard(m7c.boards).verdict.departure?.epoch === later.verdict.departure?.epoch) fail('premise: at 08:04 the soonest Brickell City Centre train (either way) is not a Bayfront Park ride');
    const want0804 = ['Bayfront Park', 'Not worth it · ~5 min walk'];
    if (show(['Bayfront Park', statusLine(later.verdict, later.ctx)]) !== show(want0804)) fail(`premise: the engine's 08:04 trip verdict reads ${show(statusLine(later.verdict, later.ctx))}`);
    const at0804 = await bar('regular', [trip('bayfront', BCC, BAYFRONT)], P, T);
    if (show(at0804.lines) !== show(want0804)) fail(`08:04: only rides that reach Bayfront Park count, never the other direction: want ${show(want0804)}, got ${show(at0804.lines)}`);
  },
  soonest: async () => {
    // 'a' is saved LAST (createdEpoch after 'b'): an "oldest saved trip wins" build must fail.
    const trips = [trip('b', 'mover:fifth-street', 'mover:college-north'), trip('a', BCC, BAYFRONT, { createdEpoch: 1_790_000_500 })];
    if (!(trips[1].createdEpoch > trips[0].createdEpoch)) fail('premise: the winner is the NEWER saved trip');
    const near = cards(trips, P).filter((c: any) => c.status.kind === 'leave' && nearM(P, c.trip.fromStationKey) <= HURRY_RANGE_M);
    if (near.length !== 2 || near[0].trip.id !== 'a') fail(`premise: both trips are near and Brickell City Centre -> Bayfront Park leaves first, got ${show(near.map((c: any) => c.trip.id))}`);
    const b = await bar('regular', trips, P);
    if (b.lines[0] !== 'Bayfront Park' || !VERDICT_WORDS.test(b.lines[1] ?? '')) fail(`two near saved trips: the soonest leave-by (Bayfront Park, saved second, not from the nearest station) takes the bar with its verdict, got ${show(b.lines)}`);
    if (b.label.includes('College North')) fail(`the label is about the winning trip only: ${show(b.label)}`);
  },
  countdown: async () => {
    const far = trip('d', 'rail:dadeland-north', 'rail:dadeland-south', { walkOverrideMin: 4 });
    const all = cards([far, trip('a', BCC, BAYFRONT)], P);
    const d = all.find((c: any) => c.trip.id === 'd');
    if (d?.status.kind !== 'leave' || countdown(d.status.current.leaveByEpoch, WED_0800).state === 'clock' || nearM(P, 'rail:dadeland-north') <= HURRY_RANGE_M) fail('premise: Dadeland North -> Dadeland South is far from P and its countdown is live at 08:00');
    const b = await bar('regular', [far, trip('a', BCC, BAYFRONT)], P);
    const want = ['Dadeland South', heroOf(d.status, WED_0800).text];
    if (show(b.lines) !== show(want)) fail(`an active trip's countdown keeps priority over a near trip: want ${show(want)}, got ${show(b.lines)}`);
    if (b.lines.some((l) => VERDICT_WORDS.test(l))) fail(`the countdown bar gives no hurry verdict: ${show(b.lines)}`);
  },
  near_boundary: async () => {
    const { NEAR_TRIP_M } = load('src/ui/now/homeContext', ['NEAR_TRIP_M']);
    if (NEAR_TRIP_M !== HURRY_RANGE_M) fail(`NEAR_TRIP_M is ${show(NEAR_TRIP_M)}: it is m7c's HURRY_RANGE_M (${HURRY_RANGE_M})`);
    const o = station(BCC).coordinate;
    const perDeg = haversineMeters(o, { latitude: o.latitude + 1, longitude: o.longitude });
    const at = (m: number) => ({ latitude: o.latitude - m / perDeg, longitude: o.longitude });
    const inside = at(NEAR_TRIP_M - 0.01), outside = at(NEAR_TRIP_M + 1);
    if (!(nearM(inside, BCC) <= NEAR_TRIP_M && nearM(outside, BCC) > NEAR_TRIP_M)) fail('premise: the two riders straddle the limit');
    const a = trip('a', BCC, BAYFRONT);
    const inB = await bar('regular', [a], inside);
    if (inB.lines[0] !== 'Bayfront Park' || !VERDICT_WORDS.test(inB.lines[1] ?? '')) fail(`a rider at the limit is near: the bar judges the trip, got ${show(inB.lines)}`);
    await unmountAll();
    const c = cards([a], outside)[0];
    if (c?.status.kind !== 'leave' || countdown(c.status.current.leaveByEpoch, WED_0800).state === 'clock') fail('premise: from 1 m beyond, the trip counts down live (m7b)');
    const outB = await bar('regular', [a], outside);
    if (show(outB.lines) !== show(['Bayfront Park', heroOf(c.status, WED_0800).text])) fail(`one metre beyond the limit the trip is not near: no verdict, its m7b countdown, got ${show(outB.lines)}`);
  },
  near_exact: async () => {
    // Rider R sits EXACTLY NEAR_TRIP_M (by the app's own haversine) from Palmetto's southern platform 9486, ~2004.7 m
    // from the station centre: an inclusive, nearest-PLATFORM build judges the trip; a strict `<` or a centre build does not.
    const { NEAR_TRIP_M } = load('src/ui/now/homeContext', ['NEAR_TRIP_M']);
    const R = { latitude: 25.826446447023613, longitude: -80.33062626199339 };
    const FROM = 'rail:palmetto', TO = 'rail:okeechobee';
    if (nearM(R, FROM) !== NEAR_TRIP_M) fail(`premise: R is exactly ${NEAR_TRIP_M} m from Palmetto's nearest platform, got ${nearM(R, FROM)}`);
    if (!(haversineMeters(R, station(FROM).coordinate) > NEAR_TRIP_M + 3)) fail('premise: R is more than NEAR_TRIP_M + 3 m from the station centre');
    const { verdict, ctx } = tripVerdict(FROM, TO, R, WED_0800);
    const want = [station(TO).name, statusLine(verdict, ctx)];
    const b = await bar('regular', [trip('p', FROM, TO)], R);
    if (show(b.lines) !== show(want)) fail(`a rider exactly NEAR_TRIP_M from the origin's nearest platform is NEAR (inclusive, platform not centre): want ${show(want)}, got ${show(b.lines)}`);
  },
  live_merge: async () => {
    const repo = realScheduleRepo();
    const got = repo.tripRides(BCC, BAYFRONT, windowFrom(WED_0800, 3 * 3600));
    if (!got.ok || got.value.kind !== 'rides') fail('premise: Brickell City Centre -> Bayfront Park has rides');
    const ride = got.value.rides.find((r: any) => r.depEpoch >= WED_0800);
    const deps = repo.departures(BCC, windowFrom(WED_0800 - 600, 4 * 3600));
    const all = deps.ok && deps.value.kind === 'departures' ? deps.value.departures : [];
    const own = all.find((d: any) => d.tripIdx === ride.boardTripIdx && d.stopId === ride.boardStopId);
    const other = all.find((d: any) => d.stopId !== ride.boardStopId && d.epoch >= WED_0800);
    if (own === undefined || other === undefined) fail('premise: the ride and an other-direction departure are in the timetable');
    const DELAY = 150;
    const pred = (d: any, key: string, delay: number) => ({ tripId: d.tripId, routeId: String(d.lineId), lineId: d.lineId, stopId: d.stopId, stationKey: key, epoch: d.epoch + delay, scheduledEpoch: d.epoch, delayS: delay, realtime: true, canceled: false, headsign: null });
    const batch = (items: unknown[]) => ({ items, feedTimestamp: WED_0800, dropped: {}, provider: 'transitland', fetchedAt: WED_0800, bytes: 1 });
    const fifth = repo.departures('mover:fifth-street', windowFrom(WED_0800, 3600));
    const fifthDep = fifth.ok && fifth.value.kind === 'departures' ? fifth.value.departures[0] : undefined;
    if (fifthDep === undefined) fail('premise: Fifth Street has a departure');
    const decoys = { bcc: [pred(other, BCC, 600)], fifth: [pred(fifthDep, 'mover:fifth-street', 600)] };
    const live = (items: unknown[]) => ({ runtime: idleRuntime(), state: { vehicles: null, status: {}, predictions: new Map([[BCC, batch(items)], ['mover:fifth-street', batch(decoys.fifth)]]) } });
    // The engine's verdict with the ride's live time (fresh, so not stale) in place of its scheduled one.
    const rides = got.value.rides.filter((r: any) => r.depEpoch >= WED_0800);
    const departures = rides.map((r: any) => (r === ride ? { epoch: r.depEpoch + DELAY, live: true, lineId: r.lineId, headsign: null } : { epoch: r.depEpoch, live: false, lineId: r.lineId, headsign: null })).sort((a: any, b: any) => a.epoch - b.epoch);
    const sched = tripVerdict(BCC, BAYFRONT, P, WED_0800);
    const liveV = hurryVerdict({ now: WED_0800, walkMeters: sched.walkMeters, departures, walkMps: 1.35, jogMps: 2.7 });
    const wantLive = ['Bayfront Park', statusLine(liveV, sched.ctx)], wantSched = ['Bayfront Park', statusLine(sched.verdict, sched.ctx)];
    if (show(wantLive) === show(wantSched)) fail('premise: the 150 s delay changes the verdict text');
    const moved = await bar('regular', [trip('a', BCC, BAYFRONT)], P, WED_0800, live([pred(own, BCC, DELAY), ...decoys.bcc]));
    if (show(moved.lines) !== show(wantLive)) fail(`a live prediction for the judged ride moves the verdict: want ${show(wantLive)}, got ${show(moved.lines)}`);
    if (!moved.label.includes(hurrySentence(liveV, sched.ctx))) fail(`the label says the live sentence ${show(hurrySentence(liveV, sched.ctx))}: ${show(moved.label)}`);
    await unmountAll();
    const still = await bar('regular', [trip('a', BCC, BAYFRONT)], P, WED_0800, live([...decoys.bcc]));
    if (show(still.lines) !== show(wantSched)) fail(`predictions for other trips (the other direction, another station) never move the verdict: want ${show(wantSched)}, got ${show(still.lines)}`);
  },
  watch: async () => {
    const runtime = idleRuntime();
    const spy = jest.spyOn(runtime, 'watchStations');
    await bar('regular', [], P, WED_0800, { state: null, runtime });
    const none = spy.mock.calls.filter((c: any[]) => c[0].length > 0);
    if (none.length > 0) fail(`with no saved trip the bar watches no station's predictions (Transitland budget), got ${show(none)}`);
    await unmountAll();
    spy.mockClear();
    await bar('regular', [trip('a', BCC, BAYFRONT)], P, WED_0800, { state: null, runtime });
    const watched = spy.mock.calls.filter((c: any[]) => c[0].length > 0).map((c: any[]) => c[0]);
    if (show(watched) !== show([[BCC]])) fail(`with a near saved trip the bar watches only its origin, once: want [["${BCC}"]], got ${show(watched)}`);
  },
  budget: async () => {
    const max = budget();
    const states: [string, unknown[], Fix, number][] = [
      ['no trip', [], P, WED_0800], ['no fix', [], null, WED_0800], ['01:30, no trip', [], P, WED_0130],
      ['near trip', [trip('a', BCC, BAYFRONT)], P, WED_0800],
      ['longest destination', [trip('e', 'rail:brickell', 'rail:miami-international-airport')], P, WED_0800],
      ['countdown', [trip('d', 'rail:dadeland-north', 'rail:dadeland-south', { walkOverrideMin: 4 }), trip('a', BCC, BAYFRONT)], P, WED_0800],
    ];
    for (const [name, trips, fix, nowS] of states) {
      const b = await bar('regular', trips, fix, nowS);
      if (b.lines.length === 0) fail(`${name}: the regular bar shows no text`);
      b.nodes.forEach((node, i) => {
        const line = b.lines[i] as string;
        const size = (StyleSheet.flatten(node.props.style) ?? {}).fontSize;
        if ([...line].length > max) fail(`${name}: line ${show(line)} is ${[...line].length} characters, over the measured budget ${max} — it would truncate`);
        if (node.props.numberOfLines !== 1) fail(`${name}: line ${show(line)} must be one line (numberOfLines 1), got ${show(node.props.numberOfLines)}`);
        if (typeof size !== 'number' || size > 15) fail(`${name}: line ${show(line)} is set at fontSize ${show(size)}; the budget was measured at 15 pt, so no line may be larger`);
      });
      if (name === 'longest destination' && b.lines[0] !== 'Miami International Airport') fail(`the bar names the trip's destination FIRST, whole: got ${show(b.lines)}`);
      await unmountAll();
    }
  },
  copy: async () => {
    const c = load('src/ui/hurry/copy', ['hurryShort', 'hurryInline']);
    const v = (walkMeters: number, epochs: number[]) => hurryVerdict({ now: 0, walkMeters, departures: epochs.map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: 'Dadeland South' })) });
    const ctx = { now: 0, clock: (e: number) => ({ 300: '2:14', 900: '2:26' } as Record<number, string>)[e] ?? '12:59' };
    const table: [string, any, string, string, string][] = [
      ['CHILL dep 600', v(400, [600]), 'CHILL', 'Chill · 3 min spare', 'Chill'],
      ['CHILL under a minute', v(400, [450]), 'CHILL', 'Chill · under 1 min spare', 'Chill'],
      ['JOG dep 300 then 1200', v(400, [300, 1200]), 'JOG', 'Jog · 1 min spare', 'Jog'],
      ['NOT_WORTH_IT 100 then 180', v(100, [100, 180]), 'NOT_WORTH_IT', 'Not worth it · next in 3 min', 'Not worth it'],
      ['MISSED, chill at 2:26', v(400, [150, 900]), 'MISSED', 'Missed · next 2:26', 'Next 2:26'],
      ['MISSED, nothing makeable', v(400, [100, 110, 120, 2000]), 'MISSED', 'Missed · nothing soon', 'Missed'],
      ['NO_SERVICE', v(400, []), 'NO_SERVICE', 'No more trains tonight', 'No more trains'],
    ];
    for (const [name, verdict, kind, short, inline] of table) {
      if (verdict.kind !== kind) fail(`premise: the engine gives ${verdict.kind} for ${name}, expected ${kind}`);
      if (c.hurryShort(verdict, ctx) !== short) fail(`hurryShort(${name}) = ${show(c.hurryShort(verdict, ctx))}; the note requires ${show(short)}`);
      if (c.hurryInline(verdict, ctx) !== inline) fail(`hurryInline(${name}) = ${show(c.hurryInline(verdict, ctx))}; the note requires ${show(inline)} (<= 14, no bare number)`);
    }
  },
  copy_unchanged: async () => {
    const c = load('src/ui/hurry/copy', ['hurryCopy', 'hurryParts']);
    const v = (walkMeters: number, epochs: number[]) => hurryVerdict({ now: 0, walkMeters, departures: epochs.map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: 'Dadeland South' })) });
    const ctx = { now: 0, clock: (e: number) => ({ 300: '2:14', 900: '2:26' } as Record<number, string>)[e] ?? '9:59' };
    const same: [any, string][] = [[v(400, [600]), 'Chill · 3 min to spare'], [v(400, [300, 1200]), 'Jog · makes the 2:14 with 1 min spare'], [v(100, [100, 180]), 'Not worth it · next in 3 min'], [v(400, [150, 900]), 'Missed · next 2:26 · chill'], [v(400, []), 'No more trains tonight']];
    for (const [verdict, want] of same) {
      if (c.hurryCopy(verdict, ctx) !== want) fail(`the station sheet's card copy changed: hurryCopy(${verdict.kind}) = ${show(c.hurryCopy(verdict, ctx))}, m7c pins ${show(want)}`);
      const parts = c.hurryParts(verdict, ctx);
      if ((parts.detail === null ? parts.headline : `${parts.headline} · ${parts.detail}`) !== want) fail(`hurryParts(${verdict.kind}) no longer composes m7c's card copy ${show(want)}`);
    }
  },
  chip_walk: async () => {
    const f = load('src/ui/routes/__tests__/route-fixtures', ['fixtureItineraries', 'FIXTURE_NETWORK', 'FIXTURE_CLOCK', 'START', 'ASKED_AT_S']);
    const { routeOptions, CHIP_ROUTED_START_M } = load('src/ui/routes/route-options', ['routeOptions', 'CHIP_ROUTED_START_M']);
    if (CHIP_ROUTED_START_M !== 50) fail(`CHIP_ROUTED_START_M is ${show(CHIP_ROUTED_START_M)}: the arbiter's ruling is 50 m (GPS jitter is ~10-20 m)`);
    const itineraries = f.fixtureItineraries();
    const pace = { walkMps: 1.35, jogMps: 2.7 };
    const south = (m: number) => ({ latitude: f.START.latitude - m / 111_195, longitude: f.START.longitude });
    // At the plan's start and 40 m from it (inside 50 m): the routed WALK legs before the first ride, no detour.
    for (const [where, rider] of [['at the start', f.START], ['40 m from the start', south(40)]] as const) {
      let checked = 0;
      for (const option of routeOptions(itineraries, f.FIXTURE_NETWORK, { position: rider, nowS: f.ASKED_AT_S, pace })) {
        const legs = option.itinerary.legs;
        const first = legs.findIndex((l: any) => l.tripId !== null);
        const before = legs.slice(0, first).filter((l: any) => l.mode === 'WALK');
        if (first < 1 || before.length === 0 || before.some((l: any) => l.distanceM === null)) continue;
        const routed = before.reduce((s: number, l: any) => s + l.distanceM, 0);
        const straight = haversineMeters(rider, { latitude: legs[first].from.latitude, longitude: legs[first].from.longitude });
        if (Math.abs(routed - straight * 1.3) < 20) fail('premise: the fixture walk must differ from straight-line x 1.3');
        if (option.verdict === null || Math.abs(option.verdict.walkS - routed / 1.35) > 0.05 || Math.abs(option.verdict.jogS - routed / 2.7) > 0.05) {
          fail(`${where}, option ${option.id}: the chip must walk the routed ${routed} m (walkS ${(routed / 1.35).toFixed(1)}, jogS ${(routed / 2.7).toFixed(1)}), got walkS ${show(option.verdict?.walkS)} jogS ${show(option.verdict?.jogS)}`);
        }
        checked += 1;
      }
      if (checked < 2) fail(`${where}: only ${checked} fixture option(s) have a routed first walk — the oracle needs >= 2`);
    }
    // 300 m from the start (the rider moved away): mfix5's straight line from the rider, x 1.3 detour.
    const away = south(300);
    for (const option of routeOptions(itineraries, f.FIXTURE_NETWORK, { position: away, nowS: f.ASKED_AT_S, pace })) {
      const ride = option.itinerary.legs.find((l: any) => l.tripId !== null);
      if (ride === undefined || option.verdict === null) continue;
      const straight = haversineMeters(away, { latitude: ride.from.latitude, longitude: ride.from.longitude }) * 1.3;
      if (Math.abs(option.verdict.walkS - straight / 1.35) > 0.05) fail(`option ${option.id}: a rider 300 m from the plan's start walks the straight line from the rider (${(straight / 1.35).toFixed(1)} s), never the plan's routed legs; got ${show(option.verdict.walkS)}`);
    }
    // The chip SHOWS hurryShort (labelled numbers), on the REAL RouteOptionsList.
    const { RouteOptionsList } = load('src/ui/routes/RouteOptionsList', ['RouteOptionsList']);
    const options = routeOptions(itineraries, f.FIXTURE_NETWORK, { position: f.START, nowS: f.ASKED_AT_S, pace });
    const chipCtx = { now: f.ASKED_AT_S, clock: f.FIXTURE_CLOCK };
    const list = await renderPrimitive(<RouteOptionsList options={options} clock={f.FIXTURE_CLOCK} nowS={f.ASKED_AT_S} onSelect={() => undefined} />);
    let chips = 0;
    for (const [row, option] of options.entries()) {
      if (option.verdict === null) continue;
      const host = hostsByTestID(list.root, `route-option-${row}-hurry-text`)[0];
      if (host === undefined || textOf(host) !== hurryShort(option.verdict, chipCtx)) fail(`option ${option.id}: the chip shows hurryShort ${show(hurryShort(option.verdict, chipCtx))} (labelled numbers), got ${show(host === undefined ? null : textOf(host))}`);
      chips += 1;
    }
    if (chips < 2) fail(`only ${chips} chip(s) rendered — the oracle needs >= 2`);
  },
  first_leg_optin: async () => {
    const f = load('src/ui/routes/__tests__/route-fixtures', ['fixtureItineraries', 'START', 'ASKED_AT_S']);
    const { firstLegVerdict } = load('src/domain/routes/overlay', ['firstLegVerdict']);
    const pace = { walkMps: 1.35, jogMps: 2.7 };
    let checked = 0;
    for (const itinerary of f.fixtureItineraries()) {
      const legs = itinerary.legs;
      const first = legs.findIndex((l: any) => l.tripId !== null);
      const before = legs.slice(0, first).filter((l: any) => l.mode === 'WALK');
      if (first < 1 || before.length === 0 || before.some((l: any) => l.distanceM === null)) continue;
      const routed = before.reduce((s: number, l: any) => s + l.distanceM, 0);
      const straight = haversineMeters(f.START, { latitude: legs[first].from.latitude, longitude: legs[first].from.longitude }) * 1.3;
      const byDefault = firstLegVerdict(itinerary, f.START, f.ASKED_AT_S, pace);
      if (byDefault === null || Math.abs(byDefault.walkS - straight / 1.35) > 0.05) fail(`firstLegVerdict's DEFAULT must stay m10a's straight line x 1.3 (walkS ${(straight / 1.35).toFixed(1)}), got ${show(byDefault?.walkS)} — the routed walk is opt-in, so m10a's gates stay green`);
      const optedIn = firstLegVerdict(itinerary, f.START, f.ASKED_AT_S, pace, true);
      if (optedIn === null || Math.abs(optedIn.walkS - routed / 1.35) > 0.05) fail(`firstLegVerdict(..., pace, true) opts in to the routed ${routed} m (walkS ${(routed / 1.35).toFixed(1)}), got ${show(optedIn?.walkS)}`);
      checked += 1;
    }
    if (checked < 2) fail(`only ${checked} fixture itineraries have a routed first walk — the oracle needs >= 2`);
  },
  save_trip: async () => {
    const f = load('src/ui/routes/__tests__/route-fixtures', ['fixtureItineraries', 'FIXTURE_NETWORK', 'FIXTURE_NAMES', 'FIXTURE_CLOCK', 'START', 'ASKED_AT_S']);
    const { routeOptions } = load('src/ui/routes/route-options', ['routeOptions']);
    const { ItineraryDetail } = load('src/ui/routes/ItineraryDetail', ['ItineraryDetail']);
    const options = routeOptions(f.fixtureItineraries(), f.FIXTURE_NETWORK, { position: f.START, nowS: f.ASKED_AT_S, pace: {} });
    const rides = (o: any) => o.itinerary.legs.filter((l: any) => l.tripId !== null).length;
    const one = options.find((o: any) => rides(o) === 1 && o.itinerary.legs.find((l: any) => l.tripId !== null).routeShortName === 'MMO');
    const many = options.find((o: any) => rides(o) > 1);
    if (one === undefined || many === undefined) fail('premise: the fixture has a single-ride Mover itinerary and a multi-ride one');
    const repos = memoryUserRepos();
    const render = async (option: any) => renderPrimitive(<UserDbProvider open={() => repos}><ItineraryDetail option={option} network={f.FIXTURE_NETWORK} names={f.FIXTURE_NAMES} clock={f.FIXTURE_CLOCK} /></UserDbProvider>);
    const single = await render(one);
    const save = hostsByTestID(single.root, 'itinerary-save-trip');
    if (save.length !== 1 || !/save this trip/i.test(String(save[0].props.accessibilityLabel ?? '') + textOf(save[0]))) fail(`a single-ride itinerary shows ONE "Save this trip" action (testID itinerary-save-trip), found ${save.length}`);
    await act(async () => save[0].props.onClick());
    const saved = repos.value.trips.list().map((t: any) => [t.fromStationKey, t.toStationKey]);
    if (show(saved) !== show([['mover:government-center', 'mover:financial-district']])) fail(`the tap saves the ride's boarding -> alighting stations as an m7b trip in the real user DB, got ${show(saved)}`);
    await unmountAll();
    const multi = await render(many);
    const why = hostsByTestID(multi.root, 'itinerary-save-trip-why');
    if (hostsByTestID(multi.root, 'itinerary-save-trip').length !== 0) fail('a multi-ride itinerary offers no save');
    if (why.length < 1 || textOf(why[0]).trim().length === 0 || textOf(why[0]).includes('\n')) fail('a multi-ride itinerary says in one line why it cannot be saved (testID itinerary-save-trip-why)');
  },
};
it('ratchet oracle', async () => {
  const run = CASES[CASE];
  if (run === undefined) fail('unknown oracle case');
  await run();
  expect(CASE.length).toBeGreaterThan(0);
}, 120_000); // several real-DB renders per case: never trip jest's 5 s default on a busy machine
TSX
  out=$(MFIX8_CASE="$which" local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.tsx' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 -o "ratchet-oracle:.*"; else echo "$out" | tail -25; fi
    echo "ratchet: mfix8 oracle '$which' failed"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the mfix8 oracle '$which' did not run"; return 1; }
  echo "ratchet: mfix8 oracle '$which' holds on the shipped app"
}


# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix8_trip_bar gate failed at verify script line $LINENO"' ERR

# --- (1) No saved trip near: no verdict, "Where to?" --------------------------------------------------------------
# 1. Oracle, real bar: with no saved trip (rider at P, and with no fix), both placements read exactly ["Where to?"] and the VoiceOver label gives no verdict; a tap opens route options (/plan) once.
mfix8_oracle where_to
# 2. One passing test each (src/ui/now/__tests__, the real bar): the no-trip bar; its tap.
jest_cases src/ui/now/__tests__ 'with no saved trip near the bar says where to and gives no verdict' 'tapping where to opens route options'

# --- (2) A near saved trip is judged as THAT trip -----------------------------------------------------------------
# 3. Oracle: saved trip Brickell City Centre -> Bayfront Park, rider at P (301 m from it, 176 m from Fifth Street, the nearest): the regular bar is exactly ["Bayfront Park", <status>] where the verdict is the engine's over that trip's tripRides only, walked from P to the ride's boarding platform, and <status> is the richest of "<hurryShort> · ~N min walk" / "<hurryInline> · ~N min walk" within the budget; inline is [hurryInline]; the label holds hurrySentence, both station names and "estimated", never "Fifth Street"; a tap opens that trip. At 08:04 (the soonest Brickell City Centre train either way is NOT a Bayfront Park ride) the bar reads exactly ["Bayfront Park", "Not worth it · ~5 min walk"].
mfix8_oracle trip_verdict
# 4. Oracle: of two near saved trips, the soonest m7b leave-by (saved second, not from the nearest station) takes the bar.
mfix8_oracle soonest
# 4b. Oracle: a live (fresh) prediction for the judged ride's trip at its boarding stop moves the bar's verdict to the engine's verdict over that live time (label says "live"); predictions for the other direction's trip and for another station's trip never move it.
mfix8_oracle live_merge
# 5. One passing test each (src/ui/now/__tests__): judged from its origin with its rides only; the soonest leave-by wins; the estimated walk is labelled.
jest_cases src/ui/now/__tests__ 'a near saved trip is judged from its origin with only rides that reach its destination' 'the near saved trip with the soonest leave-by takes the bar' 'an estimated walk is labelled as estimated'

# --- (4) An active (not-near) trip's countdown keeps priority -----------------------------------------------------
# 6. Oracle: a far saved trip (Dadeland North -> Dadeland South, walk 4 min) whose countdown is live beside a near trip: the bar is exactly ["Dadeland South", m7b's heroOf text], no verdict.
mfix8_oracle countdown
# 7. One passing test (src/ui/now/__tests__).
jest_cases src/ui/now/__tests__ 'an active trip countdown keeps priority over a near trip'

# --- (6) "Near", exported and tested at the boundary --------------------------------------------------------------
# 8. Oracle: NEAR_TRIP_M (src/ui/now/homeContext.ts) === HURRY_RANGE_M; a rider 0.01 m inside it gets the trip's verdict, 1 m beyond it gets the trip's m7b countdown (no verdict).
mfix8_oracle near_boundary
# 8b. Oracle: a rider EXACTLY NEAR_TRIP_M (the app's own haversine) from Palmetto's nearest platform, ~2004.7 m from its centre, is near: the bar reads [Okeechobee, the trip's status line] (a strict `<` or a station-centre build fails).
mfix8_oracle near_exact
# 9. One passing test (src/ui/now/__tests__).
jest_cases src/ui/now/__tests__ 'a trip origin at the near limit is near and one metre beyond is not'

# --- Realtime cost: the bar watches only what it judges -----------------------------------------------------------
# 10. Oracle: with no saved trip the bar asks the live runtime to watch NO station; with the near trip, exactly [[Brickell City Centre]] once.
mfix8_oracle watch
# 11. One passing test (src/ui/now/__tests__).
jest_cases src/ui/now/__tests__ 'the bar watches only the judged trip origin'

# --- (D) The bar fits and names what it judges; (C) every number is labelled --------------------------------------
# 12. Oracle: REGULAR_LINE_MAX_CHARS (src/ui/now/now-text.ts) is 30..38 (measured: 40 characters showed at 15 pt before the ellipsis on Jamie's phone); in six real states (no trip, no fix, 01:30, near trip, the longest destination Miami International Airport, a countdown) every regular line is one line, <= the budget, <= 15 pt, and a trip's destination comes first, whole.
mfix8_oracle budget
# 13. Oracle: hurryShort / hurryInline say the note's exact labelled strings for CHILL, CHILL under a minute, JOG, NOT_WORTH_IT, MISSED (makeable / not) and NO_SERVICE — never a bare "Chill · 2 min".
mfix8_oracle copy
# 14. One passing test each: the budget over every real station name x every verdict (src/ui/now/__tests__); every verdict number labelled (src/ui/hurry/__tests__).
jest_cases src/ui/now/__tests__ 'every bar line fits the measured budget'
jest_cases src/ui/hurry/__tests__ 'every verdict number is labelled'

# --- (B) The route chip walks the routed walk ---------------------------------------------------------------------
# 15. Oracle on m10a's committed fixture: CHIP_ROUTED_START_M (src/ui/routes/route-options.ts) === 50; with the rider at the plan's start and 40 m from it, every option whose first ride is reached by routed WALK legs takes walkS = their distanceM sum / walkMps and jogS = sum / jogMps (no detour); 300 m from the start, mfix5's straight line from the rider x 1.3; the REAL RouteOptionsList's chips show hurryShort exactly.
mfix8_oracle chip_walk
# 15b. Oracle: firstLegVerdict(itinerary, position, now, pace) keeps m10a's straight line (the default); firstLegVerdict(..., pace, true) opts in to the routed walk.
mfix8_oracle first_leg_optin
# 16. One passing test (src/ui/routes/__tests__).
jest_cases src/ui/routes/__tests__ 'the hurry chip walks the routed first walk leg'

# --- (A) Save a trip from route options ---------------------------------------------------------------------------
# 17. Oracle: the REAL ItineraryDetail inside UserDbProvider: the single-ride Mover itinerary shows one 'itinerary-save-trip' ("Save this trip"); its tap writes mover:government-center -> mover:financial-district to the real user DB; a multi-ride itinerary shows none and one line of why ('itinerary-save-trip-why').
mfix8_oracle save_trip
# 18. One passing test each (src/ui/routes/__tests__).
jest_cases src/ui/routes/__tests__ 'a single-ride itinerary saves as a trip' 'a multi-ride itinerary offers no save and says why'

# --- (5) and earlier cards stay as they were (re-checks, guarded on this card's files) ----------------------------
# 19. The station sheet's cards keep m7c's copy byte for byte (hurryCopy / hurryParts), and m7c's HurryCard cases stay green.
after_card mfix8_oracle copy_unchanged
after_card jest_nonempty src/ui/hurry/__tests__/HurryCard.test.tsx 'accessibility label is the VoiceOver sentence'
after_card jest_nonempty src/ui/hurry/__tests__/HurryCard.test.tsx 'live verdict shows the Live badge'
# 20. m7b's night and at-station contexts stay green; mfix6's real app still opens exactly one location watch.
after_card jest_nonempty src/ui/now '01:30'
after_card jest_nonempty src/ui/now '120 m'
after_card jest_nonempty src/ui/location/__tests__/one-watch.test.tsx 'the real app opens exactly one location watch$'
# 20b. m10a's first-leg verdict cases (its gates 21-22) stay green: the routed walk is opt-in.
after_card jest_nonempty src/domain/routes/__tests__/overlay.test.ts 'first-leg verdict near the stop -> CHILL'
after_card jest_nonempty src/domain/routes/__tests__/overlay.test.ts 'first-leg verdict, only jogging makes it -> JOG'
# 21. The card's tests mock only native packages, each labelled (mfix6's helper).
after_card mocks_native_only src/ui/now/__tests__
after_card mocks_native_only src/ui/routes/__tests__
after_card mocks_native_only src/ui/hurry/__tests__

# --- Repo-wide ----------------------------------------------------------------------------------------------------
# 22. With this card's files in the tree: tsc (app + scripts), eslint --max-warnings 0, standards, jest (every test), node:test — all green.
card_full_gate
# 23. (guarded) Metro bundles the app for iOS on a private cache, and the --no-bytecode bundle carries "Where to?".
card_export_carries 'Where to?'

echo "mfix8_trip_bar: all 35 gate lines green"
