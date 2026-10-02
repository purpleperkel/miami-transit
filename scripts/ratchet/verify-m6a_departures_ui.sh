#!/usr/bin/env bash
# m6a_departures_ui — format + copy, LineBadge / MinutesLabel / FreshnessIndicator, DepartureRow + DirectionGroup with the live prediction merge (plan M6.1–M6.3).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# --- card-local helpers (lib.sh has no value oracle, no non-test regex need, no absence check, no card-guarded suite run) ---------
# Every gate below is ONE command and reads no variable another gate set. To run one gate alone, from
# the repo root (loads lib.sh + these helpers, then only that gate):
#   bash -c 'source scripts/ratchet/lib.sh; eval "$(sed -n "/^# --- card-local/,/^# --- M6.1/p" scripts/ratchet/verify-m6a_departures_ui.sh)"; <gate line>'

# Named-test pins use lib's `jest_nonempty <test file> '(^| )<exact phrase>$'`. jest compiles -t as
# new RegExp(pattern, 'i') and matches it against the FULL name (describe titles + test title, joined by
# one space), so the phrase must END the full name: one catch-all test cannot satisfy two pins, and an
# outer describe in front is fine. Phrases contain no regex metacharacters.

# ui_oracle <module> <call> <expected> — evaluates ONE plan-named call (e.g. `formatMinutes(29e3)`) on
# the real module under the repo's own jest (jest-expo/ios preset: the same babel transform and `@/`
# resolution as the app's tests) and requires exactly <expected>, compared as a string with ===. It does
# not depend on the builder's tests: a right-named test asserting the wrong value cannot pass it. The
# throwaway test file lives in the gitignored .cache and is removed whether the check passes or fails.
ui_oracle() {
  local module="$1" call="$2" want="$3" root dir out rc=0
  case "$call$want" in *\'*|*\\*|*\`*) echo "ratchet: ui_oracle arguments must not contain quotes, backticks or backslashes"; return 1 ;; esac
  need_file "$module" || return 1
  root="${call%%[.(]*}"
  dir="$PWD/.cache/ratchet-m6a-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/value.oracle.test.ts" <<EOF
import * as subject from '$PWD/${module%.*}';
const show = (v: unknown): string =>
  typeof v === 'string'
    ? JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    : typeof v + ' ' + String(v);
it('ratchet oracle', () => {
  const s = subject as unknown as Record<string, any>;
  if (!('$root' in s)) throw new Error('ratchet-oracle: $module has no export named $root (exports: ' + Object.keys(s).join(', ') + ')');
  const got: unknown = s.$call;
  if (got !== '$want') throw new Error('ratchet-oracle: $call returned ' + show(got) + ', expected ' + show('$want'));
  expect(got).toBe('$want');
});
EOF
  out=$(local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.ts' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 "ratchet-oracle:"; else echo "$out" | tail -25; fi
    echo "ratchet: $call in $module is not '$want'"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the oracle for $call did not run"; return 1; }
  echo "ratchet: oracle $call = '$want'"
}

# live_merge_spy <test file> <-t regex> — runs the named test(s) of ONE file with a spy on every
# top-level function export of src/domain/live/merge-departures.ts (m4a's M4.7 merge), and requires the
# test to pass AND the merge to have been CALLED while it ran. A grep cannot prove this: a type-only
# import (`import type { … } from …merge-departures`) or a merge re-implemented inside the UI both pass a
# grep and record 0 calls here. The spy is appended to the config's own setupFilesAfterEnv (never
# replaces them) and lives in the gitignored .cache, removed whether the check passes or fails.
live_merge_spy() {
  local file="$1" pat="$2" merge="src/domain/live/merge-departures.ts" dir out rc=0 calls line
  local after=()
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  need_file "$merge" || return 1
  while IFS= read -r line; do [ -n "$line" ] && after+=("$line"); done < <(local_bin jest --showConfig 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const f of JSON.parse(s).configs[0].setupFilesAfterEnv||[])console.log(f)})')
  dir="$PWD/.cache/ratchet-m6a-spy.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  : > "$dir/calls"
  cat > "$dir/merge-spy.js" <<EOF
