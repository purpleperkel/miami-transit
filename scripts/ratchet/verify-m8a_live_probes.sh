#!/usr/bin/env bash
# m8a_live_probes — realtime proven end to end on the Mac: the Transitland probe on the LIVE API with the real key (plan M8.2a) and sanitized captured fixtures that the mapper tests run on (plan M8.3).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Every numbered gate runs ALONE after `source lib.sh` + this prelude (constants + card helpers): no gate
# reads a variable or a file that another gate created.
#
# SERVICE HOURS. Gates 12-13 call the LIVE API. They run only 06:00-23:00 America/New_York, a margin
# inside Metrorail/Metromover service (~05:00-24:00); outside it they FAIL with "outside service hours —
# re-run", because an empty night-time feed would prove nothing.
#
# KEY HYGIENE. The real TRANSITLAND_API_KEY is read only by node: from .env here, or by the probe and
# the guard through --env-file. bash never holds it and nothing echoes it. Whatever a key-holding
# process writes goes through `scrubbed` before it is shown; a printed key is redacted in place and
# fails the gate.

PROBE=scripts/live/probe-transitland.ts
PROBE_TEST=scripts/live/__tests__/probe-transitland.test.ts
FX_VP=src/domain/live/__fixtures__/real-vehicle-positions.ts   # export REAL_VEHICLE_POSITIONS_BYTES: Uint8Array
FX_DEP=src/domain/live/__fixtures__/real-departures.ts         # export REAL_DEPARTURES: the parsed response
CAP_VP=.cache/live/vehicle_positions.pb                         # the probe's per-run captures (gitignored)
CAP_DEP_9512=.cache/live/departures-9512.json
CAP_DEP_9513=.cache/live/departures-9513.json
WORK=.cache/ratchet-m8a                                         # gitignored scratch, removed on exit
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# --- card-specific helpers (lib.sh has no regex need, non-test absence check, own-test multi-case pin
#     for jest or node:test, network-off test run, key reader/scrubber, service-hours check or probe
#     harness; everything else comes from lib.sh) --

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
    grep -rnE --exclude-dir=__tests__ -- "$re" "$@" | head -5
    echo "ratchet: forbidden /$re/ in non-test code under $*"; return 1
  fi
}

