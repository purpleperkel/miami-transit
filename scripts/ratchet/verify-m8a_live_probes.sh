#!/usr/bin/env bash
# m8a_live_probes — realtime proven end to end on the Mac: the Transitland probe on the LIVE API with the real key (plan M8.2a), and REALISTIC SYNTHETIC live fixtures generated from the public GTFS, structure-checked against the real captures, under the mapper tests (plan M8.3 + §3 PUBLIC-REPO DATA RULE).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Every numbered gate runs ALONE after `source lib.sh` + this prelude (constants + card helpers): no gate
# reads a variable or a file that another gate created.
#
# PUBLIC-REPO DATA RULE (plan §3, arbiter 2026-10-01). The repo is public (MIT). Swiftly's license bars
# passing its content to third parties and Transitland requires honouring source licenses, so NO real
# realtime content is ever committed. Real captures live only in the gitignored .cache/live/ (the probe
# writes them there each run); the committed live fixtures are SYNTHETIC, generated deterministically
# from the public static GTFS (assets/db/schedule.db: real trip_ids and shapes, synthetic positions and
# times) by scripts/fixtures/make-live-fixtures.ts, in the exact field structure of the live feeds.
# Gates 5-9 prove the synthetic side offline; gate 17 proves no real capture byte is committable; gate 18
# proves the synthetic fixtures cover the real captures' structure.
#
# SERVICE HOURS. Gates 15-18 call the LIVE API. They run only 06:00-23:00 America/New_York, a margin
# inside Metrorail/Metromover service (~05:00-24:00); outside it they FAIL with "outside service hours —
# re-run", because an empty night-time feed would prove nothing.
#
# KEY HYGIENE. The real TRANSITLAND_API_KEY is read only by node: from .env here, or by the probe and
# the guard through --env-file. bash never holds it and nothing echoes it. Whatever a key-holding
# process writes goes through `scrubbed` before it is shown; a printed key is redacted in place and
# fails the gate.

PROBE=scripts/live/probe-transitland.ts
PROBE_TEST=scripts/live/__tests__/probe-transitland.test.ts
CHECKER=scripts/live/check-fixture-structure.ts                  # synthetic vs real structure: ONE JSON line
CHECKER_TEST=scripts/live/__tests__/check-fixture-structure.test.ts
GEN=scripts/fixtures/make-live-fixtures.ts                        # writes FX_VP + FX_DEP from schedule.db
FX_VP=src/domain/live/__fixtures__/synthetic-vehicle-positions.ts  # export SYNTHETIC_VEHICLE_POSITIONS_BYTES: Uint8Array
FX_DEP=src/domain/live/__fixtures__/synthetic-departures.ts       # export SYNTHETIC_DEPARTURES: { "9512": response, "9513": response }
CAP_VP=.cache/live/vehicle_positions.pb                           # the probe's per-run REAL captures (gitignored)
CAP_DEP_9512=.cache/live/departures-9512.json
CAP_DEP_9513=.cache/live/departures-9513.json
WORK=.cache/ratchet-m8a                                           # gitignored scratch, removed on exit
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# --- card-specific helpers (lib.sh has no regex need, non-test absence check, own-test multi-case pin
#     for jest or node:test, network-off run, frozen clock, key reader/scrubber, service-hours check,
#     probe harness or capture-leak scan; everything else comes from lib.sh) --

# need_re <ERE> <path>... — every path exists, and >= 1 NON-TEST line under them matches (tests are
# excluded so a test file cannot satisfy a source requirement).
need_re() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing file $p"; return 1; }; done
  grep -rqE --exclude-dir=__tests__ -- "$re" "$@" || { echo "ratchet: expected /$re/ in non-test code under $*"; return 1; }
}

# absent <ERE> <path>... — every path exists, and no NON-TEST line under them matches.
# A function (not `! grep`) on purpose: bash's `set -e` ignores a failing `!`-negated command.
absent() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing file $p"; return 1; }; done
  if grep -rqE --exclude-dir=__tests__ -- "$re" "$@"; then
    grep -rnE -m 5 --exclude-dir=__tests__ -- "$re" "$@"
    echo "ratchet: forbidden /$re/ in non-test code under $*"; return 1
  fi
}

# Named-case checker shared by jest_cases and nodetest_cases_offline. Each pattern is a case-insensitive
# JS regex on a test's FULL name (describe/suite titles + test title) and must name >= 1 PASSED test of
# its OWN: one whose full name matches no other pattern of the same gate, so a single catch-all test
# cannot stand in for several acceptance cases. Keep case keywords out of describe/suite titles (a suite
# title is part of every full name beneath it).
# argv: <jest|tap> <jest JSON report path | "-" = names one per line on stdin> <where> <pattern>...
CASES_JS='
const fs = require("node:fs");
const [kind, src, where, ...pats] = process.argv.slice(1);
const fail = (m) => { console.log(`ratchet: ${where}: ${m}`); process.exit(1); };
if (pats.length === 0) fail("no case patterns given");
let names;
if (kind === "jest") {
  const r = JSON.parse(fs.readFileSync(src, "utf8"));
  const bad = [];
  if (r.success !== true) bad.push("jest reported success=false");
  if (r.numFailedTests > 0 || r.numFailedTestSuites > 0 || r.numRuntimeErrorTestSuites > 0) bad.push("failing tests or suites");
  if (r.numPendingTests > 0 || r.numTodoTests > 0) bad.push("skipped/todo tests are forbidden");
  if (bad.length > 0) fail(bad.join("; "));
  names = r.testResults.flatMap((s) => s.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName);
} else if (kind === "tap") {
  names = fs.readFileSync(0, "utf8").split("\n").filter((n) => n.trim() !== "");
} else {
  fail(`unknown report kind "${kind}" (want jest or tap)`);
}
if (names.length === 0) fail("no test passed");
const res = pats.map((p) => new RegExp(p, "i"));
const own = (i) => names.some((n) => res[i].test(n) && res.every((r, j) => j === i || !r.test(n)));
const missing = pats.filter((p, i) => !own(i));
if (missing.length > 0) {
  console.log("passing tests:\n  " + names.slice(0, 40).join("\n  "));
  fail(`no passing test of its own (matching no other case of this gate) named /${missing.join("/i, /")}/i`);
}
console.log(`ratchet: ${where}: ${names.length} passing; ${pats.length} named case(s), each its own test`);
'

# jest_cases <test-file> <ERE>... — ONE local-jest run of that file with a JSON report: green, >= 1 passed,
# nothing failed/skipped/todo, and every <ERE> names a passing test of its own (CASES_JS). (lib's
# jest_nonempty -t cannot pin several cases: jest reports each test the -t filter excludes as skipped,
# which jest_nonempty rightly rejects.)
jest_cases() {
  local file="$1" report out
  shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one case pattern"; return 1; }
  _no_argv_in_tests "$file" || return 1
  report="$PWD/$WORK/jest-cases.$(basename "$file").json"
  rm -f "$report"
  out=$(local_bin jest --ci --runTestsByPath "$file" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest red (or not installed) for $file"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; echo "ratchet: jest wrote no JSON report for $file"; return 1; }
  node -e "$CASES_JS" jest "$report" "$file" "$@"
}

# TAP on stdin -> the full name ("suite > … > leaf") of every REAL passing leaf, one per line. Same leaf
# rules as lib.sh's _nodetest_count (YAML type test; not SKIP/TODO; not a parent whose t.test() children
# ran; not Node 26's empty-file wrapper), but it prints the names so CASES_JS can check own tests.
_m8a_passing_names() {
  awk -v fp="$1" '
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
      full = stack[0]
      for (i = 4; i <= okd; i += 4) full = full " > " stack[i]
      print full
    }'
}

# NET_OFF (an --import preload, run before tsx): the real network is OFF. globalThis.fetch and node:http /
# node:https request/get (default and named imports, via syncBuiltinESMExports) throw, and each attempt is
# logged to stderr as "ratchet-net: <how> <host>" — the host only, never the URL, so no query string can
# be shown — which node:test echoes into the TAP as a "# ratchet-net:" comment. A test that injects its own
# fetch never reaches these.
NET_OFF='data:text/javascript,import http from "node:http";import https from "node:https";import {syncBuiltinESMExports} from "node:module";const mark=(how,u)=>{let h="?";try{h=new URL(String(u?.url??u?.href??u)).host}catch{h=String(u?.host??u?.hostname??"?")}process.stderr.write("ratchet-net: "+how+" "+h+"\n");return new Error("ratchet: the real network is off in this suite; inject fetch")};globalThis.fetch=async(u)=>{throw mark("fetch",u)};for(const [n,m] of [["http",http],["https",https]])for(const k of ["request","get"])m[k]=(u)=>{throw mark(n+"."+k,u)};syncBuiltinESMExports();'

