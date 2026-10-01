#!/usr/bin/env bash
# m2c_gtfs_db — schedule DB schema + atomic writer, verifier, manifest, deterministic build CLI, real county build, derivation report (plan M2.15–M2.20)
#
# Every gate is runnable alone after `cd <repo> && source scripts/ratchet/lib.sh` plus the prelude
# below (constants + snap). No gate reads a variable another gate set.
#
# Test-naming contract (gates 3–7, 9–13, 15–16, 18–20): nodetest_case matches the FULL test name
# ("describe … test", case-insensitive) against the plan's acceptance wording, so each acceptance
# case must be its own passing test whose name carries that wording (e.g. "integrity_check = ok",
# "rail service-end epoch = start(end date) + 86400", "--force gives the identical dbSha256").
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# ---- prelude: constants + the one card-specific helper ----------------------------------------
DB=assets/db/schedule.db
MANIFEST=assets/db/manifest.json
WRITE_T=scripts/gtfs/__tests__/write-db.test.ts
VERIFY_T=scripts/gtfs/__tests__/verify-db.test.ts
MANIFEST_T=scripts/gtfs/__tests__/manifest.test.ts
BUILD_T=scripts/gtfs/__tests__/build.test.ts

# sha256 + mtime of the committed DB and manifest (used to prove an UNCHANGED rerun writes nothing)
snap() {
  node -e 'const fs=require("fs"),c=require("crypto");for(const f of process.argv.slice(1)){console.log(f,c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"),fs.statSync(f).mtimeMs)}' "$DB" "$MANIFEST"
}

# ---- M2.15 schema + writer ----------------------------------------------------------------------

# 1. M2.15 files exist where the plan puts them (the node executor lives in scripts/lib, never under src/ — node:sqlite must not reach Metro)
need_file scripts/gtfs/schema.ts
need_file scripts/gtfs/write-db.ts
need_file scripts/lib/node-sql-executor.ts

# 2. M2.15 the whole writer suite is green with >= 1 real passing test (no fail/skip/todo; an empty file is rejected)
nodetest_nonempty "$WRITE_T"

# 3. M2.15 case: row counts match after the written DB is closed and reopened
nodetest_case "$WRITE_T" 'count.*reopen|reopen.*count'

# 4. M2.15 case: PRAGMA integrity_check = ok on the written DB
nodetest_case "$WRITE_T" 'integrity.?check.*ok'

# 5. M2.15 case: PRAGMA user_version = 1 on the written DB
nodetest_case "$WRITE_T" 'user.?version.*1'

# 6. M2.15 case: the written DB is in journal_mode delete (a single self-contained file, no WAL sidecar to lose when bundled)
nodetest_case "$WRITE_T" 'journal.?mode.*delete'

# 7. M2.15 case: the write is an atomic rename (temp file renamed into place; the target is never half-written)
nodetest_case "$WRITE_T" 'atomic.*rename|rename.*atomic'

# ---- M2.16 DB verifier --------------------------------------------------------------------------

# 8. M2.16 verifier exists and its whole suite is green with >= 1 real passing test
need_file scripts/gtfs/verify-db.ts
nodetest_nonempty "$VERIFY_T"

# 9. M2.16 case: the every-trip-has->=-2-stop-times check
nodetest_case "$VERIFY_T" '(2|two) stop.?time'

# 10. M2.16 case: the stop times are monotone check
nodetest_case "$VERIFY_T" 'monoton'

# 11. M2.16 case: the every-line-is-in-the-catalog check
nodetest_case "$VERIFY_T" 'catalog'

# 12. M2.16 case: the size < 6 MB limit
nodetest_case "$VERIFY_T" 'size|6 ?mb'

# 13. M2.16 case: a corrupted DB -> Err naming the failed check
nodetest_case "$VERIFY_T" 'corrupt'

# ---- M2.17 manifest -----------------------------------------------------------------------------

# 14. M2.17 manifest builder exists and its whole suite is green with >= 1 real passing test
need_file scripts/gtfs/manifest.ts
nodetest_nonempty "$MANIFEST_T"

# 15. M2.17 case: the manifest has every field
nodetest_case "$MANIFEST_T" 'every field|all fields'

# 16. M2.17 case: rail service-end epoch = start(end date) + 86400
nodetest_case "$MANIFEST_T" '86400'

# ---- M2.18 build CLI ----------------------------------------------------------------------------

# 17. M2.18 build CLI exists and its whole suite is green with >= 1 real passing test
need_file scripts/gtfs/build.ts
nodetest_nonempty "$BUILD_T"

# 18. M2.18 case: the mini feed -> BUILT
nodetest_case "$BUILD_T" 'built'

# 19. M2.18 case: a rerun -> UNCHANGED and the DB mtime is unchanged (nothing rewritten)
nodetest_case "$BUILD_T" 'unchanged.*mtime|mtime.*unchanged'

