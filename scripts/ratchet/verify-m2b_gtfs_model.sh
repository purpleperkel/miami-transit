#!/usr/bin/env bash
# m2b_gtfs_model — network model: station clustering + names, stop-pattern lines, shape geometry, block links, transfers, calendar (plan M2.9–M2.14)
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Card-local helpers — only what lib.sh does not provide. node:test cases use lib.sh's
# nodetest_nonempty / nodetest_case (full "suite … leaf" names, case-insensitive).

# jest_named <path> <pattern> [exact-count]: >= 1 passing jest test (or exactly N) whose full name
# ("describe … test") matches /pattern/i — jest's -t is a case-insensitive regex over the full name.
# lib.sh's `jest_nonempty "$path" "$name"` cannot select one case: jest counts every test the -t
# filter excludes as "skipped", which trips its no-skips check on any file holding more than one
# test. So each suite's unfiltered jest_nonempty gate owns the no-skip check, and jest_named only
# asserts the filter selected passing tests. Runs the local jest via local_bin (never an npx download).
jest_named() {
  local path="$1" name="$2" want="${3:-}" out passed
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  out=$(local_bin jest --ci "$path" -t "$name" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest is red under $path (-t '$name')"; return 1; }
  passed=$(echo "$out" | sed -nE 's/^Tests:.* ([0-9]+) passed.*/\1/p')
  [ -n "$passed" ] && [ "$passed" -ge 1 ] \
    || { echo "$out" | tail -15; echo "ratchet: no passing jest test named /$name/i under $path"; return 1; }
  if [ -n "$want" ] && [ "$passed" -ne "$want" ]; then
    echo "ratchet: $passed jest tests named /$name/i passed under $path; the plan requires exactly $want"; return 1
  fi
}

# base_epoch_is <yyyymmdd> <epoch>: imports the shipped scripts/gtfs/calendar.ts and requires
# baseEpoch(day) === epoch — evidence about the implementation itself, independent of its tests.
base_epoch_is() {
  local day="$1" want="$2"
  need_file scripts/gtfs/calendar.ts || return 1
  node --import tsx --input-type=module -e '
const [day, want] = process.argv.slice(1).map(Number);
const m = await import("./scripts/gtfs/calendar.ts");
const baseEpoch = m.baseEpoch ?? m.default?.baseEpoch;
if (typeof baseEpoch !== "function") { console.error("ratchet: scripts/gtfs/calendar.ts exports no baseEpoch"); process.exit(1); }
const got = baseEpoch(day);
if (got !== want) { console.error(`ratchet: baseEpoch(${day}) = ${got}, plan requires ${want}`); process.exit(1); }
console.log(`ratchet: baseEpoch(${day}) = ${want}`);' "$day" "$want"
}

# 1. The plan's F files exist at the plan's paths (M2.9 stations, M2.10 catalog + derivation,
#    M2.11 shape geometry, M2.12/M2.13 network build, M2.14 calendar).
for f in src/domain/network/stations.ts src/domain/lines/line-catalog.ts src/domain/lines/derive-line.ts \
         src/domain/schedule/shape-geometry.ts scripts/gtfs/build-network.ts scripts/gtfs/calendar.ts; do
  need_file "$f"
done

# 2. M2.9 V: the station-clustering jest suite exists, is green, and has no skipped tests.
jest_nonempty src/domain/network
# 3. M2.9 A: Government Center N+S cluster to rail:government-ctr.
jest_named src/domain/network "Government Center.*rail:government-ctr"
# 4. M2.9 A: Mover stops 808/832/841 cluster to mover:bayfront-park.
jest_named src/domain/network "808/832/841.*mover:bayfront-park"
# 5. M2.9 A: every display name is Title Case, has no STATION/METRORAIL, and is <= 28 characters.
jest_named src/domain/network "Title Case.*METRORAIL.*28"

# 6. M2.10 V: the line-derivation jest suite exists, is green, and has no skipped tests.
jest_nonempty src/domain/lines
# 7. M2.10 A: all 15 real rail stop patterns map to their expected line — exactly 15 named cases.
jest_named src/domain/lines "real-pattern" 15
# 8. M2.10 A: a pattern touching both branches is an Err (a contradiction is a build error).
jest_named src/domain/lines "both branches"
# 9. M2.10 A: a pattern through School Board derives MM_OMNI.
jest_named src/domain/lines "School Board.*MM_OMNI"
# 10. M2.10, feed 2026-10-01: MMO shape 123748 (headsign FINANCIAL DISTRICT, dir 1, Gov Ctr ->
#     Financial District) derives MM_BRICKELL.
jest_named src/domain/lines "FINANCIAL DISTRICT.*123748.*MM_BRICKELL"
# 11. M2.10, feed 2026-10-01: MMO shape 123745 (headsign DOWNTOWN, dir 0, School Board -> Gov Ctr,
#     9 stops) derives MM_OMNI from its stop pattern — the headsign cannot tell the legs apart.
jest_named src/domain/lines "DOWNTOWN.*123745.*MM_OMNI"
# 12. M2.10, feed 2026-10-01: MMO shape 123746 (headsign DOWNTOWN, dir 0, Financial District ->
#     Gov Ctr, 13 stops) derives MM_BRICKELL from its stop pattern.
jest_named src/domain/lines "DOWNTOWN.*123746.*MM_BRICKELL"
# 13. M2.10, feed 2026-10-01: a trip headsigned "EHT - CUL SINGLE TRACK AFTER 8PM" (118 trips,
#     Palmetto -> Dadeland South) derives the Green line from its stop pattern.
jest_named src/domain/lines "SINGLE TRACK AFTER 8PM.*GREEN"
# 14. M2.10, feed 2026-10-01: the other spelling, "EHT - CUL SINGLE TRACK AFTER 8 PM" (118 trips,
#     Dadeland South -> Palmetto), also derives the Green line from its stop pattern.
jest_named src/domain/lines "SINGLE TRACK AFTER 8 PM.*GREEN"

# 15. M2.11 V: the shape-geometry jest suite exists, is green, and has no skipped tests.
jest_nonempty src/domain/schedule/__tests__/shape-geometry.test.ts
# 16. M2.11 A: cumulative distance along a shape is within ±1 m.
jest_named src/domain/schedule/__tests__/shape-geometry.test.ts "cumulative distance"
# 17. M2.11 A: stop projection is monotone on a loop shape.
jest_named src/domain/schedule/__tests__/shape-geometry.test.ts "monotone.*loop"
# 18. M2.11 A: a stop more than 100 m off its shape is an Err.
jest_named src/domain/schedule/__tests__/shape-geometry.test.ts "100 m"

# 19. M2.12/M2.13 V: the network-build node:test file has real passing tests and 0 fail/skip/todo/cancelled.
nodetest_nonempty scripts/gtfs/__tests__/build-network.test.ts
# 20. M2.12 A: Inner Loop half-trips are chained through block_id into next_trip_idx.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "Inner Loop.*next_trip_idx"
# 21. M2.12 A: single-track trips carry a note.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "single-track.*note"
# 22. M2.12, feed 2026-10-01: a trip headsigned "...SINGLE TRACK AFTER 8PM" carries the note.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "single-track.*note.*AFTER 8PM"
# 23. M2.12, feed 2026-10-01: a trip headsigned "...SINGLE TRACK AFTER 8 PM" carries the note too.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "single-track.*note.*AFTER 8 PM"
# 24. M2.12 A: a trip's destination is its last station, not its headsign.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "destination.*last station"
# 25. M2.13 A: a same-station transfer is 60 s.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "same.station.*60 s"
# 26. M2.13 A: rail<->mover transfers exist only for pairs within 400 m.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "400 m"
# 27. M2.13 A: the transfer table is symmetric.
nodetest_case scripts/gtfs/__tests__/build-network.test.ts "symmetric"

# 28. M2.14 V: the calendar node:test file has real passing tests and 0 fail/skip/todo/cancelled.
nodetest_nonempty scripts/gtfs/__tests__/calendar.test.ts
# 29. M2.14 A: a named test pins baseEpoch(20260930) = 1790740800.
nodetest_case scripts/gtfs/__tests__/calendar.test.ts "1790740800"
# 30. M2.14 A: a named test pins baseEpoch(20261101) = 1793509200 (DST-end day: noon minus 12 h).
nodetest_case scripts/gtfs/__tests__/calendar.test.ts "1793509200"
# 31. M2.14 A: Labor Day (20260907) swaps the weekday service for the holiday service.
nodetest_case scripts/gtfs/__tests__/calendar.test.ts "Labor Day.*20260907"
# 32. M2.14 A, on the shipped code: baseEpoch(20260930) returns 1790740800 (EDT day).
base_epoch_is 20260930 1790740800
# 33. M2.14 A, on the shipped code: baseEpoch(20261101) returns 1793509200 (DST-end day; local
#     midnight would give 1793505600 — the trap this gate exists to catch).
base_epoch_is 20261101 1793509200

# 34. The repo-wide gate: tsc (app + scripts), eslint, standards, jest and node:test all green.
full_gate