# frozen_clock <epoch ms> <Math.random value> — an --import preload that freezes Date (new Date(),
# Date.now()) and Math.random. Two runs under DIFFERENT freezes produce the same output only if the
# program reads neither: the falsifier for "deterministic: fixed timestamps, seeded randomness".
frozen_clock() {
  printf 'data:text/javascript,const T=%s,R=%s,D=Date;class F extends D{constructor(...a){if(a.length===0)super(T);else super(...a)}static now(){return T}}globalThis.Date=F;Math.random=()=>R;' "$1" "$2"
}

# nodetest_cases_offline <file> <ERE>... — ONE unfiltered node:test run of the file with the network off
# (NET_OFF) and a 30 s per-test timeout (the probe waits 60 s between 404 retries, so a test on the real
# clock times out — the clock must be injected): green, no fail/skip/todo/cancelled (lib's
# _nodetest_clean), no real-network attempt even one a test caught, and every <ERE> names a passing test
# of its own (CASES_JS).
nodetest_cases_offline() {
  local file="$1" out names
  shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: nodetest_cases_offline needs at least one case pattern"; return 1; }
  _no_argv_in_tests "$file" || return 1
  out=$(node --import "$NET_OFF" --import tsx --test --test-timeout=30000 --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file (a timed-out test = the real clock; inject it)"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  if grep -qF "ratchet-net:" <<<"$out"; then
    grep -m 5 -F "ratchet-net:" <<<"$out"
    echo "ratchet: $file reached for the real network — its tests must inject fetch (no network)"; return 1
  fi
  names=$(echo "$out" | _m8a_passing_names "$file") \
    || { echo "ratchet: could not read test names from the TAP of $file"; return 1; }
  printf '%s\n' "$names" | node -e "$CASES_JS" tap - "$file" "$@"
}

# KEY_JS defines loadKey() for node programs: the .env TRANSITLAND_API_KEY value, never printed.
KEY_JS='
const fs = require("node:fs");
const { parseEnv } = require("node:util");
function loadKey() {
  if (!fs.existsSync(".env")) {
    console.log("ratchet: no .env in the repo root — M8.1 (Jamie) puts TRANSITLAND_API_KEY there (gitignored)");
    process.exit(1);
  }
  const raw = parseEnv(fs.readFileSync(".env", "utf8")).TRANSITLAND_API_KEY;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key.length < 16) {
    console.log("ratchet: .env has no usable TRANSITLAND_API_KEY (missing, empty or under 16 characters)");
    process.exit(1);
  }
  return key;
}
'

# env_key_ready — .env holds a usable TRANSITLAND_API_KEY (node checks it; the value is never shown).
env_key_ready() {
  node -e "$KEY_JS"'loadKey(); console.log("TRANSITLAND_API_KEY: present in .env (value not shown)");'
}

# scrubbed <file>... — fails if any existing file contains the key value; each such file is first
# redacted in place, so showing it afterwards can never leak the key.
scrubbed() {
  node -e "$KEY_JS"'
const key = loadKey();
const hit = [];
for (const f of process.argv.slice(1)) {
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, "latin1");
  if (text.includes(key)) {
    fs.writeFileSync(f, text.split(key).join("<TRANSITLAND_API_KEY redacted>"), "latin1");
    hit.push(f);
  }
}
if (hit.length > 0) {
  console.log("ratchet: the TRANSITLAND_API_KEY value appeared in " + hit.join(", ") + " (now redacted) — the key must never be printed or saved");
  process.exit(1);
}' "$@"
}

# in_service_hours — fails, with a clear re-run message, outside 06:00-23:00 America/New_York.
in_service_hours() {
  node -e '
const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
const get = (type) => Number(parts.find((p) => p.type === type).value);
const minutes = get("hour") * 60 + get("minute");
const hhmm = String(get("hour")).padStart(2, "0") + ":" + String(get("minute")).padStart(2, "0");
if (minutes < 6 * 60 || minutes >= 23 * 60) {
  console.log(`ratchet: outside service hours — it is ${hhmm} ET and this live gate runs only 06:00-23:00 ET (inside Metrorail/Metromover service, ~05:00-24:00). An empty night feed proves nothing: re-run m8a during service hours.`);
  process.exit(1);
}
console.log(`service hours: ${hhmm} ET (live gate window 06:00-23:00 ET)`);'
}

# probe_run — the plan's M8.2a V, exactly: `node --env-file=.env --import tsx scripts/live/probe-transitland.ts`.
# stdout -> $WORK/probe.out and stderr -> $WORK/probe.err, both scrubbed; sets PROBE_START_MS (used
# only inside the calling gate). Fails unless the probe exits 0.
probe_run() {
  local rc=0
  need_file "$PROBE" || return 1
  local_bin tsx --version >/dev/null || return 1
  env_key_ready || return 1
  in_service_hours || return 1
  PROBE_START_MS=$(node -e 'console.log(Date.now())') || { echo "ratchet: could not read the clock"; return 1; }
  node --env-file=.env --import tsx "$PROBE" >"$WORK/probe.out" 2>"$WORK/probe.err" || rc=$?
  scrubbed "$WORK/probe.out" "$WORK/probe.err" || return 1
  [ "$rc" -eq 0 ] \
    || { tail -20 "$WORK/probe.err"; tail -3 "$WORK/probe.out"; echo "ratchet: the probe exited $rc — it must exit 0 when every check holds"; return 1; }
}

# captures_ignored — the probe's three capture paths are gitignored and untracked (checked by path, so it
# holds before any capture exists), and nothing under .cache/ is tracked.
captures_ignored() {
  local tracked p
  tracked=$(git ls-files -- .cache) || { echo "ratchet: git ls-files failed"; return 1; }
  [ -z "$tracked" ] \
    || { printf '%s\n' "$tracked" | head -5; echo "ratchet: files under .cache/ are tracked — git rm --cached them (PUBLIC-REPO DATA RULE: real captures never enter the repo)"; return 1; }
  for p in "$CAP_VP" "$CAP_DEP_9512" "$CAP_DEP_9513"; do
    git check-ignore -q -- "$p" \
      || { echo "ratchet: $p is not gitignored — real captures must stay in the gitignored .cache/live/"; return 1; }
  done
}

# ANALYZE_JS (ESM; run with --import tsx): the gate's OWN reading of GTFS-realtime bytes, departures JSON
# and schedule.db, independent of the code under test: the reference bindings as oracle.
ANALYZE_JS='
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(path.resolve("package.json"));
const fail = (m) => { console.log("ratchet: " + m); process.exit(1); };
const tsModule = (p) => import(pathToFileURL(path.resolve(p)).href);
const MOVER = new Set(["14456", "14457"]);
const SCOPE = new Set(["31009", "14456", "14457"]);
const GC_STOPS = ["9512", "9513"];

function oracleDecode(bytes) {
  const rt = require("gtfs-realtime-bindings").transit_realtime;
  try { return rt.FeedMessage.toObject(rt.FeedMessage.decode(bytes), { longs: Number }); }
  catch (e) { fail("the oracle (gtfs-realtime-bindings) cannot decode the bytes as a FeedMessage: " + e.message); }
}

// R5: our decoder and the oracle agree on every entity (id, trip, route, vehicle, position, timestamp).
async function decoderDisagreement(bytes, oracle) {
  const { decodeFeedMessage } = await tsModule("src/domain/gtfsrt/decode-feed.ts");
  const ours = decodeFeedMessage(bytes);
  if (!ours.ok) return "our decoder returned Err " + JSON.stringify(ours.error);
  const pick = (e) => JSON.stringify([e.id, e.vehicle?.trip?.tripId ?? null, e.vehicle?.trip?.routeId ?? null,
    e.vehicle?.vehicle?.id ?? null, e.vehicle?.position?.latitude ?? null, e.vehicle?.position?.longitude ?? null,
    e.vehicle?.timestamp ?? null]);
  const a = ours.value.entity.map(pick);
  const b = (oracle.entity ?? []).map(pick);
  if (a.length !== b.length) return `entity count: ours ${a.length}, oracle ${b.length}`;
  const i = a.findIndex((x, k) => x !== b[k]);
  if (i >= 0) return `entity #${i}: ours ${a[i]} vs oracle ${b[i]}`;
  if (ours.value.header.timestamp !== (oracle.header?.timestamp ?? null)) return "header.timestamp differs";
  return null;
}