# 20. M2.18 case: --force gives the identical dbSha256
nodetest_case "$BUILD_T" 'force.*identical.*sha'

# 21. M2.18 package.json exposes the gtfs:build script
node -e 'const s=require("./package.json").scripts||{};if(!s["gtfs:build"]){console.error("ratchet: package.json has no gtfs:build script");process.exit(1)}'

# ---- M2.19 real build from the public county feed -------------------------------------------------

# 22. M2.19 real build from the public county GTFS zip (network, no key) exits 0 and reports BUILT or UNCHANGED
out=$(npm run gtfs:build 2>&1) || { echo "$out" | tail -30; echo "ratchet: npm run gtfs:build (real county feed) exited non-zero"; exit 1; }
grep -qE "BUILT|UNCHANGED" <<<"$out" || { echo "$out" | tail -15; echo "ratchet: gtfs:build printed neither BUILT nor UNCHANGED"; exit 1; }

# 23. M2.19 artifacts exist
need_file "$DB"
need_file "$MANIFEST"

# 24. M2.19 the verify-db CLI accepts the real DB (tsx from node_modules, never a silent npx download)
need_file "$DB"
need_file scripts/gtfs/verify-db.ts
local_bin tsx scripts/gtfs/verify-db.ts "$DB" || { echo "ratchet: verify-db did not accept $DB (non-zero exit)"; exit 1; }

# 25. M2.19 manifest values (plan V, hardened so a missing field fails instead of comparing undefined): rail ends 20261122, Mover ends 20261231, trips > 4000, dbBytes < 6e6
need_file "$MANIFEST"
node -e '
const m=require("./assets/db/manifest.json"),bad=[];
if(m.serviceEnd?.rail?.date!==20261122)bad.push("serviceEnd.rail.date="+JSON.stringify(m.serviceEnd?.rail?.date)+" (want 20261122)");
if(m.serviceEnd?.mover?.date!==20261231)bad.push("serviceEnd.mover.date="+JSON.stringify(m.serviceEnd?.mover?.date)+" (want 20261231)");
const t=m.counts?.trips;
if(typeof t!=="number"||!(t>4000))bad.push("counts.trips="+JSON.stringify(t)+" (want > 4000)");
if(typeof m.dbBytes!=="number"||!(m.dbBytes>0&&m.dbBytes<6e6))bad.push("dbBytes="+JSON.stringify(m.dbBytes)+" (want 0 < dbBytes < 6e6)");
if(bad.length){console.error("ratchet: manifest.json: "+bad.join("; "));process.exit(1)}'

# 26. M2.17 on the real manifest: service-end epoch (seconds) = start(end date, America/New_York) + 86400 — rail 1795410000, Mover 1798779600
need_file "$MANIFEST"
node -e '
const m=require("./assets/db/manifest.json"),bad=[];
for(const [k,v] of [["rail",1795410000],["mover",1798779600]]){const o=m.serviceEnd?.[k];
  if(!o||typeof o!=="object"||!Object.values(o).includes(v))bad.push("serviceEnd."+k+" has no epoch "+v+" (got "+JSON.stringify(o)+")")}
if(bad.length){console.error("ratchet: manifest.json service-end epochs: "+bad.join("; "));process.exit(1)}'

# 27. M2.19 a rerun prints UNCHANGED and writes nothing (schedule.db + manifest.json sha256 and mtime untouched)
need_file "$DB"
need_file "$MANIFEST"
before=$(snap)
out=$(npm run gtfs:build 2>&1) || { echo "$out" | tail -30; echo "ratchet: second npm run gtfs:build exited non-zero"; exit 1; }
grep -q UNCHANGED <<<"$out" || { echo "$out" | tail -15; echo "ratchet: second gtfs:build did not print UNCHANGED"; exit 1; }
after=$(snap)
[ "$before" = "$after" ] || { printf 'before:\n%s\nafter:\n%s\n' "$before" "$after"; echo "ratchet: the UNCHANGED rerun still rewrote $DB or $MANIFEST"; exit 1; }

# 28. M2.18 on the real feed: --force really rebuilds (prints BUILT) and reproduces a byte-identical schedule.db (deterministic build)
need_file "$DB"
sha_before=$(shasum -a 256 "$DB" | cut -d' ' -f1)
out=$(npm run gtfs:build -- --force 2>&1) || { echo "$out" | tail -30; echo "ratchet: npm run gtfs:build -- --force exited non-zero"; exit 1; }
grep -q BUILT <<<"$out" || { echo "$out" | tail -15; echo "ratchet: gtfs:build --force did not print BUILT"; exit 1; }
sha_after=$(shasum -a 256 "$DB" | cut -d' ' -f1)
[ "$sha_before" = "$sha_after" ] || { echo "ratchet: --force rebuild changed $DB ($sha_before -> $sha_after) — the build is not deterministic"; exit 1; }

