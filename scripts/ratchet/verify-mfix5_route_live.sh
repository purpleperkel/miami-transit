#!/usr/bin/env bash
# mfix5_route_live — route options stay honest while the sheet is open (todo.miami_transit_route_live_overlay_fix,
# from the m10b build, 2026-10-02): (1) m10a's overlayLive moves a late leg's ARRIVAL with its departure and
# carries the delay to later legs until a transfer absorbs it, recomputing the itinerary's arrival and duration;
# a delay that overruns a transfer's slack leaves the next leg on its schedule and flags the itinerary
# connectionAtRisk, 'Tight transfer · may miss <line>' (ARBITER RULING 2026-10-02, binding);
# (2) the open plan sheet re-plans once after its first option's departure passes, through the polite client
# only; (3) "Route from here" measures the first-leg hurry chip's walk from the rider's position when there is
# one, from the plan's start otherwise. Builds on m10a (overlay, polite client) and m10b (the sheet).
# FIXTURE-ONLY: no gate calls the network. REALTIME COST RULE: no new live prediction calls.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
# Every gate is ONE simple command per line (never `cmd && gate`: under `set -e` a failing left side does not
# stop the script); compound checks live inside the card helpers below, and no gate reads a variable or a file
# another gate created (the MFIX5_* arrays are fixed text). Run one gate alone, from the repo root:
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-mfix5_route_live.sh
#
# TEST-NAME CONVENTION (m10b's, verbatim): each acceptance case is its OWN passing jest test whose full name
# (describe titles + test title, joined by one space, case-insensitive) ENDS with the exact phrase in
# MFIX5_CASES, starting at a word boundary, matched as a literal. No phrase is a suffix of another (checked on
# every call), so one catch-all test satisfies at most one case.

# ---- fixed card data (read by helpers; no gate sets them) ----

# The card-wide universe of named jest cases (gates 4, 5, 6 and 9, plus the guard of gates 7, 11 and 12). The
# overlay's three live in m10a's routes domain tests; the sheet's four in m10b's UI tests (mfix5_built slices them).
MFIX5_CASES=(
  'a 120 s late first leg shifts its departure and arrival by 120 s'
  'a late leg carries its delay to later legs until a transfer absorbs it'
  'a late leg recomputes the itinerary arrival and duration'
  'the open plan sheet re-plans once after its first option departs'
  'Route from here hurry chip walks from the user position'
  'Route from here hurry chip walks from the plan start without a user position'
  'an option whose transfer may be missed says Tight transfer · may miss 26'
)
# Where each half's cases live: the overlay's in m10a's routes domain tests, the sheet's in m10b's UI tests.
MFIX5_DOMAIN_TESTS=src/domain/routes/__tests__
MFIX5_UI_TESTS=src/ui/routes/__tests__
OVERLAY=src/domain/routes/overlay.ts
TRANSITOUS=src/domain/routes/transitous.ts
POLITE=src/domain/routes/polite-client.ts
FIXTURE=src/domain/routes/__fixtures__/transitous-plan.json

# ---- card helpers. Each fails loud with a named reason. ----

