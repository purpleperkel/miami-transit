#!/usr/bin/env bash
# m9a_feed_ops — read-only feed change check (exit 0 unchanged / 10 changed), one-command gtfs:refresh, byte-identical --force rebuild of the committed DB on the real county feed (plan M9.1–M9.3)
# Every numbered gate is self-contained: after `cd <repo> && source scripts/ratchet/lib.sh` plus the
# prelude below (constants + card helpers), any single gate runs alone and is judged on its own output.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

DB=assets/db/schedule.db
MANIFEST=assets/db/manifest.json
T=scripts/gtfs/__tests__/check-feed.test.ts
# A closed local port. With NODE_USE_ENV_PROXY=1, Node's built-in fetch and node:http(s) route through it
# and fail with ECONNREFUSED: the network-failure branch is forced without touching the county host.
DEAD_PROXY=http://127.0.0.1:9

# sha256 + mtime of the committed DB and manifest (proves a step wrote nothing to assets/db)
snap() {
  node -e 'const fs=require("fs"),c=require("crypto");for(const f of process.argv.slice(1)){console.log(f,c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"),fs.statSync(f).mtimeMs)}' "$DB" "$MANIFEST"
}

# mtime (ms) of one file (proves a step really rewrote it)
mtime_ms() {
  node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$1"
}

# Run the real check-feed CLI with the local tsx; sets cf_out and cf_code without tripping set -e (10 is a
# legal answer). `run_check_feed offline` forces the network-failure branch through DEAD_PROXY.
run_check_feed() {
  need_file scripts/gtfs/check-feed.ts || return 1
  local_bin tsx --version >/dev/null || return 1   # a missing tsx must not pose as a check-feed exit code
  cf_code=0
  if [ "${1:-}" = offline ]; then
    cf_out=$(unset NO_PROXY no_proxy
      export NODE_USE_ENV_PROXY=1 HTTPS_PROXY="$DEAD_PROXY" HTTP_PROXY="$DEAD_PROXY" https_proxy="$DEAD_PROXY" http_proxy="$DEAD_PROXY"
      local_bin tsx scripts/gtfs/check-feed.ts 2>&1) || cf_code=$?
  else
    cf_out=$(local_bin tsx scripts/gtfs/check-feed.ts 2>&1) || cf_code=$?
  fi
  printf '%s\n' "$cf_out" | tail -5
  echo "check-feed${1:+ ($1)} exit code: $cf_code"
}

# Run the real one-command refresh; sets rf_out. The script's presence is checked first because
# `npm run --silent` prints nothing at all for a missing script.
run_refresh() {
  node -e 'const s=(require("./package.json").scripts||{})["gtfs:refresh"];if(typeof s!=="string"||!s.trim()){console.error("ratchet: package.json has no gtfs:refresh script");process.exit(1)}' || return 1
  rf_out=$(npm run --silent gtfs:refresh 2>&1) || { printf '%s\n' "$rf_out" | tail -30; echo "ratchet: npm run gtfs:refresh exited non-zero"; return 1; }
}

# 1. M9.1 the feed-check CLI exists where the plan puts it
need_file scripts/gtfs/check-feed.ts

# 2. M9.1 the check-feed suite forces its branches offline: it drives a real local node:http server (createServer) and never names the county host
need_file "$T"
need node:http "$T"
need createServer "$T"
if grep -qiF miamidade.gov "$T"; then echo "ratchet: $T references the county host — the branch tests must run against a local server, not the network"; exit 1; fi

# 3. M9.1 the check-feed suite is green with >= 3 real passing tests and 0 fail/skip/todo/cancelled (Node 26's empty-file wrapper pass does not count)
nodetest_case "$T" '.' 3

# 4. M9.1 an "unchanged" case passes (the exit 0 branch)
nodetest_case "$T" 'unchanged'

# 5. M9.1 a "changed" case passes that is not the unchanged one (the exit 10 branch): "changed" not preceded by "un"
nodetest_case "$T" '(^|[^n])changed'

# 6. M9.1 an "error" case passes (a server/network failure must exit neither 0 nor 10); "err"/"error"/"errors" as a word, so "stderr" does not count
nodetest_case "$T" '(^|[^a-z])err(ors?)?([^a-z]|$)'

# 7. M9.1 plan V on the real CLI, read-only: on the live county feed check-feed exits 0 or 10; with the network forced dead it exits neither; neither run changes schedule.db/manifest.json (sha256 + mtime) or the repo's git status
need_file scripts/gtfs/check-feed.ts
need_file "$DB"
need_file "$MANIFEST"
before=$(snap)
status_before=$(git status --porcelain)
run_check_feed
[ "$cf_code" -eq 0 ] || [ "$cf_code" -eq 10 ] || { echo "ratchet: check-feed exited $cf_code on the live feed — only 0 (unchanged) or 10 (changed) are legal"; exit 1; }
run_check_feed offline
if [ "$cf_code" -eq 0 ] || [ "$cf_code" -eq 10 ]; then echo "ratchet: with the network forced dead (proxy $DEAD_PROXY) check-feed still exited $cf_code — a failed check must exit neither 0 (unchanged) nor 10 (changed)"; exit 1; fi
after=$(snap)
[ "$before" = "$after" ] || { printf 'before:\n%s\nafter:\n%s\n' "$before" "$after"; echo "ratchet: check-feed rewrote $DB or $MANIFEST — a check must not write (recording the new ETag/sha would swallow the change before any rebuild)"; exit 1; }
[ "$status_before" = "$(git status --porcelain)" ] || { git status --porcelain; echo "ratchet: check-feed changed the repo's git status (modified a tracked file or left a new unignored file)"; exit 1; }

