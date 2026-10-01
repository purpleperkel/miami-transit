#!/usr/bin/env bash
# m3b_positions_provider — scheduled positions (M3.5), real-DB snapshot (M3.6), expiry (M3.7), schedule DB provider + probe DB retired (M3.8)
# Every gate line is one simple command: under `set -e`, a failing non-final command in `a && b`
# does NOT stop the script, so compound checks live inside the helpers below.
# Run one gate alone: bash -c 'source scripts/ratchet/verify-m3b_positions_provider.sh; <gate>'
# (sourcing defines lib.sh + the card helpers and stops before gate 1).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# ---- Card helpers (each fails loud with a named reason, like lib.sh) ----

# Named jest acceptance cases. lib.sh's `jest_nonempty <path> <name>` cannot do this: jest reports
# every test that -t filters out as skipped, which jest_nonempty rejects. So: run unfiltered with
# --json; each label (case-insensitive regex on describe + it) must name >=1 PASSED test, and
# nothing may fail, be skipped or be todo.
jest_cases() {
  local path="$1" report out rc=0; shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  report=$(mktemp) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(npx jest --ci "$path" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; rm -f "$report"; return 1; }
  node -e '
    const [file, where, ...labels] = process.argv.slice(1);
    const r = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const names = r.testResults.flatMap((t) => t.assertionResults)
      .filter((a) => a.status === "passed").map((a) => a.fullName);
    if (r.numFailedTests || r.numPendingTests || r.numTodoTests || names.length === 0) {
      console.log(`ratchet: ${where}: ${names.length} passed, ${r.numFailedTests} failed, ${r.numPendingTests} skipped, ${r.numTodoTests} todo`);
      process.exit(1);
    }
    const missing = labels.filter((l) => !names.some((n) => new RegExp(l, "iu").test(n)));
    if (missing.length) {
      console.log(`ratchet: ${where}: no PASSED test whose name matches: ${missing.join("  |  ")}`);
      console.log(`passed tests: ${names.join("  ;  ")}`);
      process.exit(1);
    }
    console.log(`OK ${labels.length} named cases passed in ${where}`);
  ' "$report" "$path" "$@" || rc=1
  rm -f "$report"
  return "$rc"
}