# mfix5_cases <path> <phrase>... — m10b's m10b_cases, verbatim (names adjusted): ONE unfiltered jest run over the
# path with a JSON report: jest green, >= 1 test, nothing failed/skipped/todo; then every <phrase> must be in
# MFIX5_CASES and be ended by the full name of >= 1 PASSED test that ends with no other MFIX5_CASES phrase.
mfix5_cases() { _mfix5_cases_in '' "$@"; }
# _mfix5_cases_in <keep-report|''> <path> <phrase>... — the body; with a report path it writes jest's JSON report
# there and leaves it for the caller (mfix5_rendered_cases reads which file proved each case); '' = a temp file.
_mfix5_cases_in() {
  local keep="$1" path report out rc=0; shift; path="$1"; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: mfix5_cases needs at least one case"; return 1; }
  _no_argv_in_tests "$path" || return 1
  if [ -n "$keep" ]; then report="$keep"; else report=$(mktemp -t ratchet-mfix5.XXXXXX) || { echo "ratchet: mktemp failed"; return 1; }; fi
  out=$(local_bin jest --ci --json --outputFile="$report" "$path" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$report" ]; then
    echo "$out" | tail -30; [ -n "$keep" ] || rm -f "$report"; echo "ratchet: jest is red (exit $rc) under $path"; return 1
  fi
  node - "$report" "$path" "$#" "$@" "${MFIX5_CASES[@]}" <<'NODE' || rc=1
const fs = require('node:fs');
const [report, where, count, ...rest] = process.argv.slice(2);
const n = Number(count);
const wanted = rest.slice(0, n).map((s) => s.toLowerCase());
const universe = rest.slice(n).map((s) => s.toLowerCase());
const authoring = [];
if (!(n >= 1) || universe.length === 0) authoring.push(`bad arguments (${n} case(s), ${universe.length} in MFIX5_CASES)`);
if (new Set(universe).size !== universe.length) authoring.push('MFIX5_CASES lists a phrase twice');
for (const a of universe) for (const b of universe) {
  if (a !== b && b.endsWith(` ${a}`)) authoring.push(`"${a}" is a suffix of "${b}"`);
}
wanted.filter((w) => !universe.includes(w)).forEach((w) => authoring.push(`"${w}" is not in MFIX5_CASES`));
if (authoring.length > 0) {
  authoring.forEach((p) => console.log(`ratchet: verify-script authoring error: ${p}`));
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const all = r.testResults.flatMap((t) => t.assertionResults);
const notPassed = all.filter((a) => a.status !== 'passed');
if (r.success !== true || r.numFailedTestSuites > 0 || r.numRuntimeErrorTestSuites > 0 || notPassed.length > 0 || all.length === 0) {
  console.log(`ratchet: ${where}: ${all.length - notPassed.length} passed; not passed: ${notPassed.map((a) => `${a.status}: ${a.fullName}`).slice(0, 5).join('; ') || 'none'} — failing/skipped/todo tests are forbidden`);
  process.exit(1);
}
const ends = (name, phrase) => name === phrase || name.endsWith(` ${phrase}`);
const problems = [];
for (const w of wanted) {
  const hits = all.filter((a) => ends(a.fullName.toLowerCase(), w));
  const own = hits.filter((a) => universe.every((o) => o === w || !ends(a.fullName.toLowerCase(), o)));
  if (hits.length === 0) problems.push(`no passing test's full name ends with "${w}"`);
  else if (own.length === 0) problems.push(`"${w}" only ends tests that also end with another card phrase — give it its own test`);
}
if (problems.length > 0) {
  problems.forEach((p) => console.log(`ratchet: ${where}: ${p}`));
  console.log(`passed tests: ${all.map((a) => a.fullName).join('  ;  ')}`);
  process.exit(1);
}
console.log(`ratchet: ${where}: ${all.length} tests green; ${wanted.length} named case(s), each its own passing test`);
NODE
  [ -n "$keep" ] || rm -f "$report"
  return "$rc"
}

# mfix5_rendered_cases <path> <phrase>... — mfix5_cases, then (from the same run's JSON report; mfix3's map_cases
# pattern) each phrase's own passing test lives in a test file that value-imports the REAL options list —
# RouteOptionsList from src/ui/routes/RouteOptionsList.tsx, PlanScreen from src/ui/routes/PlanScreen.tsx, or the
# plan route's default export (src/app/plan.tsx) — and RENDERS that binding as a JSX element (TypeScript AST:
# `import type`, a bare mention, comments and strings do not count; another export of those files does not
# count). So the 'Tight transfer' copy is proven on the row the sheet draws, not on a standalone look-alike.
mfix5_rendered_cases() {
  local path="$1" report rc=0
  report=$(mktemp -t ratchet-mfix5-rendered.XXXXXX) || { echo "ratchet: mktemp failed"; return 1; }
  _mfix5_cases_in "$report" "$@" || { rm -f "$report"; return 1; }
  node - "$report" "$path" "$(($# - 1))" "${@:2}" "${MFIX5_CASES[@]}" <<'NODE' || rc=1
const fs = require('node:fs'), path = require('node:path'), ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [report, where, count, ...rest] = process.argv.slice(2);
const wanted = rest.slice(0, Number(count)).map((s) => s.toLowerCase());
const universe = rest.slice(Number(count)).map((s) => s.toLowerCase());
const ends = (name, p) => name === p || name.endsWith(' ' + p);
// module file -> the export that IS the real options list (or the sheet / route that mounts it)
const REAL = new Map([['src/ui/routes/RouteOptionsList.tsx', 'RouteOptionsList'], ['src/ui/routes/PlanScreen.tsx', 'PlanScreen'], ['src/app/plan.tsx', 'default']].map(([f, e]) => [path.join(ROOT, f), e]));
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
const resolveSpec = (from, spec) => {
  const base = spec.startsWith('./') || spec.startsWith('../') ? path.resolve(path.dirname(from), spec) : spec.startsWith('@/') ? path.join(ROOT, 'src', spec.slice(2)) : null;
  return base === null ? null : (EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) ?? null);
};
function rendersReal(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tags = [];
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || s.importClause.isTypeOnly) continue;
    const want = REAL.get(resolveSpec(file, s.moduleSpecifier.text)), c = s.importClause, nb = c.namedBindings;
    if (want === undefined) continue;
    if (c.name && want === 'default') tags.push(c.name.text);
    if (nb && ts.isNamespaceImport(nb)) tags.push(`${nb.name.text}.${want}`);
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly && (e.propertyName ?? e.name).text === want) tags.push(e.name.text);
  }
  const stack = [sf];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) {
    const n = stack.pop();
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && tags.includes(n.tagName.getText(sf))) return true;
    ts.forEachChild(n, (k) => { stack.push(k); });
  }
  return false;
}
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const problems = [];
for (const w of wanted) {
  const files = r.testResults.filter((t) => t.assertionResults.some((a) => {
    const name = a.fullName.toLowerCase();
    return a.status === 'passed' && ends(name, w) && universe.every((o) => o === w || !ends(name, o));
  })).map((t) => t.name);
  if (!files.some(rendersReal)) problems.push(`"${w}" is proven only in ${files.map((f) => path.relative(ROOT, f)).join(', ') || '(no file)'}, which never value-imports AND renders (<RouteOptionsList …/>, <PlanScreen …/> or the plan route) the real options list`);
}
if (problems.length > 0) { problems.forEach((p) => console.log(`ratchet: ${where}: ${p}`)); fail('the case must render the options list the sheet shows, not a standalone stub'); }
console.log(`ratchet: ${where}: ${wanted.length} case(s), each proven in a test file that renders the real options list`);
NODE
  rm -f "$report"
  return "$rc"
}

# mfix5_node <label> <js-body> <required-file>... — m10a's card_node, verbatim in shape: the files exist (named
# failure), then the body runs as an ES module with tsx loaded (it imports the card's .ts modules as the app
# would), from the repo root, and prints 'ratchet: <label>: <reason>' + exits 1 on failure. Network-free.
mfix5_node() {
  local label="$1" body="$2" out f
  shift 2
  for f in "$@"; do need_file "$f" || return 1; done
  [ -f node_modules/tsx/package.json ] || { echo "ratchet: tsx is not installed in node_modules"; return 1; }
  out=$(MFIX5_GATE="$label" MFIX5_TRANSITOUS="./$TRANSITOUS" MFIX5_OVERLAY="./$OVERLAY" MFIX5_FIXTURE="$FIXTURE" \
    node --import tsx --input-type=module -e "$JS_PRELUDE"$'\n'"$body" 2>&1) \
    || { echo "$out" | tail -25; echo "ratchet: $label is red"; return 1; }
  echo "$out" | tail -3
}

