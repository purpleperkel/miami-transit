#!/usr/bin/env bash
# m4a_live_domain — M4.1–M4.7 + M4.3b: live types + per-provider constants, GTFS-RT mapper, transports
# (Transitland: vehicle_positions.pb + per-station departures; trip_updates.pb is NEVER fetched),
# Transitland departures mapper, per-capability chain + quota, poll scheduler, merges.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# --- card-specific helpers (lib.sh has no multi-case jest pin, regex need, or absence check) -------

# jest_cases <test-file> <case>... — runs ONE test file once (exact path, local jest only) with a JSON
# report and passes only if jest succeeded, >= 1 test passed, none failed/skipped/todo, and EVERY
# <case> is a case-insensitive substring of at least one test's full name (describe titles + test
# title), all of whose matching tests passed.
# Why not lib's jest_nonempty "<file>" "<name>": a jest -t filter marks every test it excludes as
# skipped, and jest_nonempty (rightly) forbids skipped tests, so -t cannot pin several cases in one file.
jest_cases() {
  local file="$1" report out
  shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one case name"; return 1; }
  report=".cache/ratchet/m4a_live_domain.$(basename "$file").json"
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  rm -f "$report"
  out=$(local_bin jest --ci --runTestsByPath "$file" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest red (or not installed) for $file"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; echo "ratchet: jest wrote no JSON report for $file"; return 1; }
  node - "$file" "$report" "$@" <<'NODE' || return 1
const fs = require("node:fs");
const [file, report, ...wanted] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(report, "utf8"));
const tests = r.testResults.flatMap((suite) => suite.assertionResults);
const problems = [];
if (r.success !== true) problems.push("jest reported success=false");
if (r.numPassedTests < 1) problems.push("no test passed");
if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) problems.push("failing tests/suites");
if (r.numPendingTests > 0 || r.numTodoTests > 0) problems.push("skipped/todo tests are forbidden");
for (const name of wanted) {
  const hits = tests.filter((t) => t.fullName.toLowerCase().includes(name.toLowerCase()));
  if (hits.length === 0) problems.push(`no test named like '${name}'`);
  else if (hits.some((t) => t.status !== "passed")) problems.push(`a test named like '${name}' did not pass`);
}
if (problems.length > 0) {
  console.log(`ratchet: ${file}: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`ratchet: ${file}: ${r.numPassedTests} passed; named cases: ${wanted.join(" | ")}`);
NODE
}

# need_re <ERE> <file> — the file must contain a line matching the extended regex.
need_re() {
  local re="$1" file="$2"
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  grep -qE -- "$re" "$file" || { echo "ratchet: expected /$re/ in $file"; return 1; }
}

# absent <string> <file> — the (existing) file must NOT contain the plain string anywhere.
# A function (not `! grep`) on purpose: bash's `set -e` ignores a failing `!`-negated command.
absent() {
  local s="$1" file="$2"
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  if grep -qF -- "$s" "$file"; then
    grep -nF -- "$s" "$file" | head -5
    echo "ratchet: forbidden '$s' found in $file"; return 1
  fi
}

# 1. M4.1 — the §4 live contract exists at the plan's paths: LiveProvider (capabilities{vehicles,
#    predictions}, fetchVehicles, fetchPredictions) returning LiveBatch, LiveVehicle / LivePrediction,
#    and LiveError with all five kinds (no-key, network, timeout, http, decode).
need_file src/domain/live/types.ts
need_file src/domain/live/constants.ts
need "LiveProvider" src/domain/live/types.ts
need "capabilities" src/domain/live/types.ts
need "LiveBatch" src/domain/live/types.ts
need "LiveVehicle" src/domain/live/types.ts
need "LivePrediction" src/domain/live/types.ts
need "LiveError" src/domain/live/types.ts
need "fetchVehicles" src/domain/live/types.ts
need "fetchPredictions" src/domain/live/types.ts
need "no-key" src/domain/live/types.ts
need "network" src/domain/live/types.ts
need "timeout" src/domain/live/types.ts
need "http" src/domain/live/types.ts
need "decode" src/domain/live/types.ts

# 2. M4.1 — the provider config table holds the §3 values (the test asserts these numbers, in s or ms):
#    Swiftly cadence 30 s / fresh <= 75 s / max age 150 s; Transitland 60 / 150 / 210 s;
#    8 s request abort; backoff cap 120 s.
jest_cases src/domain/live/__tests__/constants.test.ts \
  "swiftly 30/75/150" "transitland 60/150/210" "8 s abort" "backoff cap 120 s"

# 3. M4.2 — one GTFS-RT mapper (Swiftly's vehicles + trip updates; Transitland's vehicles): fixture
#    vehicles map to LiveVehicle and fixture trip updates to LivePrediction; only routes
#    31009/14456/14457 are kept; the rail line comes from the trip_id -> pattern lookup (injected;
#    domain stays pure), else it is inferred from position.
need_file src/domain/live/from-gtfsrt.ts
jest_cases src/domain/live/__tests__/from-gtfsrt.test.ts \
  "maps fixture vehicles" "maps fixture trip updates" "keeps only 31009/14456/14457" \
  "line from trip_id pattern" "line inferred from position"

# 4. M4.3 — pure request builders: Swiftly sends header `Authorization: <key>` (exactly the key, no
#    "Bearer") and agencyKey defaults to `miami`; Transitland sends header `apikey`; Transitland
#    predictions are built per station (departures URL); no URL ever contains the key. Tests use an
#    obviously fake key, never a real one.
need_file src/domain/live/transports.ts
jest_cases src/domain/live/__tests__/transports.test.ts \
  "swiftly authorization header" "transitland apikey header" "transitland departures url" \
  "key never in url" "agencykey defaults to miami"

# 5. M4.3 — the transports test pins the §3 LIVE-VERIFIED endpoints as literals: Swiftly's two GTFS-RT
#    feeds, Transitland's vehicle_positions.pb, and a concrete Transitland per-station departures URL
#    (stop key f-dhw-miamidadetransit:<stop_id>, next=3600).
need_file src/domain/live/__tests__/transports.test.ts
need "https://api.goswift.ly/real-time/miami/gtfs-rt-vehicle-positions" src/domain/live/__tests__/transports.test.ts
need "https://api.goswift.ly/real-time/miami/gtfs-rt-trip-updates" src/domain/live/__tests__/transports.test.ts
need "https://transit.land/api/v2/rest/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb" src/domain/live/__tests__/transports.test.ts
need_re 'https://transit\.land/api/v2/rest/stops/f-dhw-miamidadetransit:[A-Za-z0-9_.-]+/departures\?next=3600' src/domain/live/__tests__/transports.test.ts

# 6. M4.3 / §3 — Transitland's 1 MB trip_updates.pb is NEVER fetched: transports.ts does not contain
#    `trip_updates` at all (Swiftly's feed is `trip-updates`, hyphenated, so it is unaffected), and a
#    named test proves no Transitland builder yields a trip_updates URL.
need_file src/domain/live/transports.ts
absent "trip_updates" src/domain/live/transports.ts
jest_cases src/domain/live/__tests__/transports.test.ts "never fetches trip_updates"

# 7. M4.3b — Transitland departures -> LivePrediction (the primary predictions path): the sanitized
#    fixture maps; a row is realtime iff schedule_relationship != STATIC AND estimated_utc is set (both
#    negative directions pinned); scheduled-only rows are flagged as such; stop_id maps to stationKey;
#    a malformed row yields Err without throwing.
need_file src/domain/live/from-transitland-departures.ts
jest_cases src/domain/live/__tests__/from-transitland-departures.test.ts \
  "maps fixture departures" "non-static with estimated_utc is realtime" "static is not realtime" \
  "no estimated_utc is not realtime" "scheduled-only rows flagged" "stop_id maps to stationkey" \
  "malformed row returns err without throwing"

# 8. M4.4 — provider chain swiftly > transitland > none, resolved PER CAPABILITY (the vehicles and
#    predictions chains are independent, e.g. Swiftly vehicles + Transitland predictions): fails over
#    after 3 failures; re-probes the primary after 300 s; a provider with no key is skipped;
#    Transitland is skipped at >= 9500 calls this month (95% of 10,000) and still used at 9499.
need_file src/domain/live/chain.ts
jest_cases src/domain/live/__tests__/chain.test.ts \
  "per capability" "after 3 failures" "after 300 s" "no key" "skips transitland at 9500" \
  "keeps transitland at 9499"

# 9. M4.4 — the monthly quota meter (src/live, OUTSIDE the plan's `npx jest src/domain/live`, so it is
#    gated by path here): counts calls in the current month and resets on the 1st of the month.
need_file src/live/quota.ts
jest_cases src/live/__tests__/quota.test.ts "counts calls" "resets on the 1st"

# 10. M4.5 — poll scheduler: polls never overlap; failure backoff 15 -> 30 -> 60 -> 120 s and stays
#     capped at 120; a 429 doubles the interval (§4 Polling); after background, everything is due on resume.
need_file src/domain/live/scheduler.ts
jest_cases src/domain/live/__tests__/scheduler.test.ts \
  "never overlaps" "backoff 15->30->60->120" "429 doubles" "due on resume"

# 11. M4.6 — vehicle merge: §4 merge rules 1-5 as ONE jest table test (.each). Rule 1 drops vehicles
#     past the provider's max age (e.g. 180 s old: dropped for Swiftly's 150, kept for Transitland's
#     210) or outside the Miami bounding box; rule 2 matches by trip_id, else greedily by line and
#     nearest <= 800 m; rule 3 live position wins; rule 4 an unmatched live vehicle is still shown;
#     rule 5 hides scheduled ghosts for a mode whose feed is fresh. Rule 6 is M4.7's (gate 12).
need_file src/domain/live/merge.ts
need_file src/domain/live/__tests__/merge.test.ts
need ".each" src/domain/live/__tests__/merge.test.ts
jest_cases src/domain/live/__tests__/merge.test.ts \
  "rule 1" "rule 2" "rule 3" "rule 4" "rule 5" "max age" "bounding box" "800 m"

# 12. M4.7 — prediction merge (§4 rule 6): a same-trip prediction overrides the scheduled time;
#     a canceled trip is struck through, not removed; an unmatched prediction becomes its own row.
need_file src/domain/live/merge-departures.ts
jest_cases src/domain/live/__tests__/merge-departures.test.ts \
  "rule 6" "same-trip override" "canceled" "unmatched"

# 13. The plan's V for M4.2–M4.7 + M4.3b, literally (`npx jest src/domain/live --ci`): non-empty, green,
#     nothing skipped. jest must be installed locally first (lib's jest_nonempty calls npx, which would
#     otherwise download a missing jest).
[ -d src/domain/live/__tests__ ] || { echo "ratchet: missing src/domain/live/__tests__ — the milestone's tests do not exist yet"; exit 1; }
local_bin jest --version >/dev/null
jest_nonempty src/domain/live

# 14. Repo-wide gate: tsc (M4.1's V), eslint incl. src/domain purity, standards, jest, node:test.
full_gate
