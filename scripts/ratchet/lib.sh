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
    out=$(npx jest --ci "$path" -t "$name" 2>&1) || { echo "$out" | tail -30; return 1; }
  else
    out=$(npx jest --ci "$path" 2>&1) || { echo "$out" | tail -30; return 1; }
  fi
  echo "$out" | grep -qE "Tests: +([0-9]+ skipped, )?[1-9][0-9]* passed" \
    || { echo "$out" | tail -15; echo "ratchet: no jest tests passed under '$path' ${name:+(-t '$name')}"; return 1; }
  if echo "$out" | grep -qE "Tests:.*[1-9][0-9]* skipped"; then
    echo "ratchet: skipped tests under '$path' — skipped tests are forbidden"; return 1
  fi
}

# node:test on a file that must exist; requires >=1 pass and 0 fail.
nodetest_nonempty() {
  local file="$1" out
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  out=$(node --import tsx --test --test-reporter=tap "$file" 2>&1) || { echo "$out" | tail -30; return 1; }
  echo "$out" | grep -qE "^# pass [1-9][0-9]*" || { echo "$out" | tail -15; echo "ratchet: no node:test passes in $file"; return 1; }
  echo "$out" | grep -qE "^# fail 0" || { echo "$out" | tail -15; echo "ratchet: failures in $file"; return 1; }
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
  npm run --silent verify || { echo "ratchet: npm run verify is red"; return 1; }
}

# iOS bundle export (proves Metro bundles the app; no Xcode needed).
ios_export() {
  local out
  out=$(npx expo export --platform ios --output-dir .cache/export 2>&1) || { echo "$out" | tail -30; return 1; }
  echo "$out" | grep -q "Exported: .cache/export" || { echo "$out" | tail -10; echo "ratchet: expo export did not report success"; return 1; }
}