# Shared by the overlay checks (m10a's prelude, trimmed to what they use): named failures, the parsed REAL
# fixture, its two itineraries riding the Orange train (trip ...6283593 from Government Center 2:12 PM), and an
# m4a-shaped realtime prediction (plain GTFS ids) for that train's BOARDING stop, `late` seconds late.
#   RAIL_ONLY  walk -> Orange 2:12-2:14 -> walk 2:14-2:28                                 (0 transfers)
#   RAIL_BUS   walk -> Orange 2:12-2:14 -> walk 2:14-2:16 -> bus 26 2:17-2:19 -> walk    (1 transfer, 60 s slack)
JS_PRELUDE=$(cat <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const E = process.env;
const fail = (m) => { console.log(`ratchet: ${E.MFIX5_GATE}: ${m}`); process.exit(1); };
const check = (cond, m) => { if (!cond) fail(m); };
const same = (got, want, m) => { try { assert.deepStrictEqual(got, want); } catch (e) { console.log(e.message.split('\n').slice(0, 18).join('\n')); fail(m); } };
const call = (f, what) => { try { return f(); } catch (e) { return fail(`${what} threw ${e?.name ?? 'an error'}: ${e?.message ?? e}`); } };
const load = async (path, names) => {
  let m;
  try { m = await import(path); } catch (e) { return fail(`cannot import ${path}: ${e.message}`); }
  for (const n of names) check(typeof m[n] === 'function', `${path} does not export a function named ${n}`);
  return m;
};
const tripOf = (id) => id.replace(/^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/, '');
const unprefix = (id) => id.replace(/^[A-Za-z0-9-]+_/, '');
const { parseItineraries } = await load(E.MFIX5_TRANSITOUS, ['parseItineraries']);
const { overlayLive } = await load(E.MFIX5_OVERLAY, ['overlayLive']);
const parsed = call(() => parseItineraries(JSON.parse(fs.readFileSync(E.MFIX5_FIXTURE, 'utf8'))), 'parseItineraries(fixture)');
check(parsed?.ok === true, 'parseItineraries(fixture) is not ok');
const its = parsed.value;
const shape = (it) => it.legs.map((l) => (l.tripId === null ? 'WALK' : `${l.mode} ${l.routeShortName}`)).join(' > ');
const RAIL_ONLY = its.findIndex((it) => shape(it) === 'WALK > REGIONAL_RAIL 2600 > WALK');
const RAIL_BUS = its.findIndex((it) => shape(it) === 'WALK > REGIONAL_RAIL 2600 > WALK > BUS 26 > WALK');
check(RAIL_ONLY >= 0 && RAIL_BUS >= 0, `the fixture needs a walk/Orange/walk and a walk/Orange/walk/bus 26/walk itinerary (got: ${its.map(shape).join(' | ')})`);
const rail = its[RAIL_ONLY].legs[1];
check(rail.tripId === its[RAIL_BUS].legs[1].tripId, 'both itineraries must ride the same Orange train');
check(its[RAIL_BUS].legs[3].from.epoch - its[RAIL_BUS].legs[2].to.epoch === 60, 'the fixture transfer to bus 26 has 60 s of slack');
const late = (s) => ({ tripId: tripOf(rail.tripId), routeId: '31009', lineId: null, stopId: unprefix(rail.from.stopId), stationKey: null,
  epoch: rail.from.epoch + s, scheduledEpoch: rail.from.epoch, delayS: s, realtime: true, canceled: false, headsign: rail.headsign });
const before = JSON.stringify(its);
const overlaid = (s) => { const out = call(() => overlayLive(its, [late(s)]), `overlayLive(fixture, Orange ${s} s late)`);
  check(JSON.stringify(its) === before, 'overlayLive mutated its input itineraries');
  check(Array.isArray(out) && out.length === its.length, 'overlayLive returns every itinerary, in order'); return out; };
// `got` is `want` with both ends moved by `by` seconds (and its own duration still to - from).
const moved = (got, want, by, what) => {
  check(got?.from?.epoch === want.from.epoch + by, `${what}: departure must be ${by >= 0 ? '+' : ''}${by} s (scheduled ${want.from.epoch}, got ${got?.from?.epoch})`);
  check(got?.to?.epoch === want.to.epoch + by, `${what}: arrival must be ${by >= 0 ? '+' : ''}${by} s (scheduled ${want.to.epoch}, got ${got?.to?.epoch})`);
  check(got.durationS === got.to.epoch - got.from.epoch, `${what}: durationS ${got.durationS} must be arrival - departure (${got.to.epoch - got.from.epoch})`);
};
// The itinerary's own totals agree with its legs: arrival = last leg's arrival, duration = arrival - start.
const totals = (got, what) => {
  check(got.endEpoch === got.legs[got.legs.length - 1].to.epoch, `${what}: endEpoch ${got.endEpoch} must be the last leg's arrival ${got.legs[got.legs.length - 1].to.epoch}`);
  check(got.durationS === got.endEpoch - got.startEpoch, `${what}: durationS ${got.durationS} must be endEpoch - startEpoch (${got.endEpoch - got.startEpoch})`);
};
JS
)

# (1) The Orange train 120 s late at its boarding stop: in BOTH itineraries riding it, the leg departs AND arrives
# +120 s (no live arrival is predicted, so the arrival moves by the delay); in RAIL_ONLY the later walk moves
# +120 s and the itinerary arrives 120 s later with its duration recomputed; itineraries not riding the train are
# deep-equal to their parsed selves. RAIL_BUS's transfer cannot absorb 120 s (60 s of slack): under the ARBITER
# RULING (2026-10-02, binding) bus 26 keeps its schedule and the itinerary is flagged connectionAtRisk — gate 3
# (JS_MISSED_120) checks that half; this check covers only RAIL_BUS's Orange leg.
JS_LATE_120=$(cat <<'JS'
const out = overlaid(120);
for (const i of [RAIL_ONLY, RAIL_BUS]) {
  moved(out[i].legs[1], its[i].legs[1], 120, `itinerary ${i} Orange leg, 120 s late`);
  check(out[i].legs[1].live === true, `itinerary ${i}: the predicted Orange leg must be marked live`);
}
moved(out[RAIL_ONLY].legs[2], its[RAIL_ONLY].legs[2], 120, `itinerary ${RAIL_ONLY}: the walk after the late train`);
check(out[RAIL_ONLY].endEpoch === its[RAIL_ONLY].endEpoch + 120, `itinerary ${RAIL_ONLY} must arrive 120 s later (${its[RAIL_ONLY].endEpoch + 120}, got ${out[RAIL_ONLY].endEpoch})`);
totals(out[RAIL_ONLY], `itinerary ${RAIL_ONLY}`);
its.forEach((it, i) => { if (i !== RAIL_ONLY && i !== RAIL_BUS) same(out[i], it, `itinerary ${i} does not ride the late train and must be unchanged`); });
console.log(`ok: Orange 120 s late -> departs and arrives +120 s in itineraries ${RAIL_ONLY} and ${RAIL_BUS}; the later walk and itinerary ${RAIL_ONLY}'s arrival moved +120 s, duration recomputed`);
JS
)

