#!/usr/bin/env bash
# m2a_gtfs_parse — GTFS ingest M2.1–M2.8: pinned deps, GTFS time, tolerant CSV, mini feed, conditional fetch, idempotency, unzip, scoped load.
# Every node:test suite is proven two ways. A whole-file gate (`nodetest_case <file> . N`) is the plan's V: green, no
# fail/skip/todo/cancelled, and >=N real passing tests. Then one nodetest_case gate per plan acceptance case.
# The whole-file gate is used instead of nodetest_nonempty on purpose. lib.sh drops the empty-file wrapper only when its
# name equals basename(file), but Node 26 names it by the path as given (scripts/gtfs/__tests__/x.test.ts), so
# nodetest_nonempty passes an empty file here. With N >= 2 the wrapper (1 pass) can never satisfy the floor.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Card-local helper: lib.sh's `need` is case-sensitive, but HTTP header names are not
# (an implementation may spell If-None-Match, a node:http test reads req.headers["if-none-match"]).
need_ci() {
  local pattern="$1"; shift
  grep -rqiF -- "$pattern" "$@" \
    || { echo "ratchet: expected artifact not found (case-insensitive): '$pattern' in $*"; return 1; }
}

# 1. M2.1: fflate 0.8.3 and csv-parse 7.0.3 are devDependencies, installed at exactly those versions, and load (plan V).
node -e 'const fs=require("fs");const p=require("./package.json");for(const [n,want] of [["fflate","0.8.3"],["csv-parse","7.0.3"]]){const spec=(p.devDependencies||{})[n];const got=fs.existsSync("node_modules/"+n+"/package.json")?JSON.parse(fs.readFileSync("node_modules/"+n+"/package.json","utf8")).version:"absent";if(!spec||got!==want){console.error("ratchet: "+n+" devDependency="+spec+" installed="+got+", want "+want);process.exit(1)}}require("fflate");require("csv-parse/sync");console.log("deps OK")'

# 2. M2.1: scripts/gtfs/paths.ts exists.
need_file scripts/gtfs/paths.ts

# 3. M2.1: scripts/gtfs/scope.ts names the in-scope routes 31009 (rail), 14457 (MMI) and 14456 (MMO).
for r in 31009 14457 14456; do need "$r" scripts/gtfs/scope.ts; done

# 4. M2.1: the scripts project type-checks clean with the locally installed tsc (plan V).
local_bin tsc --noEmit -p scripts/tsconfig.json

# 5. M2.1: that type-check actually covers scripts/gtfs/paths.ts and scripts/gtfs/scope.ts.
[ "$(local_bin tsc --listFilesOnly -p scripts/tsconfig.json | grep -cE '/scripts/gtfs/(paths|scope)\.ts$')" = 2 ] || { echo "ratchet: scripts/tsconfig.json is missing or does not type-check scripts/gtfs/paths.ts and scope.ts"; exit 1; }

# 6. M2.2: the src/domain/gtfs jest suite runs >=1 test, all pass, none skipped (plan V).
jest_nonempty src/domain/gtfs

# 7. M2.2: the jest tests assert the plan's exact acceptance values.
for v in ' 5:32:00' 19920 '25:04:00' 90240 '1:04 AM' formatServiceSeconds; do need "$v" src/domain/gtfs/__tests__; done

# 8. M2.2: time.ts exists and formatServiceSeconds(90240) returns exactly "1:04 AM" (wraps past 24:00, 12-hour, plain space).
need_file src/domain/gtfs/time.ts
node --import tsx -e 'import("./src/domain/gtfs/time.ts").then((m)=>{if(typeof m.formatServiceSeconds!=="function"){console.error("ratchet: src/domain/gtfs/time.ts does not export formatServiceSeconds");process.exit(1)}const got=m.formatServiceSeconds(90240);if(got!=="1:04 AM"){const shown=String(JSON.stringify(got)).replace(/[^\x20-\x7e]/g,(c)=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0"));console.error("ratchet: formatServiceSeconds(90240) = "+shown+", want \"1:04 AM\"");process.exit(1)}console.log("formatServiceSeconds OK")})'

# 9. M2.3: the tolerant CSV parser is built on csv-parse (plan §4 step 4).
need csv-parse scripts/gtfs/parse-csv.ts

# 10. M2.3: plan V and non-empty — the whole parse-csv suite is green with no fail/skip/todo/cancelled and >=5 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts . 5

# 11. M2.3: a passing test proves CRLF line endings are handled.
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts 'crlf'

# 12. M2.3: a passing test proves leading spaces in fields are trimmed.
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts 'leading.?space'

# 13. M2.3: a passing test proves a UTF-8 BOM is handled.
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts 'bom'

# 14. M2.3: a passing test proves a quoted field (with an embedded comma) stays whole.
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts 'quoted'

# 15. M2.3: a passing test proves a missing column gives Err naming the file and the column.
nodetest_case scripts/gtfs/__tests__/parse-csv.test.ts 'missing.?column'

# 16. M2.4: the mini fixture feed carries rail 31009 and Inner Loop 14457 rows.
for r in 31009 14457; do need "$r" scripts/gtfs/__fixtures__/mini-feed.ts; done

# 17. M2.4: the fixture feed (or its test) pins the DST date 20261101.
need 20261101 scripts/gtfs/__fixtures__/mini-feed.ts scripts/gtfs/__tests__/mini-feed.test.ts

# 18. M2.4: plan V and non-empty — the whole mini-feed suite is green with no fail/skip/todo/cancelled and >=8 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts . 8

