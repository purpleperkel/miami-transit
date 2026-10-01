#!/usr/bin/env bash
# m3a_schedule_queries — SQL executors, service-day resolution, departures and rides, proven on the real schedule DB (plan M3.1–M3.4).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Card-local helper: one acceptance test, by name, on the real DB.
# Runs only the node:test tests whose full name (suite names + test name) matches /$2/i, then
# requires: >=1 such test passed (not skipped), 0 failed, and the run queried
# assets/db/schedule.db in place (a probe on DatabaseSync.prototype.prepare/createTagStore logs
# every DB file a test queries). It does not trust "# pass N": Node 26 reports a file with zero matching
# tests as one passing test, so the passing test lines themselves are counted.
REAL_DB="$(pwd -P)/assets/db/schedule.db"
DB_PROBE='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?String(db.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","createTagStore"]){const f=D.prototype[k];D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}'
nodetest_real() {
  local file="$1" pattern="$2" out lc hits
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  # The probe is imported BEFORE tsx so it loads on Node's default loader, untouched by tsx's hooks.
  out=$(node --import "$DB_PROBE" --import tsx --test --test-reporter=tap \
        --test-name-pattern="/$pattern/i" "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: tests matching /$pattern/i failed in $file"; return 1; }
  lc=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
  hits=$(echo "$out" | awk -v re="$lc" '
    { match($0, /^ */); d = RLENGTH; line = substr($0, d + 1) }
    line ~ /^# Subtest: / { nm = line; sub(/^# Subtest: /, "", nm); stack[d] = nm; next }
    line ~ /^ok [0-9]+ - / { okd = d; okline = line; pending = 1; next }
    line ~ /^not ok / { pending = 0; next }
    pending && line ~ /^type: / {
      pending = 0
      if (line !~ /test/ || okline ~ / # (SKIP|TODO)/) next
      full = ""
      for (i = 0; i <= okd; i += 4) full = full " " stack[i]
      if (tolower(full) ~ re) n++
    }
    END { print n + 0 }')
  [ "$hits" -ge 1 ] \
    || { echo "$out" | tail -15; echo "ratchet: no passing test named /$pattern/i in $file"; return 1; }
  echo "$out" | grep -qE "^# fail 0" \
    || { echo "$out" | tail -15; echo "ratchet: failures in $file (/$pattern/i)"; return 1; }
  echo "$out" | grep -qF "ratchet-db-open: $REAL_DB" \
    || { echo "$out" | sed -n '/ratchet-db-open:/p'; echo "ratchet: /$pattern/i in $file never queried $REAL_DB — acceptance must run on the real DB, in place"; return 1; }
}

# --- M3.1 SQL executors ---
# 1. The platform-neutral SqlExecutor contract exists in src/data.
need_file src/data/sql-executor.ts
# 2. The on-device executor exists and is backed by expo-sqlite (not a stub).
need 'expo-sqlite' src/data/expo-sql-executor.ts
# 3. Plan V (M3.1): the executor suite runs green with >=1 passing test.
nodetest_nonempty scripts/gtfs/__tests__/executor.test.ts
# 4. A (M3.1): meta.feed_sha256 read through the executor from the real DB equals the manifest.
nodetest_real scripts/gtfs/__tests__/executor.test.ts 'feed_sha256.*manifest'

# --- M3.2 Service-day resolution ---
# 5. Pure service-day resolution lives in the domain layer.
need_file src/domain/gtfs/service-day.ts
# 6. The schedule SQL lives in one queries module.
need_file src/data/schedule-queries.ts
# 7. The schedule repo (executor + queries + domain) exists.
need_file src/data/schedule-repo.ts
# 8. Plan V (M3.2): the repo-days suite runs green with >=1 passing test.
nodetest_nonempty scripts/gtfs/__tests__/repo-days.test.ts
# 9. A (M3.2): Wed 2026-09-30 12:00 resolves to exactly [20260930] on the real DB.
nodetest_real scripts/gtfs/__tests__/repo-days.test.ts 'Wed 12:00.*20260930'
# 10. A (M3.2): Sat 00:30 includes Friday's service day (24:xx trips stay reachable).
nodetest_real scripts/gtfs/__tests__/repo-days.test.ts 'Sat 00:30.*Friday'
# 11. A (M3.2): an instant after Dec 31 (past the Mover's last service day) resolves to expired.
nodetest_real scripts/gtfs/__tests__/repo-days.test.ts 'after Dec 31.*expired'

# --- M3.3 Departures ---
# 12. Pure departure assembly lives in the domain layer.
need_file src/domain/schedule/departures.ts
# 13. Plan V (M3.3): the repo-departures suite runs green with >=1 passing test.
nodetest_nonempty scripts/gtfs/__tests__/repo-departures.test.ts
# 14. A (M3.3): Government Center, Wed 08:00 -> >= 4 departures per direction within 30 min.
nodetest_real scripts/gtfs/__tests__/repo-departures.test.ts 'Government Center.*Wed 08:00.*per direction'
# 15. A (M3.3): Dadeland South never lists a departure "to Dadeland South" (terminating trains excluded).
nodetest_real scripts/gtfs/__tests__/repo-departures.test.ts 'Dadeland South never'
# 16. A (M3.3): trips timed 24:xx (previous service day) are included.
nodetest_real scripts/gtfs/__tests__/repo-departures.test.ts '24:xx'

# --- M3.4 Rides between stations ---
# 17. The needs-transfer ride outcome exists in engine source (src/domain or src/data).
need 'needs-transfer' src/domain src/data
# 18. Plan V (M3.4): the repo-rides suite runs green with >=1 passing test.
nodetest_nonempty scripts/gtfs/__tests__/repo-rides.test.ts
# 19. A (M3.4): Knight Center -> College North rides through the Inner Loop block link (next_trip_idx hop).
nodetest_real scripts/gtfs/__tests__/repo-rides.test.ts 'Knight Center.*College North.*block'
# 20. A (M3.4): Brickell -> Government Center gives direct rides.
nodetest_real scripts/gtfs/__tests__/repo-rides.test.ts 'Brickell.*Government Center'
# 21. A (M3.4): MIA -> Brickell, Sat 21:00 -> needs-transfer.
nodetest_real scripts/gtfs/__tests__/repo-rides.test.ts 'MIA.*Brickell.*Sat 21:00.*needs-transfer'

# 22. The repo-wide gate: tsc (app + scripts), eslint, standards, jest, node:test.
full_gate