# Named-case checker shared by jest_cases (gates 8, 9) and nodetest_cases_offline (gate 4). Each pattern is
# a case-insensitive JS regex on a test's FULL name (describe/suite titles + test title) and must name >= 1
# PASSED test of its OWN: one whose full name matches no other pattern of the same gate, so a single
# catch-all test cannot stand in for several acceptance cases. Keep case keywords out of describe/suite
# titles (a suite title is part of every full name beneath it).
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
  out=$(node --import "$NET_OFF" --import tsx --test --test-timeout=30000 --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file (a timed-out test = the real clock; inject it)"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  if grep -qF "ratchet-net:" <<<"$out"; then
    grep -F "ratchet-net:" <<<"$out" | head -5
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

# ANALYZE_JS (ESM; run with --import tsx): the gate's OWN reading of GTFS-realtime bytes and departures
# JSON, independent of the code under test: the reference bindings as oracle, schedule.db for trip_ids.
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

function oracleDecode(bytes) {
  const rt = require("gtfs-realtime-bindings").transit_realtime;
  try { return rt.FeedMessage.toObject(rt.FeedMessage.decode(bytes), { longs: Number }); }
  catch (e) { fail("the oracle (gtfs-realtime-bindings) cannot decode the bytes as a FeedMessage: " + e.message); }
}

// R5 on real bytes: our decoder and the oracle agree on every entity (id, trip, route, vehicle, position, timestamp).
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
// recursion): a row is an object carrying schedule_relationship; it is REALTIME iff that is a string
// other than "STATIC" and estimated_utc is set on it or on its arrival/departure (plan M4.3b).
function departureRows(body) {
  const stack = [body];
  let rows = 0, realtime = 0, steps = 0;
  while (stack.length > 0) {
    if (++steps > 1000000) fail("departures JSON walk exceeded 1e6 nodes");
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (!Array.isArray(v) && Object.hasOwn(v, "schedule_relationship")) {
      rows++;
      const est = [v, v.arrival, v.departure].some((o) => o !== null && typeof o === "object" && o.estimated_utc != null && o.estimated_utc !== "");
      if (typeof v.schedule_relationship === "string" && v.schedule_relationship !== "STATIC" && est) realtime++;
    }
    for (const x of Object.values(v)) stack.push(x);
  }
  return { rows, realtime };
}
'

# Gate 6: the committed vehicle fixture is a real whole-agency capture that our decoder reads like the oracle.
# (No schedule.db join here: a later GTFS rollover renames trip_ids, and the fixture must not time-bomb.)
FIXTURE_VP_JS='
const file = process.argv[1];
const bytes = (await tsModule(file)).REAL_VEHICLE_POSITIONS_BYTES;
if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail(`${file} must export REAL_VEHICLE_POSITIONS_BYTES: a non-empty Uint8Array of the captured vehicle_positions.pb bytes`);
const oracle = oracleDecode(bytes);
const s = census(oracle, null);
const since = Date.UTC(2026, 9, 1, 4) / 1000; // 2026-10-01 00:00 America/New_York
const bad = [];
if (s.version === "") bad.push("no header.gtfs_realtime_version");
if (!(s.ts >= since && s.ts <= Date.now() / 1000 + 300)) bad.push(`header.timestamp ${s.ts} is not a capture time (2026-10-01 ET .. now)`);
if (s.vehicles < 50) bad.push(`only ${s.vehicles} vehicles — a whole-agency capture has hundreds; commit the bytes exactly as fetched`);
if (s.rail < 1) bad.push("no Metrorail (route 31009) vehicle");
if (s.mover < 1) bad.push("no Metromover (route 14456/14457) vehicle — recapture while the Mover reports");
if (s.outOfScope < 1) bad.push("no out-of-scope (bus) vehicle, so the mapper route filter is never exercised on real data");
const disagree = await decoderDisagreement(bytes, oracle);
if (disagree !== null) bad.push("R5 — our decoder disagrees with the oracle: " + disagree);
if (bad.length > 0) fail(`${file} is not a usable real capture: ` + bad.join("; "));
console.log(`ratchet: ${file}: ${bytes.length} bytes captured ${new Date(s.ts * 1000).toISOString()}; ${s.vehicles} vehicles (${s.rail} rail, ${s.mover} mover, ${s.outOfScope} out of scope); our decoder == oracle`);
'

# Gate 7: the committed departures fixture is a real Government Center capture with >= 1 realtime row.
FIXTURE_DEP_JS='
const file = process.argv[1];
const body = (await tsModule(file)).REAL_DEPARTURES;
if (body === null || typeof body !== "object") fail(`${file} must export REAL_DEPARTURES: the captured departures response (parsed JSON)`);
const text = JSON.stringify(body);
if (!text.includes("\"departures\":[")) fail(`${file}: no "departures" array — not a Transitland departures response`);
if (!/"stop_id":"951[23]"/.test(text)) fail(`${file}: not a Government Center rail platform capture (no "stop_id":"9512" or "9513")`);
const c = departureRows(body);
if (c.realtime < 1) fail(`${file}: no realtime row among ${c.rows} (realtime = schedule_relationship other than STATIC with estimated_utc set) — capture during service hours`);
console.log(`ratchet: ${file}: Government Center capture, ${c.realtime} of ${c.rows} rows realtime`);
'

# Gate 12: the probe printed ONE JSON line, and it meets every M8.2a acceptance value.
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

# Gate 13: the probe's numbers are real — re-derived by the gate from the bytes the probe saved this run.
CAPTURES_JS='
const [outFile, startMs] = process.argv.slice(1);
const line = fs.readFileSync(outFile, "utf8").split("\n").find((l) => l.trim() !== "") ?? "";
let j;
try { j = JSON.parse(line); } catch (e) { fail("the probe stdout is not a JSON line (gate 12 owns its format): " + e.message); }
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
for (const stop of ["9512", "9513"]) {
  const p = `.cache/live/departures-${stop}.json`;
  let body;
  try { body = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { bad.push(`${p} is not JSON: ${e.message}`); continue; }
  if (!JSON.stringify(body).includes(`"stop_id":"${stop}"`)) bad.push(`${p} is not the response for stop_id ${stop}`);
  const c = departureRows(body);
  const claimed = j.departures?.[stop]?.realtime;
  if (c.realtime < 1) bad.push(`${p} has no realtime row (${c.rows} rows)`);
  if (!(Number.isInteger(claimed) && claimed <= c.rows)) bad.push(`departures.${stop}.realtime ${claimed} exceeds the ${c.rows} rows saved`);
}
if (bad.length > 0) fail("the probe report does not match its own captures: " + bad.join("; "));
console.log(`ratchet: captures agree — ${bytes.length} bytes, ${s.inScope} rail+Mover vehicles, trip match ${s.matched}/${s.keyed}, feed ${ageAtSave.toFixed(0)} s old at save, our decoder == oracle`);
'

# Gate 11: the key value is in no working-tree file git could commit and in no git object reachable from
# any ref or the index (a key committed and later deleted still sits in history and gets pushed).
KEYSCAN_JS='
const { spawnSync } = require("node:child_process");
const needle = Buffer.from(loadKey(), "utf8");
function git(args, input) {
  const r = spawnSync("git", args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.log("ratchet: git " + args.join(" ") + " failed: " + String(r.stderr).trim()); process.exit(1); }
  return r.stdout;
}
const hits = [];
const files = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8").split("\0").filter(Boolean))];
let scanned = 0, skipped = 0;
for (const f of files) {
  const st = fs.lstatSync(f, { throwIfNoEntry: false });
  if (st === undefined || !st.isFile()) { skipped++; continue; }
  scanned++;
  if (fs.readFileSync(f).includes(needle)) hits.push(f === ".env" ? ".env (it is NOT gitignored)" : f);
}
const where = new Map();
for (const l of git(["rev-list", "--all", "--objects"]).toString("utf8").split("\n")) {
  const i = l.indexOf(" ");
  const sha = i < 0 ? l : l.slice(0, i);
  if (sha !== "") where.set(sha, i < 0 ? "" : l.slice(i + 1));
}
for (const l of git(["ls-files", "-s"]).toString("utf8").split("\n")) {
  const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/.exec(l);
  if (m && !where.has(m[1])) where.set(m[1], m[2] + " (index)");
}
const blobs = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [...where.keys()].join("\n") + "\n")
  .toString("utf8").split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]);