function scheduleTripIds() {
  const db = new DatabaseSync("assets/db/schedule.db", { readOnly: true });
  try { return new Set(db.prepare("SELECT trip_id FROM trip").all().map((r) => String(r.trip_id))); }
  finally { db.close(); }
}

// What the synthetic fixtures are generated from, read straight from the public schedule.db: each
// trip_id with its route and shape, each route with its shapes, each shape as a polyline, and the
// trip_ids whose pattern serves each Government Center rail platform (9512 SB, 9513 NB).
function scheduleFacts() {
  const db = new DatabaseSync("assets/db/schedule.db", { readOnly: true });
  try {
    const trips = new Map();
    for (const r of db.prepare("SELECT t.trip_id AS trip, p.route_id AS route, p.shape_idx AS shape FROM trip t JOIN pattern p ON p.pattern_idx = t.pattern_idx").all())
      trips.set(String(r.trip), { route: String(r.route), shape: Number(r.shape) });
    const routeShapes = new Map();
    for (const r of db.prepare("SELECT DISTINCT route_id AS route, shape_idx AS shape FROM pattern").all()) {
      if (!routeShapes.has(String(r.route))) routeShapes.set(String(r.route), []);
      routeShapes.get(String(r.route)).push(Number(r.shape));
    }
    const shapes = new Map();
    for (const r of db.prepare("SELECT shape_idx AS shape, lat, lon FROM shape_point ORDER BY shape_idx, seq").all()) {
      if (!shapes.has(Number(r.shape))) shapes.set(Number(r.shape), []);
      shapes.get(Number(r.shape)).push([Number(r.lat), Number(r.lon)]);
    }
    const serving = new Map();
    const q = db.prepare("SELECT DISTINCT t.trip_id AS trip FROM trip t JOIN pattern_stop ps ON ps.pattern_idx = t.pattern_idx JOIN stop s ON s.stop_idx = ps.stop_idx WHERE s.stop_id = ?");
    for (const stop of GC_STOPS) serving.set(stop, new Set(q.all(stop).map((r) => String(r.trip))));
    if (trips.size === 0 || shapes.size === 0) fail("assets/db/schedule.db has no trips or no shapes");
    return { trips, routeShapes, shapes, serving };
  } finally { db.close(); }
}

// Metres from (lat, lon) to a polyline [[lat, lon]...] (local equirectangular projection; Infinity if empty).
function metresToShape(lat, lon, pts) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let best = pts.length === 1 ? Math.hypot((pts[0][1] - lon) * kx, (pts[0][0] - lat) * ky) : Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
    const dx = (pts[i + 1][1] - lon) * kx - ax, dy = (pts[i + 1][0] - lat) * ky - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// Vehicle census. In scope = route 31009/14456/14457 or a trip_id known to schedule.db. Match rate (R8) =
// in-scope-by-route vehicles with a trip_id whose trip_id is in schedule.db (tripIds null = no DB join).
function census(oracle, tripIds) {
  const s = { ts: Number(oracle.header?.timestamp ?? 0), version: oracle.header?.gtfsRealtimeVersion ?? "",
    vehicles: 0, rail: 0, mover: 0, outOfScope: 0, inScope: 0, keyed: 0, matched: 0 };
  for (const e of oracle.entity ?? []) {
    const v = e.vehicle;
    if (!v) continue;
    s.vehicles++;
    const route = v.trip?.routeId ?? "";
    const trip = v.trip?.tripId ?? "";
    const known = trip !== "" && tripIds !== null && tripIds.has(trip);
    const scoped = route === "31009" || MOVER.has(route);
    if (route === "31009") s.rail++;
    else if (MOVER.has(route)) s.mover++;
    else if (route !== "") s.outOfScope++;
    if (scoped || known) s.inScope++;
    if (scoped && trip !== "") { s.keyed++; if (known) s.matched++; }
  }
  s.matchRate = s.keyed > 0 ? s.matched / s.keyed : null;
  return s;
}

// Departure rows of a Transitland departures response, found by shape (bounded iterative walk, no
// recursion): the object elements of every array held under a key named "departures". A row is
// REALTIME iff its trip.schedule_relationship (or, absent that, its own schedule_relationship) is a
// string other than "STATIC" and estimated_utc is set on its departure, its arrival or the row (plan M4.3b).
function departureRows(body) {
  const stack = [body];
  const rows = [];
  let steps = 0;
  while (stack.length > 0) {
    if (++steps > 1000000) fail("departures JSON walk exceeded 1e6 nodes");
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (!Array.isArray(v) && Array.isArray(v.departures))
      for (const r of v.departures) if (r !== null && typeof r === "object" && !Array.isArray(r)) rows.push(r);
    for (const x of Object.values(v)) stack.push(x);
  }
  return rows;
}
function estimateOf(row) {
  for (const o of [row.departure, row.arrival, row])
    if (o !== null && typeof o === "object" && typeof o.estimated_utc === "string" && o.estimated_utc !== "") return o;
  return null;
}
function isRealtime(row) {
  const rel = typeof row.trip?.schedule_relationship === "string" ? row.trip.schedule_relationship : row.schedule_relationship;
  return typeof rel === "string" && rel !== "STATIC" && estimateOf(row) !== null;
}
function countRows(body) {
  const rows = departureRows(body);
  return { rows: rows.length, realtime: rows.filter(isRealtime).length };
}

// Structure of a document as a set: every path present ("entity[].vehicle.trip.tripId", arrays as "[]")
// and every enum value used ("<path>=<VALUE>"). For GTFS-realtime the oracle spells each message twice
// (enums: String / numeric); a leaf that is a string in one and a number in the other is an enum. For
// departures JSON the enum keys are the schedule_relationship ones.
function shapeOf(a0, b0, isEnumPath) {
  const out = new Set();
  const stack = [[a0, b0, ""]];
  let steps = 0;
  while (stack.length > 0) {
    if (++steps > 5000000) fail("structure walk exceeded 5e6 nodes");
    const [a, b, p] = stack.pop();
    if (p !== "") out.add(p);
    if (Array.isArray(a)) { for (let i = 0; i < a.length; i++) stack.push([a[i], b?.[i], p + "[]"]); continue; }
    if (a !== null && typeof a === "object") { for (const k of Object.keys(a)) stack.push([a[k], b?.[k], p === "" ? k : p + "." + k]); continue; }
    if ((typeof a === "string" && typeof b === "number") || (isEnumPath(p) && (typeof a === "string" || typeof a === "number"))) out.add(p + "=" + a);
  }
  return out;
}
function pbShape(bytes) {
  const rt = require("gtfs-realtime-bindings").transit_realtime;
  let msg;
  try { msg = rt.FeedMessage.decode(bytes); }
  catch (e) { fail("the oracle cannot decode the bytes as a FeedMessage: " + e.message); }
  return shapeOf(rt.FeedMessage.toObject(msg, { enums: String, longs: Number }), rt.FeedMessage.toObject(msg, { longs: Number }), () => false);
}
function jsonShape(body) {
  return shapeOf(body, body, (p) => /(^|\.)schedule_relationship$/.test(p));
}
'

