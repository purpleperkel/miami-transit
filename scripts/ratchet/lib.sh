#!/usr/bin/env bash
# Ratchet verify helpers — sourced by scripts/ratchet/verify-*.sh.
# Every helper fails LOUD with a named reason; a silent pass-with-nothing-run is the exact
# false green these scripts exist to prevent.
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"   # hooks/drivers do not source the zsh profile
export CI=1

# jest on a path that must contain >=1 test; optional -t name filter. Fails if no test ran.
jest_nonempty() {
  local path="$1" name="${2:-}" out
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  if [ -n "$name" ]; then
    out=$(local_bin jest --ci "$path" -t "$name" 2>&1) || { echo "$out" | tail -30; return 1; }
  else
    out=$(local_bin jest --ci "$path" 2>&1) || { echo "$out" | tail -30; return 1; }
  fi
  echo "$out" | grep -qE "Tests: +([0-9]+ skipped, )?[1-9][0-9]* passed" \
    || { echo "$out" | tail -15; echo "ratchet: no jest tests passed under '$path' ${name:+(-t '$name')}"; return 1; }
  # With -t, jest reports every test the NAME FILTER excluded as "skipped" — that is not a real
  # skip. Real it.skip/xit/.only are forbidden repo-wide by scripts/check/standards.ts (skipped-test).
  if [ -z "$name" ] && echo "$out" | grep -qE "Tests:.*[1-9][0-9]* skipped"; then
    echo "ratchet: skipped tests under '$path' — skipped tests are forbidden"; return 1
  fi
}

# --- node:test helpers -------------------------------------------------------------------
# Node 26 reports a test file with ZERO tests as one passing "test" named after the file
# ("ok 1 - x.test.ts", "# pass 1"), so counting "# pass" is a false green. These helpers count
# only real passing leaves (YAML `type: 'test'`, not suites, not SKIP/TODO, not the file wrapper)
# and match names against the FULL path "suite > … > leaf", case-insensitively.

_nodetest_run() {   # _nodetest_run <file> [name-pattern] -> TAP on stdout; .ts files load tsx
  local file="$1" pat="${2:-}"
  local args=(--test --test-reporter=tap)
  case "$file" in *.ts|*.tsx) args=(--import tsx "${args[@]}") ;; esac
  [ -n "$pat" ] && args+=("--test-name-pattern=/$pat/i")
  node "${args[@]}" "$file" 2>&1
}

_nodetest_count() { # stdin: TAP. $1 = lowercase ERE ('' = any), $2 = the file path as passed.
  # Counts passing REAL leaves: YAML type 'test', not SKIP/TODO, not a parent test() whose
  # t.test() children ran beneath it, and not Node 26's empty-file wrapper (which is named by
  # the path as given — with or without a leading ./ — or its absolute form or basename).
  awk -v re="$1" -v fp="$2" '
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
      full = ""
      for (i = 0; i <= okd; i += 4) full = full " " stack[i]
      if (re == "" || tolower(full) ~ re) n++
    }
    END { print n + 0 }'
}

_nodetest_clean() { # stdin: TAP. fails unless 0 fail, 0 skipped, 0 todo, 0 cancelled
  local out; out=$(cat)
  for k in fail skipped todo cancelled; do
    echo "$out" | grep -qE "^# $k 0$" || { echo "$out" | tail -15; echo "ratchet: '# $k' is not 0 — failing/skipped/todo tests are forbidden"; return 1; }
  done
}

# node:test file must exist, run green, and contain >=1 real passing test (no skips/todos).
nodetest_nonempty() {
  local file="$1" out n
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  out=$(_nodetest_run "$file") || { echo "$out" | tail -30; echo "ratchet: node:test red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  n=$(echo "$out" | _nodetest_count "" "$file")
  [ "$n" -ge 1 ] || { echo "$out" | tail -10; echo "ratchet: $file has no real passing tests (empty file reports as a wrapper pass on Node 26)"; return 1; }
}

# >= min passing tests whose full name ("suite … leaf") matches /pattern/i. Default min 1.
nodetest_case() {
  local file="$1" pat="$2" min="${3:-1}" out n lc
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  out=$(_nodetest_run "$file" "$pat") || { echo "$out" | tail -30; echo "ratchet: tests matching /$pat/i are red in $file"; return 1; }
  echo "$out" | _nodetest_clean || return 1
  lc=$(printf '%s' "$pat" | tr '[:upper:]' '[:lower:]')
  n=$(echo "$out" | _nodetest_count "$lc" "$file")
  [ "$n" -ge "$min" ] || { echo "$out" | tail -10; echo "ratchet: $n passing test(s) named /$pat/i in $file — need >= $min"; return 1; }
}

# Run a locally installed tool (never let a bare npx silently download a missing one).
local_bin() {
  local name="$1"; shift
  [ -x "node_modules/.bin/$name" ] \
    || { echo "ratchet: $name is not installed in node_modules — install it as a devDependency" >&2; return 1; }
  "node_modules/.bin/$name" "$@"
}

# Plain-string artifact grep with a named failure.
need() {
  local pattern="$1"; shift
  grep -rqF -- "$pattern" "$@" \
    || { echo "ratchet: expected artifact not found: '$pattern' in $*"; return 1; }
}

# Required file.
need_file() {
  [ -f "$1" ] || { echo "ratchet: missing file $1"; return 1; }
}

# The repo-wide gate (exists once m1a_guardrails lands).
full_gate() {
  npm run verify || { echo "ratchet: npm run verify is red"; return 1; }
}

# iOS bundle export (proves Metro bundles the app; no Xcode needed).
ios_export() {
  local out
  out=$(npx expo export --platform ios --output-dir .cache/export 2>&1) || { echo "$out" | tail -30; return 1; }
  echo "$out" | grep -q "Exported: .cache/export" || { echo "$out" | tail -10; echo "ratchet: expo export did not report success"; return 1; }
}
