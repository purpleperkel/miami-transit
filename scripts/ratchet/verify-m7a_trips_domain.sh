#!/usr/bin/env bash
# m7a_trips_domain — walk estimate + leave-by (M7.1), countdown states (M7.2), user DB migrations + repos (M7.3), idempotent reminder plan (M7.4), and m3a's inputs: a no-service outcome distinct from needs-transfer, and loop-around rides a direct ride beats are dropped.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# ---- Card helpers. lib.sh has no multi-case jest pin, no DB-probed multi-case node:test pin, no non-test
# grep and no import check; everything else comes from lib.sh. Gates share no state: each gate line
# depends only on lib.sh and the constants + helpers below, never on another gate's output.

# ---- The card's case universe: every named acceptance case of this card, one case-insensitive JS regex on
# a test's FULL name (describe/suite titles + test title), grouped by the gate that pins it. A case is met
# only by a PASSED test, in the file its gate runs, whose full name matches exactly ONE pattern of this
# whole card: that case. A catch-all test named for several cases therefore counts for none of them, within
# a gate or across gates (gates 16 and 17 both run trip-rides.test.ts). Keep case keywords out of
# describe/suite titles.
CASES_WALK=('1000 m.*1000 s' 'override 7.*420 s')
CASES_LEAVE_BY=('departure 1000.*walk 300.*buffer 120.*leave-?by 580' 'past (the )?30 s grace.*next ride'
  'within (the )?30 s grace')
CASES_COUNTDOWN=('61 min.*clock' '30 min.*normal' '\b4 min.*soon' '\b30 s\b.*\bnow\b' '[-−]10 s.*missed')
CASES_EXPO_WRITES=('(run|exec)(Sync|Async)')
CASES_USER_DB=('migrations applied twice.*user_version' 'saved[ -]trips?.*crud round-?trips?'
  'settings?.*round-?trips?')
CASES_REMINDERS=('(≤|<=|at most) ?60 pending' 'within 7 days' 'no duplicate ids' 're-?apply.*empty diff')
CASES_NO_SERVICE=('MIA.*Brickell.*02:00.*no-service' 'MIA.*Brickell.*Sat 21:00.*needs-transfer')
CASES_LOOP_RIDES=('Knight Center.*College North.*loop.*dropped' 'Knight Center.*College North.*block.*kept')
CARD_CASES=("${CASES_WALK[@]}" "${CASES_LEAVE_BY[@]}" "${CASES_COUNTDOWN[@]}" "${CASES_EXPO_WRITES[@]}"
  "${CASES_USER_DB[@]}" "${CASES_REMINDERS[@]}" "${CASES_NO_SERVICE[@]}" "${CASES_LOOP_RIDES[@]}")