const out = git(["cat-file", "--batch"], blobs.join("\n") + "\n");
let off = 0, bytes = 0;
for (let i = 0; i < blobs.length; i++) {
  const nl = out.indexOf(10, off);
  const size = Number(out.subarray(off, nl).toString("latin1").split(" ")[2]);
  if (!(nl > off && Number.isInteger(size))) { console.log("ratchet: could not parse git cat-file --batch output"); process.exit(1); }
  if (out.subarray(nl + 1, nl + 1 + size).includes(needle)) hits.push(`git object ${blobs[i]} (${where.get(blobs[i]) || "?"})`);
  bytes += size;
  off = nl + 1 + size + 1;
}
if (hits.length > 0) {
  console.log("ratchet: the TRANSITLAND_API_KEY value is in: " + hits.join(", ") + " — remove it, and rewrite any commit that carries it, before anything is pushed");
  process.exit(1);
}
console.log(`ratchet: key absent from ${scanned} committable working-tree files (${skipped} non-files skipped) and ${blobs.length} git blobs (${(bytes / 1048576).toFixed(1)} MB: all refs + index)`);
'

gate_fixtures_sanitized() {
  need_file "$FX_VP" || return 1
  need_file "$FX_DEP" || return 1
  git ls-files --error-unmatch -- "$FX_VP" "$FX_DEP" >/dev/null 2>&1 \
    || { echo "ratchet: $FX_VP and $FX_DEP must be tracked (git add them) — M8.3 commits the captured fixtures"; return 1; }
  if grep -qi apikey "$FX_VP" "$FX_DEP"; then
    grep -nio apikey "$FX_VP" "$FX_DEP" | head -5   # -o prints only the word, never a value next to it
    echo "ratchet: the captured fixtures mention 'apikey' — sanitize them (no key, no apikey param, not even in a comment)"; return 1
  fi
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
  node -e "$KEY_JS$KEYSCAN_JS"
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
need_re "from ['\"](\.\./)+src/domain/gtfsrt/decode-feed(\.ts)?['\"]" scripts/live
need_re "from ['\"](\.\./)+src/domain/live/transports(\.ts)?['\"]" scripts/live
need_re "from ['\"](\.\./)+src/domain/live/from-gtfsrt(\.ts)?['\"]" scripts/live
need_re "from ['\"](\.\./)+src/domain/live/from-transitland-departures(\.ts)?['\"]" scripts/live
need_re "from ['\"]gtfs-realtime-bindings['\"]" scripts/live
# 3. §3 key + endpoint discipline in the probe code: the key comes from the environment (TRANSITLAND_API_KEY via --env-file), never in a URL (no ?apikey= / &apikey= / searchParams apikey), and the 1 MB trip_updates.pb is never fetched (the string trip_updates appears nowhere in non-test scripts/live code).
need_re "TRANSITLAND_API_KEY" scripts/live
absent "[?&]apikey=" scripts/live
absent "searchParams\.(set|append)\(['\"]apikey" scripts/live
absent "trip_updates" scripts/live
# 4. M8.2a forced branches (node:test; network off, so fetch is injected; 30 s per-test timeout, so the clock is injected): a 404 retries every 60 s up to 5 times; a 401 stops at once; the key is never in a URL — each case its OWN passing test (a test whose full name matches two cases counts for neither), nothing failed/skipped/todo/cancelled.
nodetest_cases_offline "$PROBE_TEST" '(^|[^0-9])404([^0-9]|$).*retr.*\b60 ?s\b.*\b5\b' '(^|[^0-9])401([^0-9]|$).*\bstops?\b' 'key never in (the |a )?url'
# 5. M8.3: both captured fixtures exist, are tracked, and are sanitized (no 'apikey' anywhere in them).
gate_fixtures_sanitized
# 6. M8.3: the vehicle fixture is a real whole-agency capture (>= 50 vehicles, rail + Mover + buses, captured on/after 2026-10-01) and our decoder reads it exactly like the oracle (R5 on committed real bytes).
gate_fixture_ts "$FX_VP" "$FIXTURE_VP_JS"
# 7. M8.3: the departures fixture is a real Government Center (9512/9513) capture with >= 1 realtime row (schedule_relationship other than STATIC + estimated_utc).
gate_fixture_ts "$FX_DEP" "$FIXTURE_DEP_JS"
# 8. M8.3: the GTFS-RT mapper test imports the real capture and has distinct passing tests for it: rail and Mover vehicles mapped; out-of-scope routes dropped.
need_file "$FX_VP"
need_file src/domain/live/__tests__/from-gtfsrt.test.ts
need "__fixtures__/real-vehicle-positions" src/domain/live/__tests__/from-gtfsrt.test.ts
jest_cases src/domain/live/__tests__/from-gtfsrt.test.ts 'real capture.*rail and mover' 'real capture.*out-of-scope'
# 9. M8.3: the departures mapper test imports the real capture and has distinct passing tests for it: realtime predictions; stop_id mapped to the Government Center stationKey.
need_file "$FX_DEP"
need_file src/domain/live/__tests__/from-transitland-departures.test.ts
need "__fixtures__/real-departures" src/domain/live/__tests__/from-transitland-departures.test.ts
jest_cases src/domain/live/__tests__/from-transitland-departures.test.ts 'real capture.*realtime' 'real capture.*stationkey'
# 10. Plan M8.3 V (first half, `npx jest src/domain --ci`) with the captured fixtures in place: non-empty, green, nothing skipped.
for f in "$FX_VP" "$FX_DEP"; do need_file "$f"; done
jest_nonempty src/domain
# 11. The literal key from .env (read by node, never echoed) is in no tracked or committable file — the fixtures included — and in no git object reachable from any ref or the index.
gate_key_nowhere
# 12. M8.2a LIVE, in service hours: the plan's V prints ONE JSON line with status 200, railMover > 0, 0.8 <= matchRate <= 1, feedAgeS <= 180, 0 < bytesPerPoll <= 300000, oracleMatch true, and Government Center 9512 and 9513 each with >= 1 realtime departure; it exits 0 and never prints the key.
gate_probe_json
# 13. M8.2a LIVE, in service hours: the numbers are real — the gate re-derives them from this run's .cache/live captures (bytesPerPoll = bytes saved, feedAgeS from the saved header, railMover <= rail+Mover vehicles present, trip_id match >= 0.8 against schedule.db, our decoder == oracle, both departures files realtime), and the captures hold no key.
gate_probe_captures
# 14. Plan M8.3 V (second half): with the fixtures tracked, the m4b embedded-key guard --tree passes with the real .env after a fresh iOS export, and its output holds no key.
gate_plan_guard_tree
# 15. Repo-wide gate over this card's files (tsc incl. scripts/live, eslint, standards, jest, node:test).
for f in "$PROBE" "$PROBE_TEST" "$FX_VP" "$FX_DEP"; do need_file "$f"; done
full_gate