jest.mock('$PWD/${merge%.ts}', () => {
  const real = jest.requireActual('$PWD/${merge%.ts}');
  const spied = { __esModule: true };
  for (const [name, value] of Object.entries(real)) {
    spied[name] = typeof value === 'function'
      ? (...args) => { require('fs').appendFileSync('$dir/calls', name + '\n'); return value(...args); }
      : value;
  }
  return spied;
});
EOF
  out=$(local_bin jest --ci --runTestsByPath "$file" -t "$pat" --setupFilesAfterEnv ${after[@]+"${after[@]}"} "$dir/merge-spy.js" 2>&1) || rc=$?
  calls=$(wc -l < "$dir/calls" | tr -d ' ')
  rm -rf "$dir"
  [ "$rc" -eq 0 ] || { echo "$out" | tail -25; echo "ratchet: tests matching /$pat/ are red in $file"; return 1; }
  echo "$out" | _qgrep -E "Tests: +([0-9]+ skipped, )?[1-9][0-9]* passed" \
    || { echo "$out" | tail -15; echo "ratchet: no jest test passed in $file (-t '$pat')"; return 1; }
  [ "$calls" -ge 1 ] \
    || { echo "ratchet: /$pat/ passed but never called $merge — the live merge must go through m4a's merge, not a type-only import or a UI re-implementation"; return 1; }
  echo "ratchet: /$pat/ passed; $merge called $calls time(s)"
}

# absent_src <ERE> <path>... — every path must exist, and NO non-test line under them may match.
# A function (not `! grep`) on purpose: bash's set -e ignores a failing `!`-negated command.
absent_src() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing $p"; return 1; }; done
  if grep -rqE --exclude-dir=__tests__ -- "$re" "$@"; then
    grep -rnE --exclude-dir=__tests__ -- "$re" "$@" | head -5
    echo "ratchet: forbidden /$re/ found in non-test code under $*"; return 1
  fi
}

# m6_full_gate — the repo-wide gate over the M6 code: every M6.1–M6.3 module exists (so tsc strict, eslint
# --max-warnings 0 and the standards checker — <= 60 lines, >= 2 invariants per named function, no
# recursion, no silent catch — actually ran over it), then `npm run verify` is green.
m6_full_gate() {
  local f
  for f in src/ui/format.ts src/ui/copy.ts src/ui/primitives/LineBadge.tsx src/ui/primitives/MinutesLabel.tsx \
           src/ui/primitives/FreshnessIndicator.tsx src/ui/departures/DepartureRow.tsx src/ui/departures/DirectionGroup.tsx; do
    need_file "$f" || return 1
  done
  full_gate
}

# m6_primitives_suite — plan V for M6.2 (`npx jest src/ui/primitives --ci`), guarded behind THIS card's own
# primitives. m5a's TText/Glass suites live in the same directory, so a bare directory run passes on m6a's
# unbuilt tree once m5a lands. Here each M6.2 component AND its test file must exist, jest must collect all
# three M6.2 test files (no testPathIgnorePatterns escape), and only then must the directory run be green,
# non-empty and skip-free — jest fails any collected suite that is red or has zero tests.
m6_primitives_suite() {
  local f listed
  for f in LineBadge MinutesLabel FreshnessIndicator; do
    need_file "src/ui/primitives/$f.tsx" || return 1
    need_file "src/ui/primitives/__tests__/$f.test.tsx" || return 1
  done
  listed=$(local_bin jest --ci --listTests src/ui/primitives 2>&1) \
    || { echo "$listed" | tail -15; echo "ratchet: jest --listTests src/ui/primitives failed"; return 1; }
  for f in LineBadge MinutesLabel FreshnessIndicator; do
    echo "$listed" | _qgrep -E "/src/ui/primitives/__tests__/$f\.test\.tsx$" \
      || { echo "ratchet: jest does not collect src/ui/primitives/__tests__/$f.test.tsx — plan V would never run it"; return 1; }
  done
  jest_nonempty src/ui/primitives
}

# --- M6.1 format + copy ---
# 1. A (oracle): formatMinutes(29e3) is exactly "Now" (a 29 s delta, in ms), on the real src/ui/format.ts.
ui_oracle src/ui/format.ts 'formatMinutes(29e3)' 'Now'
# 2. A (oracle): formatClockFromServiceSec(97200) is exactly "3:00 AM" (service time 27:00 wraps past midnight; plain ASCII space).
ui_oracle src/ui/format.ts 'formatClockFromServiceSec(97200)' '3:00 AM'
# 3. A (oracle): copy.leaveIn(0) is exactly "Leave now", on the real src/ui/copy.ts.
ui_oracle src/ui/copy.ts 'copy.leaveIn(0)' 'Leave now'
# 4. The builder's format suite pins formatMinutes(29e3) = "Now" by name, and passes.
jest_nonempty src/ui/__tests__/format.test.ts '(^| )formatMinutes 29 s is Now$'
# 5. The builder's format suite pins formatClockFromServiceSec(97200) = "3:00 AM" by name, and passes.
jest_nonempty src/ui/__tests__/format.test.ts '(^| )formatClockFromServiceSec 97200 is 3:00 AM$'
# 6. The builder's copy suite pins copy.leaveIn(0) = "Leave now" by name, and passes.
jest_nonempty src/ui/__tests__/copy.test.ts '(^| )copy leaveIn 0 is Leave now$'