# Named-case checker shared by jest_cases and nodetest_cases_db (run it through cases_check, which hands it
# CARD_CASES). Every pattern must be a member of the universe and name >= 1 passing test of its own (above).
# argv: <jest|tap> <jest JSON report path | stdin (names one per line)> <where> <pattern>...
# env:  M7A_CARD_CASES = the universe, one pattern per line.
CASES_JS='
const fs = require("node:fs");
const [kind, src, where, ...pats] = process.argv.slice(1);
const fail = (m) => { console.log(`ratchet: ${where}: ${m}`); process.exit(1); };
const universe = (process.env.M7A_CARD_CASES ?? "").split("\n").filter((p) => p !== "");
if (pats.length === 0) fail("no case patterns given");
if (universe.length === 0) fail("authoring error: the card-wide case universe is empty");
const dups = universe.filter((p, i) => universe.indexOf(p) !== i);
if (dups.length > 0) fail(`authoring error: duplicate card cases /${dups.join("/, /")}/`);
const strays = pats.filter((p) => !universe.includes(p));
if (strays.length > 0) fail(`authoring error: /${strays.join("/, /")}/ is not in the card-wide case universe`);
let names;
if (kind === "jest") {
  const r = JSON.parse(fs.readFileSync(src, "utf8"));
  const bad = [];
  if (r.success !== true) bad.push("jest reported success=false");
  if (r.numFailedTests > 0 || r.numFailedTestSuites > 0 || r.numRuntimeErrorTestSuites > 0) bad.push("failing tests or suites");
  if (r.numPendingTests > 0 || r.numTodoTests > 0) bad.push("skipped/todo tests are forbidden");
  if (bad.length > 0) fail(bad.join("; "));
  names = r.testResults.flatMap((s) => s.assertionResults).filter((a) => a.status === "passed").map((a) => a.fullName);
} else {
  names = fs.readFileSync(0, "utf8").split("\n").filter((n) => n.trim() !== "");
}
if (names.length === 0) fail("no test passed");
const re = new Map(universe.map((p) => [p, new RegExp(p, "i")]));
const cases = (n) => universe.filter((p) => re.get(p).test(n));
const owns = (p) => names.some((n) => { const c = cases(n); return c.length === 1 && c[0] === p; });
const why = (p) => {
  const named = names.filter((n) => re.get(p).test(n));
  if (named.length === 0) return `/${p}/i: no passing test is named like it`;
  const also = named.slice(0, 3).map((n) => `"${n}" also matches /${cases(n).filter((q) => q !== p).join("/, /")}/`);
  return `/${p}/i: every passing test named like it also matches another card case (${also.join("; ")})`;
};
const missing = pats.filter((p) => !owns(p));
if (missing.length > 0) {
  console.log("passing tests:\n  " + names.slice(0, 40).join("\n  "));
  fail(`no passing test of its own (full name matching this case and no other case of the card): ${missing.map(why).join(" | ")}`);
}
console.log(`ok ${where}: ${names.length} passing; ${pats.length} named case(s), each its own test card-wide`);
'

# cases_check <jest|tap> <src> <where> <pattern>... — CASES_JS against the card-wide universe CARD_CASES.
cases_check() {
  M7A_CARD_CASES="$(printf '%s\n' "${CARD_CASES[@]}")" node -e "$CASES_JS" "$@"
}