# 8. M9.2 package.json gtfs:refresh chains build -> verify-db -> report, in that order, with no ; | || or lone & (a failing step must stop the chain and fail the refresh)
node -e '
const s=(require("./package.json").scripts||{})["gtfs:refresh"];
if(typeof s!=="string"||!s.trim()){console.error("ratchet: package.json has no gtfs:refresh script");process.exit(1)}
const at=[["build",s.search(/build/)],["verify-db",s.search(/verify-db/)],["report",s.search(/report/)]],bad=[];
const miss=at.filter(([,i])=>i<0).map(([k])=>k);
if(miss.length)bad.push("missing step(s): "+miss.join(", "));
else if(!(at[0][1]<at[1][1]&&at[1][1]<at[2][1]))bad.push("steps out of order (want build -> verify-db -> report)");
if(/[;|]|(^|[^&])&(?!&)/.test(s))bad.push("contains ; | || or a lone & — a failing step could be masked");
if(bad.length){console.error("ratchet: gtfs:refresh = "+JSON.stringify(s)+": "+bad.join("; "));process.exit(1)}'

# 9. M9.2 plan V: npm run gtfs:refresh exits 0 on the real feed; its output carries the build verdict (BUILT|UNCHANGED) and the report's GREEN and ORANGE pattern rows
run_refresh
grep -qE "BUILT|UNCHANGED" <<<"$rf_out" || { printf '%s\n' "$rf_out" | tail -15; echo "ratchet: gtfs:refresh printed no build verdict (BUILT or UNCHANGED)"; exit 1; }
grep -qi green <<<"$rf_out" || { printf '%s\n' "$rf_out" | tail -15; echo "ratchet: gtfs:refresh printed no GREEN pattern rows (report step missing?)"; exit 1; }
grep -qi orange <<<"$rf_out" || { printf '%s\n' "$rf_out" | tail -15; echo "ratchet: gtfs:refresh printed no ORANGE pattern rows (report step missing?)"; exit 1; }

# 10. M9.1 truthfulness on real data: right after its own successful gtfs:refresh the DB reflects the live feed, so check-feed must exit exactly 0 (catches an always-10 check and ETag-only comparisons that flap)
run_refresh
run_check_feed
[ "$cf_code" -eq 0 ] || { echo "ratchet: check-feed exited $cf_code right after a successful gtfs:refresh — want 0 (unchanged)"; exit 1; }

# 11. M9.3 plan V in one gate: schedule.db + manifest.json are tracked (else the diff is vacuous); build.ts --force exits 0, prints BUILT and really rewrites schedule.db (mtime moves); the result is byte-identical to the index (git diff --exit-code assets/db) and assets/db is clean against HEAD (nothing staged, no leftover temp/backup file)
need_file scripts/gtfs/build.ts
need_file "$DB"
need_file "$MANIFEST"
git ls-files --error-unmatch -- "$DB" "$MANIFEST" >/dev/null 2>&1 || { echo "ratchet: $DB and/or $MANIFEST are not tracked by git — the determinism diff would be vacuous"; exit 1; }
mt_before=$(mtime_ms "$DB")
out=$(local_bin tsx scripts/gtfs/build.ts --force 2>&1) || { printf '%s\n' "$out" | tail -30; echo "ratchet: tsx scripts/gtfs/build.ts --force exited non-zero"; exit 1; }
grep -q BUILT <<<"$out" || { printf '%s\n' "$out" | tail -15; echo "ratchet: build.ts --force did not print BUILT"; exit 1; }
need_file "$DB"
mt_after=$(mtime_ms "$DB")
[ "$mt_before" != "$mt_after" ] || { echo "ratchet: build.ts --force left $DB untouched (mtime $mt_before) — the determinism diff would be vacuous"; exit 1; }
git diff --exit-code --stat -- assets/db || { echo "ratchet: the --force rebuild differs from the tracked assets/db — the build is not deterministic on the real feed (or a refreshed DB was never committed)"; exit 1; }
st=$(git status --porcelain -- assets/db)
[ -z "$st" ] || { echo "$st"; echo "ratchet: assets/db is not clean against HEAD after the --force rebuild (staged-but-uncommitted change or a leftover untracked file)"; exit 1; }

# 12. The repo-wide gate
full_gate