# --- M6.2 LineBadge, MinutesLabel, FreshnessIndicator ---
# 7. A: LineBadge for GREEN carries the accessibility label "Green Line" (named render test passes).
jest_nonempty src/ui/primitives/__tests__/LineBadge.test.tsx '(^| )LineBadge GREEN has the accessibility label Green Line$'
# 8. LineBadge's label comes from LINE_CATALOG's name, not a hard-coded literal: LineBadge.tsx never spells "Green Line".
absent_src 'Green Line' src/ui/primitives/LineBadge.tsx
# 9. A: MinutesLabel renders a clock time, not minutes, for a departure more than 60 min away (named render test passes).
jest_nonempty src/ui/primitives/__tests__/MinutesLabel.test.tsx '(^| )MinutesLabel over 60 min renders a clock time$'
# 10. §4 "never color alone": FreshnessIndicator pairs an icon with a word for every status it shows (named render test passes).
jest_nonempty src/ui/primitives/__tests__/FreshnessIndicator.test.tsx '(^| )FreshnessIndicator pairs every status icon with a word$'
# 11. Plan V (M6.2), guarded: LineBadge / MinutesLabel / FreshnessIndicator .tsx and their __tests__/*.test.tsx exist
#     and are collected by jest, THEN `npx jest src/ui/primitives --ci` is green, non-empty, nothing skipped
#     (m5a's TText/Glass suites alone can no longer satisfy it).
m6_primitives_suite

# --- M6.3 DepartureRow + DirectionGroup (live predictions merged in) ---
# 12. A: when every row has the same source (all live or all scheduled), no row shows a per-row source icon.
jest_nonempty src/ui/departures/__tests__/DirectionGroup.test.tsx '(^| )DirectionGroup same-source rows show no per-row source icon$'
# 13. A (the other direction): when live and scheduled rows are mixed, each row shows its own source icon.
jest_nonempty src/ui/departures/__tests__/DirectionGroup.test.tsx '(^| )DirectionGroup mixed-source rows each show a source icon$'
# 14. A: given more departures than maxRows, DirectionGroup renders at most maxRows rows.
jest_nonempty src/ui/departures/__tests__/DirectionGroup.test.tsx '(^| )DirectionGroup renders at most maxRows rows$'
# 15. The row cap is the plan-named maxRows prop of DirectionGroup.
need 'maxRows' src/ui/departures/DirectionGroup.tsx
# 16. §4 rule 6 through m4a's merge: given a live prediction for a scheduled trip, DirectionGroup renders the predicted time (named test passes) AND src/domain/live/merge-departures.ts was called while it ran.
live_merge_spy src/ui/departures/__tests__/DirectionGroup.test.tsx '(^| )DirectionGroup live prediction replaces the scheduled time$'
# 17. §4 rule 6 + "never color alone": a canceled departure stays listed, struck through, and says "Canceled".
jest_nonempty src/ui/departures/__tests__/DepartureRow.test.tsx '(^| )DepartureRow canceled departure is struck through and says Canceled$'
# 18. Plan V (M6.3): `npx jest src/ui/departures --ci` is green, non-empty, nothing skipped.
jest_nonempty src/ui/departures

# --- cross-cutting ---
# 19. §4 step 10: the phone does no time-zone math — non-test M6 UI code has no Date-object clock or Intl time formatting.
absent_src '\.(toLocaleTimeString|toLocaleDateString|getHours|getUTCHours|getTimezoneOffset)\(|Intl\.DateTimeFormat|new Date\(' src/ui/format.ts src/ui/copy.ts src/ui/primitives src/ui/departures
# 20. Repo-wide gate over the M6 code: all seven M6 modules exist, then tsc + eslint + standards + jest + node:test are green.
m6_full_gate