# jest_cases <test-file> <pattern>... — ONE local-jest run of exactly that file with a JSON report: green,
# >= 1 passed, nothing failed/skipped/todo, and every pattern names a passing test of its own card-wide
# (cases_check).
# Why not lib's jest_nonempty <path> <name>: jest -t reports every test it filters out as skipped, which
# jest_nonempty (rightly) rejects, so -t cannot pin several cases of one file.
jest_cases() {
  local file="$1" report out rc=0
  shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  report=$(mktemp .cache/ratchet/m7a-jest.XXXXXX) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(local_bin jest --ci --runTestsByPath "$file" --json --outputFile="$report" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "$out" | tail -30
    rm -f "$report"
    echo "ratchet: jest red (or not installed) for $file"; return 1
  fi
  cases_check jest "$report" "$file" "$@" || rc=$?
  rm -f "$report"
  return "$rc"
}

# A probe imported before tsx: it wraps node:sqlite's DatabaseSync prepare/exec/createTagStore and logs,
# once per database, where every DB the test process touches lives (":memory:" for an in-memory DB).
REAL_DB="$(pwd -P)/assets/db/schedule.db"
DB_PROBE='data:text/javascript,import {DatabaseSync as D} from "node:sqlite";const seen=new Set();const log=(db)=>{const l=db.isOpen?(db.location()??":memory:"):"closed";if(!seen.has(l)){seen.add(l);process.stderr.write("ratchet-db-open: "+l+"\n")}};for(const k of ["prepare","exec","createTagStore"]){const f=D.prototype[k];if(typeof f==="function"){D.prototype[k]=function(...a){log(this);return f.apply(this,a)}}}'

# TAP on stdin -> the full name ("suite > … > leaf") of every REAL passing leaf, one per line. Same leaf
# rules as lib.sh's _nodetest_count (YAML type test; not SKIP/TODO; not a parent whose children ran; not
# Node 26's empty-file wrapper), but it prints the names so cases_check can check each case has its own test.
_m7a_passing_names() {
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

# nodetest_cases_db <file> <real|memory> <pattern>... — ONE unfiltered node:test run of the file under the
# DB probe: green, no fail/skip/todo/cancelled (lib's _nodetest_clean), every pattern names a passing test
# of its own card-wide (cases_check), and the DB rule holds:
#   real   — the run queried assets/db/schedule.db in place;
#   memory — the run queried >= 1 in-memory DB and NO on-disk DB.
nodetest_cases_db() {
  local file="$1" db="$2" out names
  shift 2
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  case "$db" in real|memory) ;; *) echo "ratchet: nodetest_cases_db: DB rule must be real or memory, got '$db'"; return 1 ;; esac
  out=$(node --import "$DB_PROBE" --import tsx --test --test-reporter=tap "$file" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: node:test red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  names=$(echo "$out" | _m7a_passing_names "$file") || { echo "ratchet: could not read test names from the TAP of $file"; return 1; }
  printf '%s\n' "$names" | cases_check tap stdin "$file" "$@" || return 1
  if [ "$db" = real ]; then
    grep -qF "ratchet-db-open: $REAL_DB" <<<"$out" \
      || { grep -F "ratchet-db-open:" <<<"$out" || echo "(no DB was queried)"; echo "ratchet: $file never queried $REAL_DB in place — these cases run on the real schedule DB"; return 1; }
    return 0
  fi
  grep -qF "ratchet-db-open: :memory:" <<<"$out" \
    || { grep -F "ratchet-db-open:" <<<"$out" || echo "(no DB was queried)"; echo "ratchet: $file never queried an in-memory DB — the user DB suite runs on :memory:"; return 1; }
  if grep -qF "ratchet-db-open: /" <<<"$out"; then
    grep -F "ratchet-db-open: /" <<<"$out"
    echo "ratchet: $file queried an on-disk DB — the user DB suite runs on :memory: only"; return 1
  fi
}

# need_src_re <ERE> <path>... — >= 1 non-test .ts/.tsx line (outside __tests__/__fixtures__) under the paths matches.
need_src_re() {
  local re="$1" p rc=0
  shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing $p"; return 1; }; done
  grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude-dir=__fixtures__ -- "$re" "$@" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  [ "$rc" -eq 1 ] && { echo "ratchet: expected /$re/ in non-test code under $*"; return 1; }
  echo "ratchet: grep failed (rc=$rc) scanning $*"; return 1
}

# need_import <file> <module-path-suffix> — the file imports that module (a `from '…<suffix>'` clause).
need_import() {
  local file="$1" mod="$2"
  grep -qE -- "from ['\"][^'\"]*${mod}['\"]" "$file" \
    || { echo "ratchet: $file does not import $mod — the suite must drive the real module"; return 1; }
}

# M7.3: the user DB modules ship in the app, so no non-test file under src/ imports node:sqlite or the
# Mac's executor (Metro cannot bundle node:sqlite). Requires the module, so an unbuilt tree fails as missing.
user_db_platform_neutral() {
  local hits rc=0
  need_file src/data/user-db.ts || return 1
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude-dir=__fixtures__ \
    -- "['\"](node:sqlite|[^'\"]*node-sql-executor)['\"]" src) || rc=$?
  [ "$rc" -eq 1 ] && return 0
  [ "$rc" -eq 0 ] && { echo "$hits" | head -5; echo "ratchet: app code under src/ imports node:sqlite or the Mac executor"; return 1; }
  echo "ratchet: grep failed (rc=$rc) scanning src/"; return 1
}

# M7.3 on the phone: the expo-sqlite twin of the executor gains the user DB's write path (expo-sqlite's
# run*/exec*), and its jest suite names a passing case for it.
expo_user_writes() {
  need_src_re '\.(run|exec)(Sync|Async)\(' src/data/expo-sql-executor.ts || return 1
  jest_cases src/data/__tests__/expo-sql-executor.test.ts "${CASES_EXPO_WRITES[@]}"
}

# M7.3's suite drives the REAL modules through the Mac's executor — it imports node-sql-executor and all
# three src/data modules (no test-local reimplementation) — and its named cases pass on :memory: only.
user_db_suite() {
  local t=scripts/gtfs/__tests__/user-db.test.ts m
  need_file "$t" || return 1
  for m in lib/node-sql-executor src/data/user-db src/data/saved-trips-repo src/data/settings-repo; do
    need_import "$t" "$m" || return 1
  done
  nodetest_cases_db "$t" memory "${CASES_USER_DB[@]}"
}