# 19. M2.4: a passing test proves the fixture has a Green-line stop pattern.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'green'

# 20. M2.4: a passing test proves the fixture has an Orange-line stop pattern.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'orange'

# 21. M2.4: a passing test proves the fixture has a 2-stop MIA↔EHT shuttle pattern.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'shuttle'

# 22. M2.4: a passing test proves the fixture has Inner Loop half-trips chained by block_id.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'half.?trip'

# 23. M2.4: a passing test proves the fixture has a bus route (which load-feed must filter out).
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'bus'

# 24. M2.4: a passing test proves the fixture has calendar_dates exceptions.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'calendar.?dates'

# 25. M2.4: a passing test proves the fixture has service on the DST date 20261101.
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'dst|20261101'

# 26. M2.4: a passing test proves the fixture carries the real feed's parsing quirks (CRLF, leading spaces, unpadded times, times past 24:00).
nodetest_case scripts/gtfs/__tests__/mini-feed.test.ts 'quirk'

# 27. M2.5: fetch-feed.ts sends both conditional headers, If-None-Match (ETag) and If-Modified-Since (Last-Modified) (plan §4 step 1).
for h in if-none-match if-modified-since; do need_ci "$h" scripts/gtfs/fetch-feed.ts; done

# 28. M2.5: the fetch test's server reads both conditional headers, so its not-modified answers are earned, not hardwired.
for h in if-none-match if-modified-since; do need_ci "$h" scripts/gtfs/__tests__/fetch-feed.test.ts; done

# 29. M2.5: the fetch test drives a real local node:http server (createServer) and never names the county host.
need node:http scripts/gtfs/__tests__/fetch-feed.test.ts
need createServer scripts/gtfs/__tests__/fetch-feed.test.ts
if grep -qiF miamidade.gov scripts/gtfs/__tests__/fetch-feed.test.ts; then echo "ratchet: fetch-feed.test.ts names the county host — fetch tests must hit the local node:http server only"; exit 1; fi

# 30. M2.5: plan V and non-empty — the whole fetch-feed suite is green with no fail/skip/todo/cancelled and >=5 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts . 5

# 31. M2.5: a passing test proves a fresh download returns the zip bytes.
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts 'fresh'

# 32. M2.5: a passing test proves a matching stored ETag yields not-modified.
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts '(etag|if.none.match).*not.modified|not.modified.*(etag|if.none.match)'

# 33. M2.5: a passing test proves a matching stored Last-Modified yields not-modified.
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts '(last|if).modified.*not.modified|not.modified.*(last|if).modified'

# 34. M2.5: a passing test proves an HTTP 500 gives Err.
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts '500'

# 35. M2.5: a passing test proves a non-zip body gives Err.
nodetest_case scripts/gtfs/__tests__/fetch-feed.test.ts 'non.?zip|not.a.zip'

# 36. M2.6: scripts/gtfs/idempotency.ts exists.
need_file scripts/gtfs/idempotency.ts

# 37. M2.6: plan V and non-empty — the whole idempotency suite is green with no fail/skip/todo/cancelled and >=6 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts . 6

# 38. M2.6: a passing test proves zip, builder version and DB hash all matching → skip (UNCHANGED).
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'skip|unchanged'

# 39. M2.6: a passing test proves a zip SHA-256 mismatch → build.
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'zip.*mismatch'

# 40. M2.6: a passing test proves a builder-version mismatch → build.
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'builder.version.*mismatch'

# 41. M2.6: a passing test proves a DB-hash (dbSha256) mismatch → build.
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'db.?(hash|sha).*mismatch'

# 42. M2.6: a passing test proves --force → build even when everything matches.
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'force'

# 43. M2.6: a passing test proves no stored manifest (first build) → build.
nodetest_case scripts/gtfs/__tests__/idempotency.test.ts 'no.manifest|missing.manifest|manifest.missing'

# 44. M2.7: unzip-feed.ts unzips with fflate (plan §4 step 3).
need fflate scripts/gtfs/unzip-feed.ts

# 45. M2.7: plan V and non-empty — the whole unzip-feed suite is green with no fail/skip/todo/cancelled and >=2 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/unzip-feed.test.ts . 2

# 46. M2.7: a passing test proves all 7 required files are extracted.
nodetest_case scripts/gtfs/__tests__/unzip-feed.test.ts '(7|seven|all).required'

# 47. M2.7: a passing test proves a missing required file gives Err naming it.
nodetest_case scripts/gtfs/__tests__/unzip-feed.test.ts 'missing'

# 48. M2.8: scripts/gtfs/load-feed.ts exists.
need_file scripts/gtfs/load-feed.ts

# 49. M2.8: plan V and non-empty — the whole load-feed suite is green with no fail/skip/todo/cancelled and >=3 real passing tests (one per acceptance case below).
nodetest_case scripts/gtfs/__tests__/load-feed.test.ts . 3

# 50. M2.8: a passing test proves bus rows are excluded from the in-scope load.
nodetest_case scripts/gtfs/__tests__/load-feed.test.ts 'bus'

# 51. M2.8: a passing test proves the agency time zone is asserted (a wrong one gives Err).
nodetest_case scripts/gtfs/__tests__/load-feed.test.ts 'time.?zone'

# 52. M2.8: a passing test proves pickup_type=1 gives Err.
nodetest_case scripts/gtfs/__tests__/load-feed.test.ts 'pickup.?type'

# 53. Repo-wide gate: tsc (app + scripts), eslint, standards, jest, node:test.
full_gate