# Named node:test cases on the REAL schedule DB, in one run. lib.sh's nodetest_nonempty is not
# enough here: Node 26 reports a test file with zero tests as "# pass 1". So: each pattern
# (case-insensitive ERE on suite names + test name) must name >=1 passing, non-skipped test;
# nothing fails, skips or is todo; and the run queried assets/db/schedule.db in place (a probe on
# DatabaseSync.prototype.prepare logs every DB file the test process queries).
REAL_DB="$(pwd -P)/assets/db/schedule.db"
DB_PROBE='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const prep=D.prototype.prepare;D.prototype.prepare=function(...a){const l=this.isOpen?String(this.location()):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}return prep.apply(this,a)};'
nodetest_real_cases() {
  local file="$1" out names p; shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  out=$(node --import tsx --import "$DB_PROBE" --test --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: failures in $file"; return 1; }
  grep -qE '^# fail 0$' <<<"$out" && grep -qE '^# skipped 0$' <<<"$out" && grep -qE '^# todo 0$' <<<"$out" \
    || { echo "$out" | tail -12; echo "ratchet: $file has failing, skipped or todo tests"; return 1; }
  names=$(awk '
    { match($0, /^ */); d = RLENGTH; line = substr($0, d + 1) }
    line ~ /^# Subtest: / { nm = line; sub(/^# Subtest: /, "", nm); stack[d] = nm; next }
    line ~ /^ok [0-9]+ - / { okd = d; okline = line; pending = 1; next }
    line ~ /^not ok / { pending = 0; next }
    pending && line ~ /^type: / {
      pending = 0
      if (line !~ /test/ || okline ~ / # (SKIP|TODO)/) next
      full = ""; for (i = 0; i <= okd; i += 4) full = full " " stack[i]
      print substr(full, 2)
    }' <<<"$out")
  for p in "$@"; do
    grep -qiE -- "$p" <<<"$names" \
      || { echo "passing tests: ${names:-(none)}"; echo "ratchet: no passing test named /$p/i in $file"; return 1; }
  done
  grep -qF "ratchet-db-open: $REAL_DB" <<<"$out" \
    || { grep -F "ratchet-db-open:" <<<"$out" || echo "(no DB was queried)"; echo "ratchet: $file never queried $REAL_DB — M3.6 must run on the real DB, in place"; return 1; }
}

# M3.8: the provider exists and a non-test module under src/ imports it (mounted, not dead code).
provider_imported() {
  local rc=0
  need_file src/data/schedule-db-provider.tsx || return 1
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude=schedule-db-provider.tsx \
    "schedule-db-provider(\.tsx)?['\"]" src || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: no module under src/ imports schedule-db-provider — the provider is dead code"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning src/ for schedule-db-provider importers"; return 1
}

# M3.8: the provider replaced the M1.14 probe DB — no probe.db, no scripts/probe/, and no reference
# to either outside scripts/ratchet (the m1c card's verify legitimately names them). The provider
# file is the precondition, so this gate cannot pass on a repo where nothing was built.
probe_retired() {
  local targets=(src scripts package.json) rc=0 hits
  need_file src/data/schedule-db-provider.tsx || return 1
  [ ! -e assets/db/probe.db ] || { echo "ratchet: assets/db/probe.db still exists — M3.8 removes the probe DB"; return 1; }
  [ ! -e scripts/probe ] || { echo "ratchet: scripts/probe/ still exists — M3.8 removes the probe generator"; return 1; }
  if [ -f metro.config.js ]; then targets+=(metro.config.js); fi
  hits=$(grep -rlE --exclude-dir=ratchet 'probe\.db|make-probe-db|scripts/probe/' "${targets[@]}") || rc=$?
  [ "$rc" -eq 1 ] && return 0
  [ "$rc" -eq 0 ] && { echo "ratchet: the probe DB is still referenced in: $hits"; return 1; }
  echo "ratchet: grep failed (rc=$rc) while scanning for probe DB references"; return 1
}

# Reads the export that ios_export just wrote (gate 11): the iOS bundle ships exactly one db asset, byte-identical
# to assets/db/schedule.db (so the schedule DB reaches the phone and the probe DB does not).
bundle_ships_schedule_db() {
  need_file .cache/export/metadata.json || return 1
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    const meta = JSON.parse(fs.readFileSync(".cache/export/metadata.json", "utf8"));
    const dbs = meta.fileMetadata.ios.assets.filter((a) => a.ext === "db");
    if (dbs.length !== 1) {
      console.log(`ratchet: the iOS export ships ${dbs.length} db assets; expected exactly 1 (schedule.db; probe.db retired)`);
      process.exit(1);
    }
    if (!fs.existsSync("assets/db/schedule.db")) { console.log("ratchet: missing file assets/db/schedule.db"); process.exit(1); }
    if (sha(".cache/export/" + dbs[0].path) !== sha("assets/db/schedule.db")) {
      console.log(`ratchet: the bundled db asset ${dbs[0].path} is not byte-identical to assets/db/schedule.db`);
      process.exit(1);
    }
    console.log(`OK the iOS bundle ships schedule.db as ${dbs[0].path}`);
  '
}

# Sourced rather than executed: helpers are defined; run no gate.
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0

# --- M3.5 Position interpolation ---
# 1. The pure positions module exists where the plan puts it.
need_file src/domain/schedule/positions.ts
# 2. Its jest suite runs >=1 test, all pass, none skipped.
jest_nonempty src/domain/schedule/__tests__/positions.test.ts
# 3. Each acceptance case is a PASSED, named test: midpoint time -> shape midpoint ±1 m; before start -> none;
#    a block gap <= 600 s -> layover.
jest_cases src/domain/schedule/__tests__/positions.test.ts 'midpoint' 'before start' 'layover'

# --- M3.6 Snapshot on the real DB ---
# 4. Wed 08:00 -> 8–30 rail and 10–40 Mover vehicles, all <= 50 m from their shape: named passing tests,
#    nothing skipped, and the run queried assets/db/schedule.db in place.
nodetest_real_cases scripts/gtfs/__tests__/positions-real.test.ts 'Wed 08:00.*rail' 'Wed 08:00.*mover' '50 ?m'

# --- M3.7 Expiry ---
# 5. The pure expiry module exists where the plan puts it.
need_file src/domain/expiry/expiry.ts
# 6. Its jest suite runs >=1 test, all pass, none skipped.
jest_nonempty src/domain/expiry
# 7. Each state is a PASSED, named test (> 14 days ok; <= 14 warn; <= 3 urgent; < 0 expired), for both modes.
jest_cases src/domain/expiry '\bok\b' 'warn' 'urgent' 'expired' 'rail' 'mover'

# --- M3.8 Schedule DB provider ---
# 8. src/data/schedule-db-provider.tsx exists and a non-test module imports it.
provider_imported
# 9. The probe DB is retired: assets/db/probe.db and scripts/probe/ are absent and unreferenced.
probe_retired

# 10. Repo-wide gate: tsc (app + scripts), eslint --max-warnings 0, standards, jest, node:test.
full_gate

# 11. Metro bundles the app for iOS, and that bundle ships exactly one db asset, byte-identical to
#     assets/db/schedule.db (the provider's DB reaches the phone; the probe DB does not).
ios_export
bundle_ships_schedule_db

echo "m3b_positions_provider: all 11 gates green"