# The repo-wide gate, once this card's modules exist (on an unbuilt tree it would only re-prove m3a's green).
CARD_MODULES=(src/domain/trips/walk-estimate.ts src/domain/trips/leave-by.ts src/ui/trips/countdown.ts
  src/data/user-db.ts src/data/saved-trips-repo.ts src/data/settings-repo.ts src/domain/trips/notification-plan.ts)
full_gate_built() {
  local f
  for f in "${CARD_MODULES[@]}"; do need_file "$f" || return 1; done
  full_gate
}

# --- M7.1 Walk estimate + leave-by ---
# 1. The pure walk estimate lives where the plan puts it.
need_file src/domain/trips/walk-estimate.ts
# 2. The pure leave-by lives where the plan puts it.
need_file src/domain/trips/leave-by.ts
# 3. A (M7.1): 1000 m -> 1000 s; a 7-minute override -> 420 s — each its own passing test.
jest_cases src/domain/trips/__tests__/walk-estimate.test.ts "${CASES_WALK[@]}"
# 4. A (M7.1): departure 1000, walk 300, buffer 120 -> leaveBy 580; past the 30 s grace -> next ride; within it -> the same ride (pins 30 s from both sides).
jest_cases src/domain/trips/__tests__/leave-by.test.ts "${CASES_LEAVE_BY[@]}"

# --- M7.2 Countdown states ---
# 5. The countdown state module lives where the plan puts it.
need_file src/ui/trips/countdown.ts
# 6. A (M7.2): deltas 61 min / 30 min / 4 min / 30 s / -10 s -> clock / normal / soon / now / missed, each its own passing test.
jest_cases src/ui/trips/__tests__/countdown.test.ts "${CASES_COUNTDOWN[@]}"
# 7. Plan V (M7.2): `jest src/ui/trips` is non-empty, green, nothing skipped.
jest_nonempty src/ui/trips

# --- M7.3 User DB migrations + repos ---
# 8. The user DB and its two repos exist where the plan puts them.
for f in src/data/user-db.ts src/data/saved-trips-repo.ts src/data/settings-repo.ts; do need_file "$f"; done
# 9. The user DB is app code: no non-test file under src/ imports node:sqlite or the Mac executor.
user_db_platform_neutral
# 10. The phone can write the user DB: expo-sql-executor.ts calls expo-sqlite's run*/exec*, and a named jest case covers it.
expo_user_writes
# 11. A (M7.3): migrations applied twice -> same user_version; saved-trip CRUD round-trips; settings round-trip — node:test on :memory: only, through node-sql-executor, importing the real modules.
user_db_suite

# --- M7.4 Reminder plan (idempotent diff) ---
# 12. The pure reminder plan lives where the plan puts it.
need_file src/domain/trips/notification-plan.ts
# 13. A (M7.4): <= 60 pending; all within 7 days; no duplicate ids; re-applying gives an empty diff — each its own passing test.
jest_cases src/domain/trips/__tests__/notification-plan.test.ts "${CASES_REMINDERS[@]}"
# 14. Plan V (M7.1 + M7.4): `jest src/domain/trips` is non-empty, green, nothing skipped.
jest_nonempty src/domain/trips

# --- Inputs from m3a: no-service vs needs-transfer; loop-around rides ---
# 15. The no-service outcome is a kind in pure domain code (src/domain, non-test).
need_src_re "['\"]no-service['\"]" src/domain
# 16. Real DB: MIA -> Brickell at 02:00 (nothing leaves MIA) -> no-service; the same pair Sat 21:00 (only the shuttle runs) -> needs-transfer — each its own passing test, matching no other case of the card (gate 17's included).
nodetest_cases_db scripts/gtfs/__tests__/trip-rides.test.ts real "${CASES_NO_SERVICE[@]}"
# 17. Real DB: Knight Center -> College North, the 17-min Omni loop a 4-min direct Brickell ride beats is dropped; Inner Loop block-link rides nothing beats are kept — each its own passing test, matching no other case of the card (gate 16's included).
nodetest_cases_db scripts/gtfs/__tests__/trip-rides.test.ts real "${CASES_LOOP_RIDES[@]}"

# 18. Repo-wide gate (tsc app + scripts, eslint incl. src/domain purity, standards, jest, node:test), once this card's modules exist.
full_gate_built
