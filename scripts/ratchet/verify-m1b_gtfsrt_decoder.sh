#!/usr/bin/env bash
# m1b_gtfsrt_decoder — our own GTFS-realtime protobuf decoder (M1.8–M1.13), proven against the protobufjs oracle
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

T=src/domain/gtfsrt/__tests__

# Named acceptance cases. lib.sh's `jest_nonempty <path> <name>` cannot be used for this: jest
# reports every test that -t filters out as "skipped", which jest_nonempty's no-skip rule rejects,
# so it would fail a correct build. Instead run the file unfiltered with --json and require, for
# each pattern (case-insensitive regex on the test's full name, describe + it), at least one
# PASSED test. The suite-level non-empty / green / no-skip proof stays with jest_nonempty.
jest_cases() {
  local file="$1"; shift
  local report out rc=0
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  report=$(mktemp) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(npx jest --ci "$file" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; rm -f "$report"; return 1; }
  node -e '
    const fs = require("fs");
    const [report, ...pats] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(report, "utf8"));
    const passed = r.testResults.flatMap((f) => f.assertionResults)
      .filter((t) => t.status === "passed").map((t) => t.fullName);
    const missing = pats.filter((p) => !passed.some((n) => new RegExp(p, "iu").test(n)));
    if (missing.length > 0) {
      console.log("ratchet: no PASSED test whose name matches: " + missing.join("  |  "));
      console.log("passed tests: " + (passed.join("  ;  ") || "(none)"));
      process.exit(1);
    }
    console.log("OK " + pats.length + " named cases passed");
  ' -- "$report" "$@" || rc=1
  rm -f "$report"
  return "$rc"
}

# Fixture idempotence. The plan's V (`git diff --exit-code`) alone is vacuous while the fixture is
# untracked (the builder runs verify BEFORE committing), and two runs inside the same second hide a
# Date.now() dependency. So: delete the fixture, regenerate it (proves the GENERATOR owns the file,
# not a hand edit), require byte-identity with what was on disk, regenerate again under a different
# TZ (proves determinism), then the plan's git diff (proves no drift from the committed copy).
# The original fixture is restored if the generator fails or disagrees, so verify never eats it.
fixture_idempotent() {
  local gen=scripts/fixtures/make-gtfsrt-fixture.ts dir=src/domain/gtfsrt/__fixtures__
  local fx=src/domain/gtfsrt/__fixtures__/vehicle-positions.fixture.ts saved
  need_file "$gen" || return 1
  need_file "$fx" || return 1
  [ -s "$fx" ] || { echo "ratchet: $fx is empty"; return 1; }
  saved=$(mktemp) || { echo "ratchet: mktemp failed"; return 1; }
  cp "$fx" "$saved"
  rm "$fx"
  if ! TZ=UTC npx tsx "$gen"; then
    cp "$saved" "$fx"; rm -f "$saved"; echo "ratchet: fixture generator run 1 failed"; return 1
  fi
  if ! cmp -s "$saved" "$fx"; then
    cp "$saved" "$fx"; rm -f "$saved"
    echo "ratchet: generator did not reproduce $fx byte-for-byte (missing or different)"; return 1
  fi
  if ! TZ=Pacific/Kiritimati npx tsx "$gen" || ! cmp -s "$saved" "$fx"; then
    cp "$saved" "$fx"; rm -f "$saved"
    echo "ratchet: second generator run (TZ=Pacific/Kiritimati) failed or changed $fx — not deterministic"; return 1
  fi
  rm -f "$saved"
  git diff --exit-code -- "$dir" || { echo "ratchet: $dir drifted from the committed copy"; return 1; }
}

# 1. The decoder modules exist at the plan's paths (M1.8–M1.11 F lines).
for f in wire utf8 decode-feed decode-vehicle decode-trip-update; do need_file "src/domain/gtfsrt/$f.ts"; done
# 2. M1.8 wire-reader suite is non-empty, green, no skipped tests.
jest_nonempty "$T/wire.test.ts"
# 3. M1.8 acceptance cases each pass: [0xAC,0x02] -> 300; ten-byte negative -1 -> -1; float32 25.77 ±1e-5;
#    wire type 3 -> Err; reading past the end -> Err.
jest_cases "$T/wire.test.ts" '300' 'negative' 'float32' 'wire type 3' 'past the end'
# 4. M1.9 UTF-8 suite is non-empty, green, no skipped tests.
jest_nonempty "$T/utf8.test.ts"
# 5. M1.9 acceptance cases each pass: the four strings round-trip (one named test each), invalid byte -> U+FFFD.
jest_cases "$T/utf8.test.ts" 'Gov’t Center' 'Ñ' '🚆' 'abc' 'FFFD'
# 6. M1.10 feed/entity/vehicle suite is non-empty, green, no skipped tests.
jest_nonempty "$T/decode-vehicle.test.ts"
# 7. M1.10 acceptance cases each pass: hand-built bytes -> timestamp, latitude, trip id; unknown field 1000 skipped.
jest_cases "$T/decode-vehicle.test.ts" 'timestamp' 'latitude' 'trip.?id' 'unknown field 1000'
# 8. M1.11 trip-update suite is non-empty, green, no skipped tests.
jest_nonempty "$T/decode-trip-update.test.ts"
# 9. M1.11 acceptance cases each pass: delay -45 survives; arrival.time and stopId decode; SKIPPED = 1.
jest_cases "$T/decode-trip-update.test.ts" '[-−]45' 'arrival.?time' 'stop.?id' 'SKIPPED'
# 10. M1.12 gtfs-realtime-bindings is installed as a devDependency ONLY; neither it nor protobufjs is a
#     runtime dependency, and no non-test module under src/ references either (the decoder is ours).
node -e '
  const p = require("./package.json"), dev = p.devDependencies || {}, run = p.dependencies || {};
  if (!dev["gtfs-realtime-bindings"]) { console.log("ratchet: gtfs-realtime-bindings is not a devDependency"); process.exit(1); }
  for (const m of ["gtfs-realtime-bindings", "protobufjs"]) if (run[m]) { console.log("ratchet: " + m + " must not be a runtime dependency"); process.exit(1); }
  try { require.resolve("gtfs-realtime-bindings"); }
  catch (e) { console.log("ratchet: gtfs-realtime-bindings is listed but not installed: " + e.message); process.exit(1); }
  console.log("OK devDependency only");
'
! grep -rnE "['\"](gtfs-realtime-bindings|protobufjs)(/[^'\"]*)?['\"]" src --exclude-dir=__tests__ \
  || { echo "ratchet: app/domain code references the oracle — only __tests__ may"; exit 1; }
# 11. M1.12 the oracle test really encodes with the bindings (not hand-built bytes).
need_file "$T/oracle.test.ts"
need "gtfs-realtime-bindings" "$T/oracle.test.ts"
# 12. M1.12 oracle suite is non-empty, green, no skipped tests.
jest_nonempty "$T/oracle.test.ts"
# 13. M1.12 acceptance cases each pass: 3 vehicles and 2 trip updates deep-equal, incl. a uint64 timestamp
#     and a unicode string.
jest_cases "$T/oracle.test.ts" '3 vehicles' '2 trip updates' 'uint64' 'unicode'
# 14. M1.13 the fixture generator owns the fixture and is idempotent + deterministic (see fixture_idempotent).
fixture_idempotent
# 15. Repo-wide gate: tsc, eslint --max-warnings 0, standards (length, invariants, recursion, silent catch), jest, node:test.
full_gate