# Gate 8: the synthetic vehicle fixture is a realistic whole-agency feed generated from schedule.db, and
# our decoder reads it exactly like the oracle (R5).
SYN_VP_JS='
const file = process.argv[1];
const bytes = (await tsModule(file)).SYNTHETIC_VEHICLE_POSITIONS_BYTES;
if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail(`${file} must export SYNTHETIC_VEHICLE_POSITIONS_BYTES: a non-empty Uint8Array (an encoded GTFS-realtime FeedMessage)`);
const oracle = oracleDecode(bytes);
const facts = scheduleFacts();
const ON_SHAPE_M = 1;   // arbiter 2026-10-01: synthetic vehicles are placed ON the shape; real GPS scatters (>1 m), so an embedded old capture fails here
const ts = Number(oracle.header?.timestamp ?? 0);
const bad = [];
if (!oracle.header?.gtfsRealtimeVersion) bad.push("no header.gtfs_realtime_version");
if (!(Number.isInteger(ts) && ts >= Date.UTC(2026, 0, 1) / 1000 && ts < Date.UTC(2031, 0, 1) / 1000)) bad.push(`header.timestamp ${ts} is not a FIXED 2026-2030 epoch`);
const c = { vehicles: 0, rail: 0, omni: 0, inner: 0, outOfScope: 0, railTrips: 0, moverTrips: 0 };
const ids = new Set();
for (const e of oracle.entity ?? []) {
  const where = `entity ${JSON.stringify(e.id)}`;
  if (ids.has(e.id)) bad.push(`${where}: duplicate entity id`);
  if (!/^syn-/.test(String(e.id))) bad.push(`${where}: synthetic entity ids must start with "syn-" (public-repo data rule; real feed ids are never committed)`);
  ids.add(e.id);
  const v = e.vehicle;
  if (!v) continue;
  c.vehicles++;
  const trip = v.trip?.tripId ?? "";
  const known = facts.trips.get(trip);
  const route = v.trip?.routeId || known?.route || "";
  const at = v.position;
  if (v.timestamp != null && !(v.timestamp <= ts && v.timestamp >= ts - 900)) bad.push(`${where}: vehicle timestamp ${v.timestamp} is not within the 15 min before the header`);
  if (!SCOPE.has(route)) {
    if (route !== "") c.outOfScope++;
    if (known) bad.push(`${where}: out-of-scope route ${route} carries the in-scope trip ${trip}`);
    if (at && !(at.latitude > 25.1 && at.latitude < 26.0 && at.longitude > -80.9 && at.longitude < -80.1)) bad.push(`${where}: position outside Miami-Dade`);
    continue;
  }
  if (route === "31009") c.rail++; else if (route === "14456") c.omni++; else c.inner++;
  if (trip !== "" && !known) { bad.push(`${where}: trip_id ${trip} is not in schedule.db (use REAL trip_ids from the trip table)`); continue; }
  if (known && known.route !== route) { bad.push(`${where}: trip ${trip} runs on route ${known.route}, not ${route}`); continue; }
  if (known) { if (route === "31009") c.railTrips++; else c.moverTrips++; }
  if (!at) { bad.push(`${where}: an in-scope vehicle has no position`); continue; }
  const shapeIds = known ? [known.shape] : (facts.routeShapes.get(route) ?? []);
  const d = Math.min(...shapeIds.map((s) => metresToShape(at.latitude, at.longitude, facts.shapes.get(s) ?? [])));
  if (!(d <= ON_SHAPE_M)) bad.push(`${where}: position is ${Number.isFinite(d) ? d.toFixed(0) + " m" : "infinitely far"} from its ${known ? "trip" : "route"} shape (want <= ${ON_SHAPE_M} m: positions ON real shapes)`);
}
if (c.vehicles < 50) bad.push(`only ${c.vehicles} vehicles (want >= 50: a realistic whole-agency feed)`);
if (c.rail < 1 || c.railTrips < 1) bad.push(`Metrorail 31009: ${c.rail} vehicle(s), ${c.railTrips} on a real trip_id (want >= 1 of each)`);
if (c.omni < 1 || c.inner < 1 || c.moverTrips < 1) bad.push(`Metromover: ${c.omni} on 14456, ${c.inner} on 14457, ${c.moverTrips} on a real trip_id (want >= 1 of each)`);
if (c.outOfScope < 1) bad.push("no out-of-scope (bus) route id, so the mapper route filter is never exercised");
const disagree = await decoderDisagreement(bytes, oracle);
if (disagree !== null) bad.push("R5 — our decoder disagrees with the oracle: " + disagree);
if (bad.length > 0) fail(`${file} is not a realistic synthetic feed (${bad.length} problem(s)): ` + bad.slice(0, 12).join("; "));
console.log(`ratchet: ${file}: ${bytes.length} bytes at fixed ${new Date(ts * 1000).toISOString()}; ${c.vehicles} vehicles (${c.rail} rail, ${c.omni}+${c.inner} Mover, ${c.outOfScope} out of scope); in-scope trip_ids real and positions on their shapes; our decoder == oracle`);
'

# Gate 9: the synthetic departures fixture is a Transitland departures response per Government Center
# rail platform, on REAL trips that serve that platform, with >= 1 realtime row each.
SYN_DEP_JS='
const file = process.argv[1];
const dep = (await tsModule(file)).SYNTHETIC_DEPARTURES;
if (dep === null || typeof dep !== "object") fail(`${file} must export SYNTHETIC_DEPARTURES: { "9512": <departures response>, "9513": <departures response> }`);
const facts = scheduleFacts();
const bad = [];
const seen = [];
for (const stop of GC_STOPS) {
  const body = dep[stop];
  const stops = body?.stops;
  if (!Array.isArray(stops) || stops.length === 0) { bad.push(`["${stop}"] has no stops array (a Transitland departures response is { stops: [{ stop_id, departures: [...] }] })`); continue; }
  if (stops.some((s) => s?.stop_id !== stop)) bad.push(`["${stop}"]: every stops[].stop_id must be "${stop}"`);
  const rows = departureRows(body);
  const realtime = rows.filter(isRealtime).length;
  if (realtime < 1) bad.push(`["${stop}"]: no realtime row among ${rows.length} (want >= 1 with schedule_relationship other than STATIC and estimated_utc set)`);
  const foreign = rows.map((r) => r.trip?.trip_id).filter((t) => !(typeof t === "string" && facts.serving.get(stop).has(t)));
  if (foreign.length > 0) bad.push(`["${stop}"]: ${foreign.length} row(s) whose trip.trip_id is not a schedule.db trip serving stop ${stop} (e.g. ${JSON.stringify(foreign[0])}) — use REAL trip_ids from the public GTFS`);
  seen.push(`${stop}: ${realtime} of ${rows.length} rows realtime`);
}
if (bad.length > 0) fail(`${file} is not a realistic synthetic departures fixture: ` + bad.join("; "));
console.log(`ratchet: ${file}: ${seen.join("; ")}; every row on a real trip serving its platform`);
'

# Gate 6: the fixture STARTS with a comment that says it is synthetic, names its generator, says it comes
# from the public GTFS, and why (the public-repo data rule).
HEADER_JS='
const fs = require("node:fs");
const file = process.argv[1];
const fail = (m) => { console.log(`ratchet: ${file}: ${m}`); process.exit(1); };
const lines = fs.readFileSync(file, "utf8").split("\n");
let i = 0;
while (i < lines.length && lines[i].trim() === "") i++;
if (!/^(\/\/|\/\*)/.test((lines[i] ?? "").trim())) fail("must START with a comment: synthetic, generated from the public GTFS by scripts/fixtures/make-live-fixtures.ts, and why (the public-repo data rule)");
const block = [];
let open = false;
for (; i < lines.length && i < 200; i++) {
  const t = lines[i].trim();
  if (open) { block.push(t); open = !t.includes("*/"); continue; }
  if (t.startsWith("//")) { block.push(t); continue; }
  if (t.startsWith("/*")) { block.push(t); open = !t.slice(2).includes("*/"); continue; }
  if (t !== "") break;
}
const text = block.join(" ");
const want = [
  [/\bsynthetic\b/i, "the word \"synthetic\""],
  [/scripts\/fixtures\/make-live-fixtures\.ts/, "its generator, scripts/fixtures/make-live-fixtures.ts"],
  [/\bpublic\b.{0,40}\bGTFS\b/i, "its source, the public GTFS (\"public … GTFS\")"],
  [/public-repo data rule/i, "why: the public-repo data rule"],
];
const missing = want.filter(([re]) => !re.test(text)).map(([, what]) => what);
if (missing.length > 0) fail("its leading comment does not state " + missing.join("; "));
console.log(`ratchet: ${file}: leading comment states synthetic, generator, public GTFS source and the public-repo data rule`);
'