# (1) The Orange train 45 s late: the transfer to bus 26 (60 s of slack) ABSORBS it. In RAIL_BUS the Orange leg and
# the transfer walk move +45 s; bus 26 and the last walk keep their scheduled times (and bus 26 is not marked live);
# the itinerary still arrives at its scheduled time. In RAIL_ONLY (no transfer) the delay reaches the arrival.
JS_ABSORBED_45=$(cat <<'JS'
const out = overlaid(45);
const got = out[RAIL_BUS]; const want = its[RAIL_BUS];
moved(got.legs[1], want.legs[1], 45, `itinerary ${RAIL_BUS} Orange leg, 45 s late`);
moved(got.legs[2], want.legs[2], 45, `itinerary ${RAIL_BUS}: the transfer walk after the late train`);
moved(got.legs[3], want.legs[3], 0, `itinerary ${RAIL_BUS}: bus 26 (the transfer's 60 s slack absorbs 45 s)`);
check(got.legs[3].live === false, `itinerary ${RAIL_BUS}: bus 26 has no prediction and must not be marked live`);
moved(got.legs[4], want.legs[4], 0, `itinerary ${RAIL_BUS}: the walk after bus 26`);
check(got.endEpoch === want.endEpoch, `itinerary ${RAIL_BUS} must still arrive at ${want.endEpoch} (got ${got.endEpoch})`);
totals(got, `itinerary ${RAIL_BUS}`);
moved(out[RAIL_ONLY].legs[2], its[RAIL_ONLY].legs[2], 45, `itinerary ${RAIL_ONLY}: the walk after the late train`);
check(out[RAIL_ONLY].endEpoch === its[RAIL_ONLY].endEpoch + 45, `itinerary ${RAIL_ONLY} must arrive 45 s later`);
totals(out[RAIL_ONLY], `itinerary ${RAIL_ONLY}`);
console.log(`ok: Orange 45 s late -> the bus 26 transfer absorbs it (itinerary ${RAIL_BUS} arrives on time); itinerary ${RAIL_ONLY} arrives 45 s later`);
JS
)

# (1) ARBITER RULING (2026-10-02, binding) — a missed connection: the Orange train 120 s late overruns the bus 26
# transfer's 60 s of slack. A bus does not wait for a late train, so in RAIL_BUS the transfer walk moves +120 s
# (the rider gets there later) but bus 26 and the final walk keep their scheduled times and are NOT marked live;
# the itinerary is flagged connectionAtRisk, naming line 26 (any shape that names it: the copy 'Tight transfer ·
# may miss 26', or a record carrying '26'). Never flagged: RAIL_ONLY (no transfer), and RAIL_BUS at 45 s late
# (the slack absorbs it). Absent, null and false all read as "not flagged".
JS_MISSED_120=$(cat <<'JS'
const names26 = (flag) => /(^|[^0-9])26([^0-9]|$)/.test(JSON.stringify(flag) ?? '');
const out = overlaid(120);
const got = out[RAIL_BUS]; const want = its[RAIL_BUS];
moved(got.legs[1], want.legs[1], 120, `itinerary ${RAIL_BUS} Orange leg, 120 s late`);
moved(got.legs[2], want.legs[2], 120, `itinerary ${RAIL_BUS}: the transfer walk after the late train`);
moved(got.legs[3], want.legs[3], 0, `itinerary ${RAIL_BUS}: bus 26 does not wait for a late train (ruling: keep its schedule)`);
moved(got.legs[4], want.legs[4], 0, `itinerary ${RAIL_BUS}: the walk after bus 26 (ruling: no fabricated shifted time)`);
check(got.legs[3].live === false && got.legs[4].live === false, `itinerary ${RAIL_BUS}: bus 26 and the final walk have no prediction and must not be marked live`);
totals(got, `itinerary ${RAIL_BUS}`);
check(Boolean(got.connectionAtRisk), `itinerary ${RAIL_BUS}: 120 s late overruns bus 26's 60 s slack — the itinerary must be flagged connectionAtRisk (got ${JSON.stringify(got.connectionAtRisk)})`);
check(names26(got.connectionAtRisk), `itinerary ${RAIL_BUS}: connectionAtRisk must name the line that may be missed, 26 (got ${JSON.stringify(got.connectionAtRisk)})`);
check(!out[RAIL_ONLY].connectionAtRisk, `itinerary ${RAIL_ONLY} has no transfer and must not be flagged (got ${JSON.stringify(out[RAIL_ONLY].connectionAtRisk)})`);
const absorbed = overlaid(45)[RAIL_BUS];
check(!absorbed.connectionAtRisk, `itinerary ${RAIL_BUS} at 45 s late: the 60 s slack absorbs it — it must not be flagged (got ${JSON.stringify(absorbed.connectionAtRisk)})`);
console.log(`ok: Orange 120 s late -> bus 26 and the final walk keep their schedule (not live), itinerary ${RAIL_BUS} flagged ${JSON.stringify(got.connectionAtRisk)}; rail-only and 45 s late not flagged`);
JS
)