# 29. The manifest describes the DB on disk: dbBytes = file size, dbSha256 = sha256(schedule.db)
need_file "$DB"
need_file "$MANIFEST"
node -e '
const fs=require("fs"),c=require("crypto"),m=require("./assets/db/manifest.json"),bad=[];
const b=fs.readFileSync("assets/db/schedule.db"),sha=c.createHash("sha256").update(b).digest("hex");
if(m.dbBytes!==b.length)bad.push("dbBytes="+JSON.stringify(m.dbBytes)+" but the file is "+b.length+" bytes");
if(m.dbSha256!==sha)bad.push("dbSha256="+JSON.stringify(m.dbSha256)+" but sha256(file)="+sha);
if(bad.length){console.error("ratchet: manifest.json does not describe schedule.db: "+bad.join("; "));process.exit(1)}'

# 30. M2.15 + §4 on the real DB: user_version 1, integrity_check ok, journal_mode delete, the 15 schema tables, trip.next_trip_idx, count(trip) = manifest counts.trips
need_file "$DB"
need_file "$MANIFEST"
node -e '
const {DatabaseSync}=require("node:sqlite"),m=require("./assets/db/manifest.json"),bad=[];
const d=new DatabaseSync("assets/db/schedule.db",{readOnly:true});
const uv=d.prepare("PRAGMA user_version").get().user_version;if(uv!==1)bad.push("user_version="+uv+" (want 1)");
const ic=d.prepare("PRAGMA integrity_check").get().integrity_check;if(ic!=="ok")bad.push("integrity_check="+ic);
const jm=d.prepare("PRAGMA journal_mode").get().journal_mode;if(jm!=="delete")bad.push("journal_mode="+jm+" (want delete)");
const have=new Set(d.prepare("SELECT name FROM sqlite_master WHERE type=?").all("table").map(r=>r.name));
const want="meta line station stop shape shape_point line_shape pattern pattern_stop service service_day service_day_active trip stop_time transfer".split(" ");
const miss=want.filter(t=>!have.has(t));if(miss.length)bad.push("missing tables: "+miss.join(","));
if(have.has("trip")){
  if(!d.prepare("PRAGMA table_info(trip)").all().some(r=>r.name==="next_trip_idx"))bad.push("trip has no next_trip_idx column");
  const n=d.prepare("SELECT count(*) AS n FROM trip").get().n;if(n!==m.counts?.trips)bad.push("count(trip)="+n+" but manifest counts.trips="+JSON.stringify(m.counts?.trips));
}
d.close();
if(bad.length){console.error("ratchet: schedule.db: "+bad.join("; "));process.exit(1)}'

# 31. M2.16 the verify-db CLI really checks: a copy whose stop_time table is emptied is rejected with an Err naming the stop-time check
#     (tsx presence is asserted first, so a missing runner can never pose as a rejection)
need_file "$DB"
need_file scripts/gtfs/verify-db.ts
local_bin tsx --version >/dev/null || exit 1
mkdir -p .cache
cp "$DB" .cache/ratchet-m2c-corrupt.db
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(".cache/ratchet-m2c-corrupt.db");d.exec("DELETE FROM stop_time");d.close()' \
  || { echo "ratchet: could not empty stop_time in the corrupt copy"; exit 1; }
if vout=$(local_bin tsx scripts/gtfs/verify-db.ts .cache/ratchet-m2c-corrupt.db 2>&1); then
  echo "$vout" | tail -15; echo "ratchet: verify-db accepted a DB whose trips have no stop times"; exit 1
fi
grep -qiE 'stop.?time' <<<"$vout" || { echo "$vout" | tail -15; echo "ratchet: verify-db rejected the corrupt copy but its Err does not name the stop-time check"; exit 1; }
rm -f .cache/ratchet-m2c-corrupt.db

# ---- M2.20 derivation report --------------------------------------------------------------------

# 32. M2.20 derivation report exits 0 (every ORANGE pattern has MIA, every GREEN pattern a Green-only station, >= 1 airport shuttle) and prints the pattern table
need_file scripts/gtfs/report.ts
out=$(local_bin tsx scripts/gtfs/report.ts 2>&1) || { echo "$out" | tail -30; echo "ratchet: scripts/gtfs/report.ts exited non-zero"; exit 1; }
grep -qi green <<<"$out" || { echo "$out" | tail -15; echo "ratchet: report printed no GREEN pattern rows"; exit 1; }
grep -qi orange <<<"$out" || { echo "$out" | tail -15; echo "ratchet: report printed no ORANGE pattern rows"; exit 1; }

# 33. The repo-wide gate
full_gate