# Gate 15: the probe printed ONE JSON line, and it meets every M8.2a acceptance value.
PROBE_JSON_JS='
const fs = require("node:fs");
const fail = (m) => { console.log("ratchet: " + m); process.exit(1); };
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim() !== "");
if (lines.length !== 1) fail(`the probe must print exactly ONE line on stdout, a JSON object (logs go to stderr); it printed ${lines.length}`);
let j;
try { j = JSON.parse(lines[0]); } catch (e) { fail("the probe stdout line is not JSON: " + e.message); }
console.log("probe: " + lines[0]);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const bad = [];
if (j.status !== 200) bad.push(`status ${j.status} (want 200; 401 = the key was refused)`);
if (!(Number.isInteger(j.railMover) && j.railMover > 0)) bad.push(`railMover ${j.railMover} (want an integer > 0; falsifier R7)`);
if (!(num(j.matchRate) && j.matchRate >= 0.8 && j.matchRate <= 1)) bad.push(`matchRate ${j.matchRate} (want 0.8..1; falsifier R8)`);
if (!(num(j.feedAgeS) && j.feedAgeS > -60 && j.feedAgeS <= 180)) bad.push(`feedAgeS ${j.feedAgeS} (want <= 180 s)`);
if (!(Number.isInteger(j.bytesPerPoll) && j.bytesPerPoll > 0 && j.bytesPerPoll <= 300000)) bad.push(`bytesPerPoll ${j.bytesPerPoll} (want 1..300000; falsifier R19)`);
if (j.oracleMatch !== true) bad.push(`oracleMatch ${j.oracleMatch} (want true: our decoder == gtfs-realtime-bindings on the live bytes; falsifier R5)`);
for (const stop of ["9512", "9513"]) {
  const d = j.departures?.[stop];
  if (!(d && Number.isInteger(d.rows) && Number.isInteger(d.realtime) && d.realtime >= 1 && d.realtime <= d.rows))
    bad.push(`departures["${stop}"] = ${JSON.stringify(d)} (want {rows, realtime} with 1 <= realtime <= rows)`);
}
if (bad.length > 0) fail("probe acceptance (plan M8.2a): " + bad.join("; "));
console.log(`ratchet: probe acceptance holds (railMover ${j.railMover}, matchRate ${j.matchRate}, feedAgeS ${j.feedAgeS}, bytesPerPoll ${j.bytesPerPoll}, GC realtime ${j.departures["9512"].realtime}/${j.departures["9513"].realtime})`);
'