# The spy appended to jest's own setupFilesAfterEnv by sheet_spy (tokens __DIR__ / __ROOT__ filled in). It
# records, per CURRENT TEST, one JSON line per event, the REAL modules still doing the work:
#   plan     every PolitePlanClient.prototype.plan(query) call: query.from, planCacheKey(query), whether a
#            NON-TEST frame under src/ui|src/app is on the stack (the sheet asked, not the test), and whether
#            jest's fake timers are installed, and the (fake) clock it was asked at; 'answer' adds that call's
#            earliest itinerary start
#   fetch    every request a PolitePlanClient sends through its INJECTED fetch (polite: true — seen even when
#            the test mocks expo/fetch itself, which replaces this spy's expo/fetch wrapper), plus any global
#            fetch / expo/fetch call that reaches this spy's wrappers, polite iff polite-client.ts is on its
#            stack. A test's own expo/fetch mock hides direct expo/fetch calls from the spy: the static gate
#            (ui_fetch_only_polite) is what bans them.
#   end      the fake clock when the test ended (read from the clock captured during the test)
#   verdict  every m10a firstLegVerdict(itinerary, position, ...) call: position, and whether a non-test .tsx
#            under src/ui|src/app is on the stack (a rendered component, not a test calling routeOptions)
#   user     every coordinate the app's ONE location module (src/ui/map/use-user-location.ts) hands out:
#            returned or resolved, bare, as Result .value, or as UserPosition .coordinate
JS_SHEET_SPY=$(cat <<'JS'
const fs = require('fs');
const rec = (o) => fs.appendFileSync('__DIR__/calls', JSON.stringify({ test: String(expect.getState().currentTestName), ...o }) + '\n');
const frames = (stack) => String(stack).split('\n').slice(2).filter((l) => !/\/__tests__\/|\.test\.tsx?:|\/node_modules\//.test(l));
const fromSheet = (stack) => frames(stack).some((l) => /\/src\/(ui|app)\/[^:]*\.tsx?:\d+/.test(l));
const viaPolite = () => /\/src\/domain\/routes\/polite-client\.ts:\d+/.test(String(new Error().stack));
const fromComponent = (stack) => frames(stack).some((l) => /\/src\/(ui|app)\/[^:]*\.tsx:\d+/.test(l));
const fake = () => jest.isMockFunction(globalThis.setTimeout) || typeof globalThis.setTimeout.clock === 'object';
const isPos = (p) => p !== null && typeof p === 'object' && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
const pos = (p) => ({ latitude: p.latitude, longitude: p.longitude });
// The fake clock the current test runs on, kept so the END time of the test stays readable even after the test
// or its own afterEach has gone back to real timers; every plan call records the fake time it was asked at.
const clockOf = { now: null };
const note = () => { const c = globalThis.setTimeout.clock; if (c !== null && typeof c === 'object' && Number.isFinite(c.now)) clockOf.now = () => c.now; };
beforeEach(() => { clockOf.now = null; });
afterEach(() => { note(); rec({ kind: 'end', at: clockOf.now === null ? null : clockOf.now() }); });
jest.mock('__ROOT__/src/domain/routes/polite-client', () => {
  const real = jest.requireActual('__ROOT__/src/domain/routes/polite-client');
  const plan = real.PolitePlanClient.prototype.plan;
  // Every client the app or a test builds gets its INJECTED fetch wrapped: a request the polite client itself
  // sends is a polite fetch, seen here whatever the test mocks underneath, its own expo/fetch mock included.
  class RatchetSpiedClient extends real.PolitePlanClient {
    constructor(deps, ...rest) {
      const send = deps.fetch;
      super({ ...deps, fetch: function ratchetPoliteFetchSpy(...args) { rec({ kind: 'fetch', via: 'polite client', polite: true }); return send.apply(this, args); } }, ...rest);
    }
  }
  real.PolitePlanClient.prototype.plan = function ratchetPlanSpy(query) {
    const stack = new Error().stack;
    note();
    rec({ kind: 'plan', from: pos(query.from), key: real.planCacheKey(query), timeEpoch: query.timeEpoch, at: Date.now(), sheet: fromSheet(stack), fake: fake() });
    const result = plan.call(this, query);
    result.then((o) => (o && o.kind === 'ok' && o.itineraries.length > 0 ? rec({ kind: 'answer', key: real.planCacheKey(query), firstStart: Math.min(...o.itineraries.map((it) => it.startEpoch)) }) : undefined),
      (e) => rec({ kind: 'rejected', message: String(e) }));
    return result;
  };
  return { ...real, __esModule: true, PolitePlanClient: RatchetSpiedClient };
});
jest.mock('__ROOT__/src/domain/routes/overlay', () => {
  const real = jest.requireActual('__ROOT__/src/domain/routes/overlay');
  return { ...real, __esModule: true, firstLegVerdict: function ratchetVerdictSpy(itinerary, position, ...rest) {
    rec({ kind: 'verdict', position: isPos(position) ? pos(position) : null, component: fromComponent(new Error().stack) });
    return real.firstLegVerdict(itinerary, position, ...rest);
  } };
});
jest.mock('__ROOT__/src/ui/map/use-user-location', () => {
  const real = jest.requireActual('__ROOT__/src/ui/map/use-user-location');
  const harvest = (v) => { for (const c of [v, v && v.value, v && v.coordinate]) if (isPos(c)) rec({ kind: 'user', position: pos(c) }); };
  const spied = { __esModule: true };
  for (const [name, value] of Object.entries(real)) {
    spied[name] = typeof value !== 'function' ? value : function ratchetLocationSpy(...args) {
      const out = value.apply(this, args);
      if (out && typeof out.then === 'function') out.then(harvest, () => undefined); else harvest(out);
      return out;
    };
  }
  return spied;
});
jest.mock('expo/fetch', () => {
  const real = jest.requireActual('expo/fetch');
  return { ...real, __esModule: true, fetch: function ratchetExpoFetchSpy(...args) { rec({ kind: 'fetch', via: 'expo/fetch', polite: viaPolite() }); return real.fetch(...args); } };
});
const globalFetch = globalThis.fetch;
globalThis.fetch = function ratchetFetchSpy(...args) { rec({ kind: 'fetch', via: 'global fetch', polite: viaPolite() }); return globalFetch.apply(this, args); };
JS
)

# sheet_spy replan|chip — runs the sheet's test dir UNFILTERED with JS_SHEET_SPY appended to the config's own
# setupFilesAfterEnv (never replacing them; m10b's hurry_chip_runs_engine pattern). The run must be green and
# the mode's named test(s) must pass; then, from what the spy saw DURING each named test:
#   replan  'the open plan sheet re-plans once after its first option departs': under fake timers the SHEET
#           (not the test) called the polite client's plan() >= 2 times, with EXACTLY 2 distinct cache keys, a
#           later call asked after the first answer's earliest departure, the polite client sent >= 1 request
#           (0 means the spy saw nothing — fail, never pass), zero direct fetch calls reached the spy, and the
#           fake clock ended >= 120 s after the re-plan (a re-plan loop would have shown a 3rd key).
#   chip    'Route from here hurry chip walks from the user position': the last verdict a RENDERED component
#           took is at a coordinate the app's location module handed out, >= 50 m from the plan's start (the
#           sheet's last plan() query.from — still the station); '...from the plan start without a user
#           position': the last such verdict is at the plan's start (within 1 m).
sheet_spy() {
  local mode="$1" dir out rc=0 line
  local after=()
  case "$mode" in replan|chip) ;; *) echo "ratchet: verify-script authoring error: sheet_spy replan|chip, got '$mode'"; return 1 ;; esac
  [ -d "$MFIX5_UI_TESTS" ] || { echo "ratchet: missing $MFIX5_UI_TESTS — the milestone's tests do not exist yet"; return 1; }
  _no_argv_in_tests "$MFIX5_UI_TESTS" || return 1
  while IFS= read -r line; do [ -n "$line" ] && after+=("$line"); done < <(local_bin jest --showConfig 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const f of JSON.parse(s).configs[0].setupFilesAfterEnv||[])console.log(f)})')
  dir="$PWD/.cache/ratchet-mfix5-spy.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  : > "$dir/calls"
  printf '%s\n' "$JS_SHEET_SPY" | sed -e "s|__DIR__|$dir|g" -e "s|__ROOT__|$PWD|g" > "$dir/sheet-spy.js" \
    || { rm -rf "$dir"; echo "ratchet: cannot write the spy"; return 1; }
  out=$(local_bin jest --ci --json --outputFile="$dir/report.json" "$MFIX5_UI_TESTS" \
    --setupFilesAfterEnv ${after[@]+"${after[@]}"} "$dir/sheet-spy.js" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$dir/report.json" ]; then
    echo "$out" | tail -25; rm -rf "$dir"; echo "ratchet: jest is red (exit $rc) under $MFIX5_UI_TESTS with the sheet spy"; return 1
  fi
  node - "$dir/report.json" "$dir/calls" "$mode" "${MFIX5_CASES[@]}" <<'NODE' || rc=1
const fs = require('node:fs');
const [report, callsFile, mode] = process.argv.slice(2);
const fail = (m) => { console.log(`ratchet: sheet_spy ${mode}: ${m}`); process.exit(1); };
const r = JSON.parse(fs.readFileSync(report, 'utf8'));
const all = r.testResults.flatMap((t) => t.assertionResults);
if (r.success !== true || all.some((a) => a.status !== 'passed')) fail('a card test failed, was skipped or is todo under the sheet spy');
const events = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const named = (phrase) => {
  const p = phrase.toLowerCase();
  const t = all.find((a) => a.fullName.toLowerCase() === p || a.fullName.toLowerCase().endsWith(` ${p}`));
  if (t === undefined) fail(`no passing test's full name ends with "${phrase}"`);
  return { name: t.fullName, seen: events.filter((e) => e.test === t.fullName) };
};
const meters = (a, b) => {
  const k = Math.PI / 180; const dLat = (b.latitude - a.latitude) * k; const dLon = (b.longitude - a.longitude) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * k) * Math.cos(b.latitude * k) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const sheetPlans = (seen) => seen.filter((e) => e.kind === 'plan' && e.sheet);
if (mode === 'replan') {
  const { name, seen } = named('the open plan sheet re-plans once after its first option departs');
  const plans = sheetPlans(seen);
  const direct = seen.filter((e) => e.kind === 'fetch' && !e.polite);
  if (direct.length > 0) fail(`"${name}": ${direct.length} direct fetch call(s) (${direct[0].via}) — the sheet asks Transitous through the polite client only`);
  const polite = seen.filter((e) => e.kind === 'fetch' && e.polite);
  if (polite.length === 0) fail(`"${name}": the spy saw no polite fetch (0 requests sent by the polite client) — the sheet's answers must come through PolitePlanClient's injected fetch (a test or sheet that answers some other way proves nothing)`);
  if (plans.length < 2) fail(`"${name}": the sheet called the polite client's plan() ${plans.length} time(s) (a test calling client.plan() itself does not count) — it must re-plan on its own`);
  if (!plans.every((p) => p.fake)) fail(`"${name}": plan() ran with real timers — drive the sheet's clock with jest fake timers`);
  const keys = new Set(plans.map((p) => p.key));
  if (keys.size !== 2) fail(`"${name}": the sheet's plan() calls had ${keys.size} distinct cache key(s) (${[...keys].join(' | ')}) — EXACTLY 2: the first ask and ONE re-plan for a new departure minute (no re-plan loop)`);
  const first = seen.find((e) => e.kind === 'answer' && e.key === plans[0].key);
  if (first === undefined) fail(`"${name}": the sheet's first plan() never answered with itineraries`);
  const later = plans.filter((p) => p.key !== plans[0].key && p.timeEpoch > first.firstStart);
  if (later.length === 0) fail(`"${name}": no later sheet plan() asked after the first answer's earliest departure (${first.firstStart})`);
  const replanAt = plans.find((p) => p.key !== plans[0].key).at;
  const end = seen.find((e) => e.kind === 'end');
  if (end === undefined || end.at === null) fail(`"${name}": the spy could not read the test's fake clock at its end — run the whole test under jest fake timers`);
  if (end.at < replanAt + 120_000) fail(`"${name}": the test ended ${((end.at - replanAt) / 1000).toFixed(0)} s after the re-plan — advance the fake clock >= 120 s past it, so a re-plan loop would show a 3rd plan`);
  console.log(`ratchet: "${name}": the sheet asked plan() ${plans.length} time(s), exactly 2 cache keys, re-planned at ${later[0].timeEpoch} > ${first.firstStart}; ${polite.length} polite request(s), no direct fetch; clock ran ${((end.at - replanAt) / 1000).toFixed(0)} s past the re-plan`);
} else {
  const user = named('Route from here hurry chip walks from the user position');
  const start = named('Route from here hurry chip walks from the plan start without a user position');
  const last = ({ name, seen }) => {
    const verdicts = seen.filter((e) => e.kind === 'verdict' && e.component && e.position !== null);
    const plans = sheetPlans(seen);
    if (verdicts.length === 0) fail(`"${name}": no rendered component took a first-leg verdict (m10a's firstLegVerdict) during the test`);
    if (plans.length === 0) fail(`"${name}": the sheet never asked the polite client for the plan during the test`);
    return { verdict: verdicts[verdicts.length - 1].position, from: plans[plans.length - 1].from };
  };
  const u = last(user);
  const fixes = user.seen.filter((e) => e.kind === 'user').map((e) => e.position);
  if (fixes.length === 0) fail(`"${user.name}": the app's location module (src/ui/map/use-user-location.ts) handed out no position during the test`);
  if (!fixes.some((f) => meters(f, u.verdict) <= 1)) fail(`"${user.name}": the chip's walk starts at ${JSON.stringify(u.verdict)}, which is not a position the location module handed out`);
  if (meters(u.verdict, u.from) < 50) fail(`"${user.name}": the chip's walk starts ${meters(u.verdict, u.from).toFixed(1)} m from the plan's start — mock a rider >= 50 m from the station, and measure from the rider`);
  const s = last(start);
  if (meters(s.verdict, s.from) > 1) fail(`"${start.name}": without a user position the chip's walk must start at the plan's start ${JSON.stringify(s.from)}, got ${JSON.stringify(s.verdict)}`);
  console.log(`ratchet: chip walks from the rider (${meters(u.verdict, u.from).toFixed(0)} m from the station) when located, from the plan's start otherwise`);
}
NODE
  rm -rf "$dir"
  return "$rc"
}