# Gate 16: the probe's numbers are real — re-derived by the gate from the bytes the probe saved this run.
CAPTURES_JS='
const [outFile, startMs] = process.argv.slice(1);
const line = fs.readFileSync(outFile, "utf8").split("\n").find((l) => l.trim() !== "") ?? "";
let j;
try { j = JSON.parse(line); } catch (e) { fail("the probe stdout is not a JSON line (gate 15 owns its format): " + e.message); }
const caps = [".cache/live/vehicle_positions.pb", ".cache/live/departures-9512.json", ".cache/live/departures-9513.json"];
for (const p of caps) {
  if (!fs.existsSync(p)) fail(`the probe did not save ${p} (M8.2a: each run saves its captures to .cache/live/)`);
  if (fs.statSync(p).mtimeMs < Number(startMs)) fail(`${p} predates this run — the probe must save the capture of every run`);
}
const bytes = fs.readFileSync(caps[0]);
const oracle = oracleDecode(bytes);
const s = census(oracle, scheduleTripIds());
const ageAtSave = fs.statSync(caps[0]).mtimeMs / 1000 - s.ts;
const bad = [];
if (j.bytesPerPoll !== bytes.length) bad.push(`bytesPerPoll ${j.bytesPerPoll} but ${bytes.length} bytes were saved`);
if (!(Math.abs(ageAtSave - j.feedAgeS) <= 30)) bad.push(`feedAgeS ${j.feedAgeS} disagrees with the saved header (${ageAtSave.toFixed(0)} s old when saved)`);
if (!(Number.isInteger(j.railMover) && j.railMover >= 1 && j.railMover <= s.inScope)) bad.push(`railMover ${j.railMover} vs ${s.inScope} rail+Mover vehicles in the saved bytes`);
if (!(s.matchRate !== null && s.matchRate >= 0.8)) bad.push(`R8 — the saved rail+Mover trip_ids match schedule.db ${s.matched}/${s.keyed} (want >= 0.8)`);
const disagree = await decoderDisagreement(bytes, oracle);
if (disagree !== null) bad.push("R5 — our decoder disagrees with the oracle on the live bytes: " + disagree);
for (const stop of GC_STOPS) {
  const p = `.cache/live/departures-${stop}.json`;
  let body;
  try { body = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { bad.push(`${p} is not JSON: ${e.message}`); continue; }
  if (!JSON.stringify(body).includes(`"stop_id":"${stop}"`)) bad.push(`${p} is not the response for stop_id ${stop}`);
  const c = countRows(body);
  const claimed = j.departures?.[stop]?.realtime;
  if (c.realtime < 1) bad.push(`${p} has no realtime row (${c.rows} rows)`);
  if (!(Number.isInteger(claimed) && claimed <= c.rows)) bad.push(`departures.${stop}.realtime ${claimed} exceeds the ${c.rows} rows saved`);
}
if (bad.length > 0) fail("the probe report does not match its own captures: " + bad.join("; "));
console.log(`ratchet: captures agree — ${bytes.length} bytes, ${s.inScope} rail+Mover vehicles, trip match ${s.matched}/${s.keyed}, feed ${ageAtSave.toFixed(0)} s old at save, our decoder == oracle`);
'

# GITPOP_JS (after KEY_JS or ANALYZE_JS, which define fs and require) defines gitPopulation(): every
# committable working-tree file (tracked, or untracked and not ignored) and every blob reachable from
# any ref or the index — a file committed and later deleted still sits in history and gets pushed — as
# { items: [{ label, bytes }], files, skipped, blobs, blobBytes }.
GITPOP_JS='
function gitRun(args, input) {
  const r = require("node:child_process").spawnSync("git", args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.log("ratchet: git " + args.join(" ") + " failed: " + String(r.stderr).trim()); process.exit(1); }
  return r.stdout;
}
function gitPopulation() {
  const items = [];
  const files = [...new Set(gitRun(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8").split("\0").filter(Boolean))];
  let scanned = 0, skipped = 0;
  for (const f of files) {
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) { skipped++; continue; }
    scanned++;
    items.push({ label: f, bytes: fs.readFileSync(f) });
  }
  const where = new Map();
  for (const l of gitRun(["rev-list", "--all", "--objects"]).toString("utf8").split("\n")) {
    const i = l.indexOf(" ");
    const sha = i < 0 ? l : l.slice(0, i);
    if (sha !== "") where.set(sha, i < 0 ? "" : l.slice(i + 1));
  }
  for (const l of gitRun(["ls-files", "-s"]).toString("utf8").split("\n")) {
    const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/.exec(l);
    if (m && !where.has(m[1])) where.set(m[1], m[2] + " (index)");
  }
  const blobs = gitRun(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [...where.keys()].join("\n") + "\n")
    .toString("utf8").split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]);
  const out = gitRun(["cat-file", "--batch"], blobs.join("\n") + "\n");
  let off = 0, blobBytes = 0;
  for (let i = 0; i < blobs.length; i++) {
    const nl = out.indexOf(10, off);
    const size = Number(out.subarray(off, nl).toString("latin1").split(" ")[2]);
    if (!(nl > off && Number.isInteger(size))) { console.log("ratchet: could not parse git cat-file --batch output"); process.exit(1); }
    items.push({ label: `git object ${blobs[i]} (${where.get(blobs[i]) || "?"})`, bytes: out.subarray(nl + 1, nl + 1 + size) });
    blobBytes += size;
    off = nl + 1 + size + 1;
  }
  return { items, files: scanned, skipped, blobs: blobs.length, blobBytes };
}
'

# Gate 14: the key value is in no committable working-tree file and in no reachable git object.
KEYSCAN_JS='
const needle = Buffer.from(loadKey(), "utf8");
const pop = gitPopulation();
const hits = pop.items.filter((it) => it.bytes.includes(needle)).map((it) => (it.label === ".env" ? ".env (it is NOT gitignored)" : it.label));
if (hits.length > 0) {
  console.log("ratchet: the TRANSITLAND_API_KEY value is in: " + hits.join(", ") + " — remove it, and rewrite any commit that carries it, before anything is pushed");
  process.exit(1);
}
console.log(`ratchet: key absent from ${pop.files} committable working-tree files (${pop.skipped} non-files skipped) and ${pop.blobs} git blobs (${(pop.blobBytes / 1048576).toFixed(1)} MB: all refs + index)`);
'

# Gate 17: no byte of this run's REAL captures is committable (PUBLIC-REPO DATA RULE).
# - vehicle_positions.pb: no committable file, reachable git blob or synthetic export shares ANY 64-byte
#   window with it (Rabin-Karp over every offset), read raw AND as the bytes spelled in text (integer
#   lists like a Uint8Array literal, base64 runs, hex runs).
# - departures JSON: a structure-faithful synthetic legitimately shares key runs with the real response,
#   so raw windows would flag a correct fixture. The realtime CONTENT is fingerprinted instead: each
#   realtime row as (trip_id, estimated_utc), keeping rows whose estimate differs from the schedule when
#   any do. A text holding >= min(2, all) fingerprints (estimate with its trip_id within 1 KB) is a copy.
LEAK_JS='
const [fxVp, fxDep] = process.argv.slice(1);
const W = 64;
const B = 0x01000193;
let TOP = 1;
for (let i = 0; i < W - 1; i++) TOP = Math.imul(TOP, B) >>> 0;
const seed = (buf) => { let h = 0; for (let i = 0; i < W; i++) h = (Math.imul(h, B) + buf[i]) >>> 0; return h; };
const roll = (h, out, inn) => (Math.imul((h - Math.imul(out, TOP)) >>> 0, B) + inn) >>> 0;
const isText = (buf) => !buf.subarray(0, 8192).includes(0);
function windowIndex(cap) {
  const idx = new Map();
  let h = seed(cap);
  for (let i = 0; ; i++) {
    const l = idx.get(h);
    if (l) l.push(i); else idx.set(h, [i]);
    if (i + W >= cap.length) return idx;
    h = roll(h, cap[i], cap[i + W]);
  }
}
function sharedAt(hay, cap, idx) {
  if (hay.length < W) return -1;
  let h = seed(hay);
  for (let i = 0; ; i++) {
    const l = idx.get(h);
    if (l) for (const o of l) if (hay.compare(cap, o, o + W, i, i + W) === 0) return i;
    if (i + W >= hay.length) return -1;
    h = roll(h, hay[i], hay[i + W]);
  }
}
function byteViews(bytes) {
  const views = [["raw", bytes]];
  if (!isText(bytes)) return views;
  const text = bytes.toString("latin1");
  for (const m of text.matchAll(/(?:(?:0x[0-9a-f]{1,2}|\d{1,3})\s*,\s*){63,}(?:0x[0-9a-f]{1,2}|\d{1,3})/gi)) {
    let seg = [];
    const flush = () => { if (seg.length >= W) views.push(["integer-list", Buffer.from(seg)]); seg = []; };
    for (const t of m[0].split(",")) { const n = Number(t.trim()); if (Number.isInteger(n) && n >= 0 && n <= 255) seg.push(n); else flush(); }
    flush();
  }
  for (const m of text.matchAll(/[A-Za-z0-9+\/]{86,}={0,2}/g)) views.push(["base64", Buffer.from(m[0], "base64")]);
  for (const m of text.matchAll(/[0-9a-fA-F]{128,}/g)) views.push(["hex", Buffer.from(m[0].length % 2 === 0 ? m[0] : m[0].slice(1), "hex")]);
  return views;
}
function fingerprints(body) {
  const all = departureRows(body).filter(isRealtime).map((r) => {
    const ev = estimateOf(r);
    const sched = ev.scheduled_utc ?? ev.scheduled_local ?? ev.scheduled;
    return { trip: String(r.trip?.trip_id ?? ""), est: ev.estimated_utc, moved: Date.parse(ev.estimated_utc) !== Date.parse(String(sched)) };
  }).filter((f) => f.trip !== "");
  const moved = all.filter((f) => f.moved);
  return moved.length > 0 ? moved : all;
}
function nearby(text, est, trip) {
  for (let i = text.indexOf(est), n = 0; i >= 0 && n < 10000; i = text.indexOf(est, i + 1), n++)
    if (text.slice(Math.max(0, i - 1024), i + est.length + 1024).includes(trip)) return true;
  return false;
}
const cap = fs.readFileSync(".cache/live/vehicle_positions.pb");
if (cap.length < W) fail(`.cache/live/vehicle_positions.pb is only ${cap.length} bytes`);
const idx = windowIndex(cap);
const prints = [];
for (const stop of GC_STOPS) {
  const p = `.cache/live/departures-${stop}.json`;
  let body;
  try { body = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { fail(`${p} is not JSON: ${e.message}`); }
  prints.push(...fingerprints(body));
}
if (prints.length === 0) fail("the departures captures of this run hold no realtime row with a trip_id — nothing to fingerprint, so a pass would prove nothing (re-run in service hours)");
const need = Math.min(2, prints.length);
const vp = (await tsModule(fxVp)).SYNTHETIC_VEHICLE_POSITIONS_BYTES;
const dep = (await tsModule(fxDep)).SYNTHETIC_DEPARTURES;
if (!(vp instanceof Uint8Array)) fail(`${fxVp} must export SYNTHETIC_VEHICLE_POSITIONS_BYTES: a Uint8Array`);
const pop = gitPopulation();
pop.items.push({ label: `${fxVp} (its exported SYNTHETIC_VEHICLE_POSITIONS_BYTES)`, bytes: Buffer.from(vp.buffer, vp.byteOffset, vp.byteLength) });
pop.items.push({ label: `${fxDep} (its exported SYNTHETIC_DEPARTURES)`, bytes: Buffer.from(JSON.stringify(dep ?? null), "utf8") });
const hits = [];
let views = 0;
for (const it of pop.items) {
  for (const [kind, buf] of byteViews(it.bytes)) {
    views++;
    const at = sharedAt(buf, cap, idx);
    if (at >= 0) { hits.push(`${it.label}: a 64-byte window of the captured vehicle_positions.pb (${kind} view, offset ${at})`); break; }
  }
  if (isText(it.bytes)) {
    const text = it.bytes.toString("latin1");
    const found = prints.filter((f) => nearby(text, f.est, f.trip)).length;
    if (found >= need) hits.push(`${it.label}: ${found} of the ${prints.length} realtime departure fingerprints (trip_id + estimated_utc) of the captures of this run`);
  }
}
if (hits.length > 0) fail("REAL capture content is committable (PUBLIC-REPO DATA RULE: it must stay in the gitignored .cache/live/) — " + hits.slice(0, 10).join("; ") + " — remove it, and rewrite any commit that carries it, before anything is pushed");
console.log(`ratchet: captures private — no 64-byte window of the ${cap.length}-byte vehicle_positions.pb captured this run in ${pop.files} committable files, ${pop.blobs} git blobs or the 2 synthetic exports (${views} raw/integer-list/base64/hex views), and none of its ${prints.length} realtime departure fingerprints committed`);
'

# Gate 18: the checker's ONE JSON line says conformant, and the gate's own reading agrees: every field
# path + enum value of this run's real vehicle_positions.pb, and every key path + schedule_relationship
# value of its two departures responses (union), occurs in the synthetic fixtures.
STRUCTURE_JS='
const [outFile, rcText, fxVp, fxDep] = process.argv.slice(1);
const rc = Number(rcText);
const vp = (await tsModule(fxVp)).SYNTHETIC_VEHICLE_POSITIONS_BYTES;
if (!(vp instanceof Uint8Array)) fail(`${fxVp} must export SYNTHETIC_VEHICLE_POSITIONS_BYTES: a Uint8Array`);
const syn = (await tsModule(fxDep)).SYNTHETIC_DEPARTURES;
const realVp = pbShape(fs.readFileSync(".cache/live/vehicle_positions.pb"));
const synVp = pbShape(vp);
const realDep = new Set();
const synDep = new Set();
for (const stop of GC_STOPS) {
  const p = `.cache/live/departures-${stop}.json`;
  let body;
  try { body = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { fail(`${p} is not JSON: ${e.message}`); }
  if (syn?.[stop] == null) fail(`${fxDep}: SYNTHETIC_DEPARTURES has no "${stop}" response`);
  for (const x of jsonShape(body)) realDep.add(x);
  for (const x of jsonShape(syn[stop])) synDep.add(x);
}
const missing = [
  ...[...realVp].filter((x) => !synVp.has(x)).map((x) => "vehicle_positions " + x),
  ...[...realDep].filter((x) => !synDep.has(x)).map((x) => "departures " + x),
].sort();
const lines = fs.readFileSync(outFile, "utf8").split("\n").filter((l) => l.trim() !== "");
let j = null;
let why = lines.length === 1 ? "" : `it printed ${lines.length} stdout lines, not ONE`;
if (lines.length === 1) { try { j = JSON.parse(lines[0]); } catch (e) { why = "its stdout line is not JSON: " + e.message; } }
if (j !== null && (typeof j.conformant !== "boolean" || !Array.isArray(j.missing))) why = "its JSON line lacks \"conformant\" (boolean) and \"missing\" (array)";
const said = why === "" ? `the checker said conformant=${j.conformant} (exit ${rc})` : `the checker is unusable: ${why}`;
if (missing.length > 0) fail(`the synthetic fixtures do not cover the structure of the real captures of this run — the gate itself finds ${missing.length} path(s)/enum value(s) missing (${said}): ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? ", …" : ""}`);
if (why !== "") fail(`scripts/live/check-fixture-structure.ts must print exactly ONE stdout line, a JSON object with "conformant" and "missing" — ${why}`);
console.log("structure: " + (lines[0].length > 300 ? lines[0].slice(0, 300) + " …" : lines[0]));
if (j.conformant !== true || j.missing.length !== 0 || rc !== 0) fail(`the checker reports conformant=${j.conformant}, ${j.missing.length} missing, exit ${rc}; but the gate itself finds every real path and enum value covered — the checker is wrong`);
console.log(`ratchet: structure conformant — the synthetic fixtures cover all ${realVp.size} field paths + enum values of the vehicle_positions.pb captured this run and all ${realDep.size} key paths + schedule_relationship values of its departures; the checker agrees`);
'

gate_data_rule_tree() {
  local files real
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  git ls-files --error-unmatch -- "$FX_VP" "$FX_DEP" >/dev/null 2>&1 \
    || { echo "ratchet: $FX_VP and $FX_DEP must be tracked (git add them) — they are the committed live fixtures"; return 1; }
  files=$(git ls-files --cached --others --exclude-standard) || { echo "ratchet: git ls-files failed"; return 1; }
  real=$(printf '%s\n' "$files" | awk -F/ '$NF == "real-vehicle-positions.ts" || $NF == "real-departures.ts"')
  [ -z "$real" ] \
    || { printf '%s\n' "$real"; echo "ratchet: real-capture fixtures are tracked or committable — PUBLIC-REPO DATA RULE: real realtime data is never committed; delete them (the committed live fixtures are the synthetic ones)"; return 1; }
  captures_ignored || return 1
  echo "ratchet: the synthetic fixtures are the tracked live fixtures; no real-capture fixture is committable; .cache/live captures are gitignored and untracked"
}

gate_fixture_headers() {
  local f
  for f in "$FX_VP" "$FX_DEP" src/domain/live/__fixtures__/transitland-departures.fixture.ts; do
    need_file "$f" || return 1
    if grep -qi apikey "$f"; then
      grep -nio -m 5 apikey "$f"   # -o prints only the word, never a value next to it
      echo "ratchet: $f mentions 'apikey' — a fixture carries no key, no apikey param, not even in a comment"; return 1
    fi
    node -e "$HEADER_JS" "$f" || return 1
  done
}

# One generator run with the clock frozen at <label>/<epoch ms>, Math.random frozen at <value>, and the
# network off; then the tracked fixtures must be byte-identical (git diff, worktree vs index).
_m8a_regen() {
  local rc=0
  node --import "$(frozen_clock "$2" "$3")" --import "$NET_OFF" --import tsx "$GEN" >"$WORK/gen.out" 2>"$WORK/gen.err" || rc=$?
  [ "$rc" -eq 0 ] \
    || { tail -15 "$WORK/gen.err"; tail -3 "$WORK/gen.out"; echo "ratchet: $GEN exited $rc (clock frozen at $1, network off)"; return 1; }
  if grep -qF "ratchet-net:" "$WORK/gen.err"; then
    grep -m 3 -F "ratchet-net:" "$WORK/gen.err"
    echo "ratchet: $GEN reached for the network — the fixtures are generated from assets/db/schedule.db alone"; return 1
  fi
  git diff --exit-code --stat -- "$FX_VP" "$FX_DEP" \
    || { echo "ratchet: regenerating with the clock frozen at $1 (Math.random frozen at $3) changed the tracked fixtures — the generator must be deterministic (fixed timestamps, seeded randomness) and its committed output current"; return 1; }
}

gate_generator_deterministic() {
  local before after
  need_file "$GEN" || return 1
  need_re "schedule\.db" "$GEN" || return 1
  absent "['\"\`][^'\"\`]*\.cache" "$GEN" || return 1
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  git ls-files --error-unmatch -- "$FX_VP" "$FX_DEP" >/dev/null 2>&1 \
    || { echo "ratchet: $FX_VP and $FX_DEP must be tracked (git add them) — regenerated bytes are compared with the tracked ones"; return 1; }
  git diff --quiet -- "$FX_VP" "$FX_DEP" \
    || { git diff --stat -- "$FX_VP" "$FX_DEP"; echo "ratchet: the fixtures differ from what is staged — git add the generator's output (never hand-edit it) before verify regenerates it"; return 1; }
  local_bin tsx --version >/dev/null || return 1
  before=$(git status --porcelain=v1 --untracked-files=all) || { echo "ratchet: git status failed"; return 1; }
  # On failure the two fixtures go back to their staged bytes (the check above proved the worktree held
  # exactly those), so a red run leaves no regenerated file behind to confuse the next one.
  _m8a_regen 2001-01-01 978307200000 0.125 \
    || { git checkout -q -- "$FX_VP" "$FX_DEP"; echo "ratchet: (both fixtures restored from the index; run $GEN yourself to see the diff)"; return 1; }
  _m8a_regen 2031-06-15 1939334400000 0.875 \
    || { git checkout -q -- "$FX_VP" "$FX_DEP"; echo "ratchet: (both fixtures restored from the index; run $GEN yourself to see the diff)"; return 1; }
  after=$(git status --porcelain=v1 --untracked-files=all) || { echo "ratchet: git status failed"; return 1; }
  [ "$before" = "$after" ] \
    || { printf '%s\n' "$after" | head -10; echo "ratchet: $GEN changed files beyond its two fixtures (git status moved)"; return 1; }
  echo "ratchet: $GEN regenerated both fixtures byte-identically twice (clock frozen at 2001 and 2031, Math.random frozen, network off)"
}

gate_fixture_ts() {   # gate_fixture_ts <fixture> <JS> — run the gate's own reader on a committed fixture module
  need_file "$1" || return 1
  local_bin tsx --version >/dev/null || return 1
  node --import tsx --input-type=module -e "$ANALYZE_JS$2" "$1"
}

gate_key_nowhere() {
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  git ls-files --error-unmatch -- "$FX_VP" "$FX_DEP" >/dev/null 2>&1 \
    || { echo "ratchet: $FX_VP and $FX_DEP must be tracked (git add them) so the key scan covers them"; return 1; }
  node -e "$KEY_JS$GITPOP_JS$KEYSCAN_JS"
}

gate_probe_json() {
  probe_run || return 1
  node -e "$PROBE_JSON_JS" "$WORK/probe.out"
}

gate_probe_captures() {
  probe_run || return 1
  scrubbed "$CAP_VP" "$CAP_DEP_9512" "$CAP_DEP_9513" || return 1
  node --import tsx --input-type=module -e "$ANALYZE_JS$CAPTURES_JS" "$WORK/probe.out" "$PROBE_START_MS"
}

gate_captures_private() {
  local before after
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  before=$(git status --porcelain=v1 --untracked-files=all) || { echo "ratchet: git status failed"; return 1; }
  probe_run || return 1
  after=$(git status --porcelain=v1 --untracked-files=all) || { echo "ratchet: git status failed"; return 1; }
  [ "$before" = "$after" ] \
    || { printf '%s\n' "$after" | head -10; echo "ratchet: the probe wrote outside the gitignored .cache/ (git status moved) — real captures go ONLY to .cache/live/"; return 1; }
  captures_ignored || return 1
  scrubbed "$CAP_VP" "$CAP_DEP_9512" "$CAP_DEP_9513" || return 1
  node --import tsx --input-type=module -e "$ANALYZE_JS$GITPOP_JS$LEAK_JS" "$FX_VP" "$FX_DEP"
}

gate_structure_conformance() {
  local rc=0
  need_file "$CHECKER" || return 1
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  probe_run || return 1
  scrubbed "$CAP_VP" "$CAP_DEP_9512" "$CAP_DEP_9513" || return 1
  node --import "$NET_OFF" --import tsx "$CHECKER" >"$WORK/structure.out" 2>"$WORK/structure.err" || rc=$?
  scrubbed "$WORK/structure.out" "$WORK/structure.err" || return 1
  if grep -qF "ratchet-net:" "$WORK/structure.err"; then
    grep -m 3 -F "ratchet-net:" "$WORK/structure.err"
    echo "ratchet: $CHECKER reached for the network — it compares local files only"; return 1
  fi
  [ "$rc" -eq 0 ] || tail -5 "$WORK/structure.err"
  node --import tsx --input-type=module -e "$ANALYZE_JS$STRUCTURE_JS" "$WORK/structure.out" "$rc" "$FX_VP" "$FX_DEP"
}

gate_plan_guard_tree() {
  local rc=0
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  git ls-files --error-unmatch -- "$FX_VP" "$FX_DEP" >/dev/null 2>&1 \
    || { echo "ratchet: $FX_VP and $FX_DEP must be tracked (git add them) so --tree scans them"; return 1; }
  need_file scripts/check/embedded-keys.ts || return 1
  local_bin tsx --version >/dev/null || return 1
  env_key_ready || return 1
  ios_export || return 1
  node --env-file=.env --import tsx scripts/check/embedded-keys.ts --tree >"$WORK/guard.out" 2>&1 || rc=$?
  scrubbed "$WORK/guard.out" || return 1
  [ "$rc" -eq 0 ] || { tail -15 "$WORK/guard.out"; echo "ratchet: embedded-keys --tree with the real .env is red (plan M8.3 V)"; return 1; }
  grep -qiE "scanned [1-9][0-9]*([^0-9]|$)" "$WORK/guard.out" \
    || { tail -15 "$WORK/guard.out"; echo "ratchet: the guard passed but printed no 'scanned <N> files' report"; return 1; }
  tail -3 "$WORK/guard.out"
}

# 1. M8.2a: the probe exists where the plan puts it.
need_file "$PROBE"
# 2. M8.2a end to end: the probe drives the app's own pipeline — our decoder (src/domain/gtfsrt), the m4a transports and both mappers — and checks the decoder against the oracle (gtfs-realtime-bindings).
need_re "from ['\"](\.\./)+src/domain/gtfsrt/decode-feed(\.ts)?['\"]" "$PROBE"
need_re "from ['\"](\.\./)+src/domain/live/transports(\.ts)?['\"]" "$PROBE"
need_re "from ['\"](\.\./)+src/domain/live/from-gtfsrt(\.ts)?['\"]" "$PROBE"
need_re "from ['\"](\.\./)+src/domain/live/from-transitland-departures(\.ts)?['\"]" "$PROBE"
need_re "from ['\"]gtfs-realtime-bindings['\"]" "$PROBE"
# 3. §3 key + endpoint discipline in scripts/live: the key comes from the environment (TRANSITLAND_API_KEY via --env-file), never in a URL (no ?apikey= / &apikey= / searchParams apikey), and the 1 MB trip_updates.pb is never fetched (the string trip_updates appears nowhere in non-test scripts/live code).
need_re "TRANSITLAND_API_KEY" scripts/live
absent "[?&]apikey=" scripts/live
absent "searchParams\.(set|append)\(['\"]apikey" scripts/live
absent "trip_updates" scripts/live
# 4. M8.2a forced branches (node:test; network off, so fetch is injected; 30 s per-test timeout, so the clock is injected): a 404 retries every 60 s up to 5 times; a 401 stops at once; the key is never in a URL — each case its OWN passing test, nothing failed/skipped/todo/cancelled.
nodetest_cases_offline "$PROBE_TEST" '(^|[^0-9])404([^0-9]|$).*retr.*\b60 ?s\b.*\b5\b' '(^|[^0-9])401([^0-9]|$).*\bstops?\b' 'key never in (the |a )?url'
# 5. PUBLIC-REPO DATA RULE in the tree: the two SYNTHETIC fixtures are the tracked live fixtures; no tracked or committable file is named real-vehicle-positions.ts or real-departures.ts; nothing under .cache/ is tracked; and the probe's capture paths (.cache/live/vehicle_positions.pb, departures-9512.json, departures-9513.json) are gitignored.
gate_data_rule_tree
# 6. Each synthetic fixture STARTS with a comment stating it is synthetic, generated by scripts/fixtures/make-live-fixtures.ts from the public GTFS, and why (the public-repo data rule) — and neither mentions 'apikey'.
gate_fixture_headers
# 7. M8.3 generator: scripts/fixtures/make-live-fixtures.ts reads schedule.db (no .cache path), and regenerating with the clock frozen at 2001 and again at 2031 (Math.random frozen, network off) leaves both tracked fixtures byte-identical (git diff --exit-code) and touches nothing else.
gate_generator_deterministic
# 8. M8.3 (arbiter-tightened: positions <= 1 m ON the shape, entity ids "syn-…"): the synthetic vehicle fixture is a realistic whole-agency feed: >= 50 vehicles; rail 31009, Mover 14456 and 14457 and out-of-scope bus routes; every in-scope trip_id REAL (schedule.db trip table, same route) with its position <= 25 m from that trip's shape; fixed 2026-2030 header timestamp; our decoder == oracle (R5).
gate_fixture_ts "$FX_VP" "$SYN_VP_JS"
# 9. M8.3: the synthetic departures fixture is a Transitland departures response for each of 9512 and 9513, every row on a REAL schedule.db trip serving that platform, each with >= 1 realtime row (schedule_relationship other than STATIC + estimated_utc).
gate_fixture_ts "$FX_DEP" "$SYN_DEP_JS"
# 10. M8.3: the GTFS-RT mapper test imports the synthetic capture and has distinct passing tests for it: rail and Mover vehicles mapped; out-of-scope routes dropped.
need_file "$FX_VP"
need_file src/domain/live/__tests__/from-gtfsrt.test.ts
need "__fixtures__/synthetic-vehicle-positions" src/domain/live/__tests__/from-gtfsrt.test.ts
jest_cases src/domain/live/__tests__/from-gtfsrt.test.ts 'synthetic capture.*rail and mover' 'synthetic capture.*out-of-scope'
# 11. M8.3: the departures mapper test imports the synthetic capture and has distinct passing tests for it: realtime predictions; stop_id mapped to the Government Center stationKey.
need_file "$FX_DEP"
need_file src/domain/live/__tests__/from-transitland-departures.test.ts
need "__fixtures__/synthetic-departures" src/domain/live/__tests__/from-transitland-departures.test.ts
jest_cases src/domain/live/__tests__/from-transitland-departures.test.ts 'synthetic capture.*realtime' 'synthetic capture.*stationkey'
# 12. Plan M8.3 V (first half, `npx jest src/domain --ci`) with the synthetic fixtures in place: non-empty, green, nothing skipped.
for f in "$FX_VP" "$FX_DEP"; do need_file "$f"; done
jest_nonempty src/domain
# 13. The structure checker says NO when it should (node:test, network off): a protobuf field path missing from the synthetic, a JSON key path missing, and an enum value missing are each not conformant; full coverage is conformant — each case its OWN passing test.
nodetest_cases_offline "$CHECKER_TEST" 'protobuf field path.*missing.*not conformant' 'json key path.*missing.*not conformant' 'enum value.*missing.*not conformant' 'all covered.*conformant'
# 14. The literal key from .env (read by node, never echoed) is in no tracked or committable file — the fixtures included — and in no git object reachable from any ref or the index.
gate_key_nowhere
# 15. M8.2a LIVE, in service hours: the plan's V prints ONE JSON line with status 200, railMover > 0, 0.8 <= matchRate <= 1, feedAgeS <= 180, 0 < bytesPerPoll <= 300000, oracleMatch true, and Government Center 9512 and 9513 each with >= 1 realtime departure; it exits 0 and never prints the key.
gate_probe_json
# 16. M8.2a LIVE, in service hours: the numbers are real — the gate re-derives them from this run's .cache/live captures (bytesPerPoll = bytes saved, feedAgeS from the saved header, railMover <= rail+Mover vehicles present, trip_id match >= 0.8 against schedule.db, our decoder == oracle, both departures files realtime), and the captures hold no key.
gate_probe_captures
# 17. PUBLIC-REPO DATA RULE, LIVE: the probe writes nothing committable (git status unchanged), its captures are gitignored and untracked, and no committable file, reachable git blob or synthetic export holds a 64-byte window of this run's vehicle_positions.pb (raw, integer-list, base64 or hex) or its realtime departure fingerprints.
gate_captures_private
# 18. M8.3 STRUCTURE CONFORMANCE, LIVE: scripts/live/check-fixture-structure.ts prints ONE JSON line reporting conformant (exit 0), and the gate's own reading agrees — the synthetic fixtures cover every protobuf field path + enum value of this run's real vehicle_positions.pb and every JSON key path + schedule_relationship value of its departures.
gate_structure_conformance
# 19. Plan M8.3 V (second half): with the synthetic fixtures tracked, the m4b embedded-key guard --tree passes with the real .env after a fresh iOS export, and its output holds no key.
gate_plan_guard_tree
# 20. Repo-wide gate over this card's files (tsc incl. scripts/live and scripts/fixtures, eslint, standards, jest, node:test).
for f in "$PROBE" "$PROBE_TEST" "$CHECKER" "$CHECKER_TEST" "$GEN" "$FX_VP" "$FX_DEP"; do need_file "$f"; done
full_gate