# ui_fetch_only_polite — static, comments and strings ignored (the TypeScript parser reads every NON-TEST
# .ts/.tsx/.js/.jsx under src/ui and src/app; __tests__/, __mocks__/, __fixtures__/ and *.test.* are skipped):
#   * only MFIX5_EXPO_FETCH_OK import expo/fetch (import/export-from, require(), import()) — the polite client's
#     timedPlanFetch and the diagnostics binary probe; src/live/http.ts (m4a's live transport) is outside this scope;
#   * no global fetch: no `fetch` value reference (call, alias, `{ fetch }` shorthand) and no
#     globalThis/window/global/self .fetch — except a bare `fetch` in a file whose expo/fetch import binds `fetch`.
# It exists because a test's own jest.mock('expo/fetch') replaces the spy's wrapper (gate 8 cannot see a sheet's
# direct expo/fetch call then).
# The tree before this card already passes it, so its gate runs as mfix5_fetch_guarded: first the re-plan case must
# exist and pass as its own test (the card is being built), then the static check.
MFIX5_EXPO_FETCH_OK=(src/ui/routes/plan-client.ts src/ui/diagnostics/data-probes.ts)
mfix5_fetch_guarded() {
  mfix5_cases "$MFIX5_UI_TESTS" 'the open plan sheet re-plans once after its first option departs' || return 1
  ui_fetch_only_polite || return 1
}
ui_fetch_only_polite() {
  local d
  for d in src/ui src/app; do [ -d "$d" ] || { echo "ratchet: missing $d"; return 1; }; done
  [ -f node_modules/typescript/package.json ] || { echo "ratchet: typescript is not installed in node_modules"; return 1; }
  node - "${MFIX5_EXPO_FETCH_OK[@]}" <<'NODE' || return 1
const fs = require('node:fs'), path = require('node:path'), ts = require(path.resolve('node_modules/typescript'));
const allowed = new Set(process.argv.slice(2));
const files = [], todo = ['src/ui', 'src/app'], problems = [];
for (let guard = 0; todo.length > 0 && guard < 100000; guard++) {
  const p = todo.pop();
  if (fs.statSync(p).isDirectory()) { if (!/(^|\/)(__tests__|__mocks__|__fixtures__)$/.test(p)) for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
  else if (/\.(ts|tsx|js|jsx)$/.test(p) && !/\.test\.[jt]sx?$/.test(p)) files.push(p);
}
const GLOBALS = new Set(['globalThis', 'window', 'global', 'self']);
const isExpoFetch = (n) => n !== undefined && ts.isStringLiteralLike(n) && n.text === 'expo/fetch';
const NAME_SLOT = (n) => { const p = n.parent; return (p.name === n && !ts.isShorthandPropertyAssignment(p)) || p.propertyName === n || ts.isTypeQueryNode(p) || ts.isQualifiedName(p); };
let nodes = 0;
for (const f of files) {
  const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, /x$/.test(f) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (n) => `${f}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  let bindsFetch = false; const refs = [];
  const stack = [src];
  for (let guard = 0; stack.length > 0 && guard < 5000000; guard++) {
    const n = stack.pop(); nodes++;
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && isExpoFetch(n.moduleSpecifier)) {
      if (!allowed.has(f)) problems.push(`${at(n)} imports expo/fetch — only ${[...allowed].join(' and ')} may (the sheet asks through the polite client)`);
      const named = n.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) bindsFetch ||= named.elements.some((e) => e.name.text === 'fetch' && (e.propertyName ?? e.name).text === 'fetch');
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && isExpoFetch(n.arguments[0]) && !allowed.has(f)) {
      problems.push(`${at(n)} loads expo/fetch — only ${[...allowed].join(' and ')} may`);
    } else if ((ts.isPropertyAccessExpression(n) && n.name.text === 'fetch') || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === 'fetch')) {
      if (ts.isIdentifier(n.expression) && GLOBALS.has(n.expression.text)) problems.push(`${at(n)} uses ${n.expression.text}.fetch — a direct request outside the polite client`);
    } else if (ts.isIdentifier(n) && n.text === 'fetch' && !NAME_SLOT(n)) refs.push(n);
    ts.forEachChild(n, (c) => { stack.push(c); });
  }
  if (!(allowed.has(f) && bindsFetch)) refs.forEach((n) => problems.push(`${at(n)} uses the global fetch — a direct request outside the polite client`));
}
if (files.length === 0 || nodes === 0) problems.push('no non-test source under src/ui and src/app was read');
if (problems.length > 0) { console.log(problems.join('\n')); console.log('ratchet: Transitous is asked through the polite client only — no direct fetch / expo/fetch in non-test src/ui|src/app'); process.exit(1); }
console.log(`ratchet: ${files.length} non-test files under src/ui and src/app: expo/fetch only in ${[...allowed].join(', ')}, no global fetch`);
NODE
}

# native_mocks_labelled <dir>... — m10b's helper, verbatim: every jest.mock/doMock in the dirs names a module by string
# literal, carries the '// test-time mock of native module' label on its line or the line above, and mocks a NATIVE
# module (expo*, @expo/*, react-native*, @react-native*). Mocking our own code is a stub.
native_mocks_labelled() {
  local d
  for d in "$@"; do [ -d "$d" ] || { echo "ratchet: missing $d — the milestone's tests do not exist yet"; return 1; }; done
  node - "$@" <<'NODE' || return 1
const fs = require('node:fs'), path = require('node:path');
const LABEL = 'test-time mock of native module';
const NATIVE = /^(expo([-/][\w./-]*)?|@expo\/[\w./-]+|react-native([-/][\w./-]*)?|@react-native(-[\w-]+)?\/[\w./-]+)$/;
const files = [], todo = process.argv.slice(2), problems = [];
for (let guard = 0; todo.length > 0 && guard < 10000; guard++) {
  const p = todo.pop();
  if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
  else if (/\.(ts|tsx|js|jsx)$/.test(p)) files.push(p);
}
let mocks = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8'), lines = text.split('\n');
  const calls = (text.match(/jest\.(mock|doMock)\(/g) || []).length;
  const re = /jest\.(mock|doMock)\(\s*(['"`])([^'"`]+)\2/g;
  let m, literal = 0;
  while ((m = re.exec(text)) !== null) {
    literal++; mocks++;
    const n = text.slice(0, m.index).split('\n').length - 1;
    const near = `${lines[n] ?? ''}\n${lines[n - 1] ?? ''}`;
    if (!near.includes(LABEL)) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") lacks the "// ${LABEL}" label`);
    if (!NATIVE.test(m[3])) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") mocks a non-native module (a stub of our own code)`);
  }
  if (literal !== calls) problems.push(`${f}: ${calls - literal} jest.mock call(s) without a literal module name`);
}
if (problems.length > 0) { console.log(problems.join('\n')); console.log('ratchet: test-time mocks must be labelled native modules only'); process.exit(1); }
console.log(`ratchet: ${files.length} test files, ${mocks} labelled native-module mocks`);
NODE
}

# mfix5_built — the guard in front of both repo-wide gates. This card adds no new module (it fixes m10a's overlay
# and m10b's sheet), so a bare full_gate would be green on the unfixed tree: first all seven MFIX5_CASES must
# exist and pass as their own tests, and every jest.mock in both test dirs must be a labelled native-module mock.
mfix5_built() {
  mfix5_cases "$MFIX5_DOMAIN_TESTS" "${MFIX5_CASES[@]:0:3}" || return 1
  mfix5_cases "$MFIX5_UI_TESTS" "${MFIX5_CASES[@]:3:4}" || return 1
  native_mocks_labelled "$MFIX5_DOMAIN_TESTS" "$MFIX5_UI_TESTS" || return 1
}

# mfix5_full_gate — guarded (mfix5_built), then tsc (app + scripts), eslint --max-warnings 0, standards, jest and
# node:test are green (lib's full_gate, which also bans process.argv in tests).
mfix5_full_gate() {
  mfix5_built || return 1
  full_gate || return 1
}

# mfix5_bundle — guarded (mfix5_built), then Metro bundles the app for iOS (lib's ios_export) and a --no-bytecode
# export of the same app registers the ./plan.tsx route and carries "Route options" as a whole quoted literal
# (the .hbc is never grepped — see m5b). Both exports run on a Metro cache private to THIS tree (TMPDIR ->
# .cache/metro-tmp-mfix5): m10b proved Metro's shared cache can bundle ANOTHER tree's src/app from a worktree.
mfix5_bundle() {
  local dir=.cache/export-mfix5-js metro_tmp="$PWD/.cache/metro-tmp-mfix5" out key rc
  mfix5_built || return 1
  mkdir -p "$metro_tmp" || { echo "ratchet: cannot create $metro_tmp"; return 1; }
  ( export TMPDIR="$metro_tmp"; ios_export ) || return 1
  [ -d .cache/export/_expo/static/js/ios ] || { echo "ratchet: the export wrote no .cache/export/_expo/static/js/ios bundle"; return 1; }
  rm -rf "$dir" || { echo "ratchet: cannot clear $dir"; return 1; }
  out=$(TMPDIR="$metro_tmp" local_bin expo export --platform ios --no-bytecode --output-dir "$dir" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: the --no-bytecode iOS export failed"; return 1; }
  [ -d "$dir/_expo/static/js/ios" ] || { echo "$out" | tail -10; echo "ratchet: the --no-bytecode export wrote no $dir/_expo/static/js/ios bundle"; return 1; }
  for key in './plan.tsx' 'Route options'; do
    rc=0
    grep -rqF -e "\"$key\"" -e "'$key'" "$dir/_expo/static/js/ios" || rc=$?
    [ "$rc" -ne 1 ] || { echo "ratchet: the iOS JS bundle has no whole string literal \"$key\" — the route options sheet is not shipped"; return 1; }
    [ "$rc" -eq 0 ] || { echo "ratchet: grep failed (rc=$rc) while scanning $dir"; return 1; }
  done
  echo "ratchet: the iOS JS bundle registers ./plan.tsx and carries \"Route options\""
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: mfix5_route_live gate failed at verify script line $LINENO"' ERR

# --- (1) overlayLive: a late leg's arrival and the legs after it move too ---------------------------------------
# 1. Direct tsx call on the REAL fixture: the Orange train 120 s late at its boarding stop departs AND arrives +120 s in both itineraries riding it; the walk after it and the walk/Orange/walk itinerary's arrival move +120 s, duration recomputed; itineraries not riding it are unchanged.
mfix5_node overlay-late-120 "$JS_LATE_120" "$OVERLAY" "$TRANSITOUS" "$FIXTURE"
# 2. Direct tsx call on the REAL fixture: 45 s late, the transfer to bus 26 (60 s slack) absorbs it — the Orange leg and the transfer walk move +45 s, bus 26 and the last walk keep their times (bus not live), that itinerary arrives on time.
mfix5_node overlay-absorbed-45 "$JS_ABSORBED_45" "$OVERLAY" "$TRANSITOUS" "$FIXTURE"
# 3. ARBITER RULING, direct tsx call on the REAL fixture: 120 s late overruns bus 26's 60 s slack — bus 26 and the final walk keep their scheduled times (not live), the itinerary is flagged connectionAtRisk naming 26; the rail-only itinerary and the 45 s-late case are not flagged.
mfix5_node overlay-missed-120 "$JS_MISSED_120" "$OVERLAY" "$TRANSITOUS" "$FIXTURE"
# 4. One passing test each (routes domain tests, unfiltered run): 120 s late -> departure and arrival +120 s; the delay carries to later legs until a transfer absorbs it; the itinerary's arrival and duration are recomputed.
mfix5_cases src/domain/routes/__tests__ 'a 120 s late first leg shifts its departure and arrival by 120 s' 'a late leg carries its delay to later legs until a transfer absorbs it' 'a late leg recomputes the itinerary arrival and duration'
# 5. One passing test (route UI tests, unfiltered run) in a test file that value-imports and JSX-renders the real options list (RouteOptionsList, PlanScreen or the plan route): the option whose transfer may be missed says 'Tight transfer · may miss 26'.
mfix5_rendered_cases src/ui/routes/__tests__ 'an option whose transfer may be missed says Tight transfer · may miss 26'

# --- (2) the open sheet re-plans once its first option has left ------------------------------------------------
# 6. One passing test: the open plan sheet re-plans once after its first option departs.
mfix5_cases src/ui/routes/__tests__ 'the open plan sheet re-plans once after its first option departs'
# 7. Guarded by gate 6's case, static (comments ignored): in non-test src/ui|src/app only plan-client.ts and data-probes.ts import expo/fetch, and nothing uses the global fetch.
mfix5_fetch_guarded
# 8. Spy oracle (unfiltered run): during that test, under fake timers, the SHEET called the polite client's plan() with EXACTLY 2 cache keys, re-planning after the first answer's earliest departure; the polite client sent >= 1 request; no direct fetch reached the spy; the clock ran >= 120 s past the re-plan.
sheet_spy replan

# --- (3) "Route from here": the hurry chip walks from the rider -----------------------------------------------
# 9. One passing test each: the chip walks from the user position; from the plan start without one.
mfix5_cases src/ui/routes/__tests__ 'Route from here hurry chip walks from the user position' 'Route from here hurry chip walks from the plan start without a user position'
# 10. Spy oracle (unfiltered run): the rendered chip's verdict is taken at a position the app's location module handed out, >= 50 m from the plan's start (still the station); without one, at the plan's start.
sheet_spy chip

# --- Repo-wide --------------------------------------------------------------------------------------------------
# 11. Guarded: all seven named tests pass as their own tests and every jest.mock in both test dirs is a labelled native mock; then tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test are green.
mfix5_full_gate
# 12. Guarded the same way: Metro bundles the app for iOS on a tree-private cache, and the --no-bytecode iOS JS registers ./plan.tsx and carries "Route options".
mfix5_bundle

echo "mfix5_route_live: all 12 gates green"
