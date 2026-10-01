#!/usr/bin/env bash
# m4b_live_runtime — realtime runtime (expo/fetch HTTP + byte counter, Keychain keys, providers, polling
# hook, context) and the embedded-key guard wired into publish (plan M4.8–M4.10).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# NOTE: under `set -e`, a failure on the LEFT of `&&` does not stop the script, so every check below is
# its own statement. Each gate either passes or exits with a named reason. Every gate runs ALONE after
# `source lib.sh` + this prelude: no gate reads a variable or a file another gate created.

GUARD=scripts/check/embedded-keys.ts
WORK=.cache/ratchet-m4b          # gitignored scratch for planted bundles; only ever holds fake values
rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Fake, key-shaped values generated per run. Real keys are never read, printed or required here.
FAKE="ratchetfake$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
FAKE2="ratchetfake$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
# Expo's public env prefix, assembled from pieces so this tracked file never contains a
# public-prefixed key token that `--tree` would (correctly) flag.
PUB="EXPO_""PUBLIC_"
PUBLIC_NAME="${PUB}RATCHET_PLANT_KEY"
# A bundle payload with no leak: the agency key value, provider hosts and header NAMES only.
CLEAN_PAYLOAD='agency="miami";host="api.goswift.ly";hdr="apikey";auth="Authorization";'

# --- card-specific helpers (lib.sh has no regex need, absence check, multi-case jest pin, or guard
#     harness; everything else comes from lib.sh) -----------------------------------------------------

# need_re <ERE> <path>... — every path must exist, and >= 1 non-test line under them must match.
need_re() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing file $p"; return 1; }; done
  grep -rqE --exclude-dir=__tests__ -- "$re" "$@" || { echo "ratchet: expected /$re/ not found in $*"; return 1; }
}

# absent <ERE> <path>... — every path must exist, and nothing under them may match.
# A function (not `! grep`) on purpose: bash's `set -e` ignores a failing `!`-negated command.
absent() {
  local re="$1" p; shift
  for p in "$@"; do [ -e "$p" ] || { echo "ratchet: missing file $p"; return 1; }; done
  if grep -rqE -- "$re" "$@"; then
    grep -rnE -- "$re" "$@" | head -5
    echo "ratchet: forbidden /$re/ found in $*"; return 1
  fi
}

# jest_cases <test-file> <ERE>... — ONE local-jest run of that exact file with a JSON report; passes
# only if jest is green, >= 1 test passed, none failed/skipped/todo, and EVERY <ERE> matches
# (case-insensitively) the full name (describe titles + test title) of >= 1 test, all of which passed.
# Why not lib's jest_nonempty "<file>" "<name>": a jest -t filter marks every test it excludes as
# skipped, and jest_nonempty (rightly) forbids skipped tests, so -t cannot pin several cases in one file.
jest_cases() {
  local file="$1" report out
  shift
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  [ "$#" -ge 1 ] || { echo "ratchet: jest_cases needs at least one case pattern"; return 1; }
  report="$PWD/$WORK/jest-cases.$(basename "$file").json"
  rm -f "$report"
  out=$(local_bin jest --ci --runTestsByPath "$file" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; echo "ratchet: jest red (or not installed) for $file"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; echo "ratchet: jest wrote no JSON report for $file"; return 1; }
  node - "$file" "$report" "$@" <<'NODE' || return 1
const fs = require("node:fs");
const [file, report, ...wanted] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(report, "utf8"));
const tests = r.testResults.flatMap((suite) => suite.assertionResults);
const problems = [];
if (r.success !== true) problems.push("jest reported success=false");
if (r.numPassedTests < 1) problems.push("no test passed");
if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) problems.push("failing tests/suites");
if (r.numPendingTests > 0 || r.numTodoTests > 0) problems.push("skipped/todo tests are forbidden");
for (const pat of wanted) {
  const re = new RegExp(pat, "i");
  const hits = tests.filter((t) => re.test(t.fullName));
  if (hits.length === 0) problems.push(`no test named /${pat}/i`);
  else if (hits.some((t) => t.status !== "passed")) problems.push(`a test named /${pat}/i did not pass`);
}
if (problems.length > 0) {
  console.log(`ratchet: ${file}: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`ratchet: ${file}: ${r.numPassedTests} passed; named cases: /${wanted.join("/, /")}/`);
NODE
}

# plant_bundle <dir> <payload> — a Hermes-shaped bundle (HBC magic + NUL bytes around the payload) in
# the real export layout, so a guard that only globs *.js or skips binary files scans nothing and is
# caught.
plant_bundle() {
  local dir="$1" payload="$2" js="$1/_expo/static/js/ios"
  mkdir -p "$js"
  { printf '\xc6\x1f\xbc\x03\xc1\x03\x19\x1f\x00\x00'; printf '%s' "$payload"; printf '\x00\x00'; } \
    > "$js/entry-ratchet.hbc"
  printf '{"version":0,"bundler":"metro","fileMetadata":{"ios":{"bundle":"_expo/static/js/ios/entry-ratchet.hbc","assets":[]}}}\n' \
    > "$dir/metadata.json"
}

# guard_ready — the guard file exists and tsx is installed locally (M1.1). Runs before EVERY guard
# invocation, so a missing guard fails as 'missing file', never as a misleading behaviour message.
guard_ready() {
  need_file "$GUARD" || return 1
  local_bin tsx --version >/dev/null || return 1
}

# guard_run <args> — the guard with FAKE-ONLY key env (empty SWIFTLY_API_KEY, the non-secret agency
# key); sets OUT and RC. Returns 1 only when the guard cannot be run at all.
guard_run() {
  guard_ready || return 1
  RC=0
  OUT=$(TRANSITLAND_API_KEY="$FAKE" SWIFTLY_API_KEY= SWIFTLY_AGENCY_KEY=miami \
    local_bin tsx "$GUARD" "$@" 2>&1) || RC=$?
}

# guard_real <args> — the guard in the real environment, exactly as `npm run publish` runs it (the
# guard loads key values itself; this script never reads, requires or prints them); sets OUT and RC.
guard_real() {
  guard_ready || return 1
  RC=0
  OUT=$(local_bin tsx "$GUARD" "$@" 2>&1) || RC=$?
}

# expect_caught <value> <what> <name>... — the last guard run failed, named every leak, and never
# echoed the planted value.
expect_caught() {
  local value="$1" what="$2" name; shift 2
  [ "$RC" -ne 0 ] || { tail -15 <<<"$OUT"; echo "ratchet: guard exited 0 although $what was planted"; return 1; }
  for name in "$@"; do
    grep -qF -- "$name" <<<"$OUT" \
      || { tail -15 <<<"$OUT"; echo "ratchet: guard failed but did not name '$name' ($what)"; return 1; }
  done
  if grep -qF -- "$value" <<<"$OUT"; then
    echo "ratchet: guard printed the planted value ($what) — name the variable, never echo the value"; return 1
  fi
}

# expect_clean <dir> <what> — the last guard run passed AND reported a real scan: a
# "scanned <N >= 1> ..." line and the scanned bundle dir by name.
expect_clean() {
  local dir="$1" what="$2"
  [ "$RC" -eq 0 ] || { tail -15 <<<"$OUT"; echo "ratchet: guard failed $what"; return 1; }
  grep -qiE "scanned [1-9][0-9]*([^0-9]|$)" <<<"$OUT" \
    || { tail -15 <<<"$OUT"; echo "ratchet: guard passed $what but printed no 'scanned <N> files' report"; return 1; }
  grep -qF -- "$dir" <<<"$OUT" \
    || { tail -15 <<<"$OUT"; echo "ratchet: guard passed $what but never named the scanned dir $dir"; return 1; }
}

gate_clean_control() {
  local dir="$WORK/clean"
  plant_bundle "$dir" "$CLEAN_PAYLOAD"
  guard_run --dir "$dir"
  expect_clean "$dir" "a clean Hermes-shaped bundle (empty SWIFTLY_API_KEY and SWIFTLY_AGENCY_KEY=miami are not leaks)"
}

gate_literal_plant() {
  local dir="$WORK/leak"
  plant_bundle "$dir" "k=\"$FAKE\";"
  guard_run --dir "$dir"
  expect_caught "$FAKE" "a TRANSITLAND_API_KEY value in the bundle" TRANSITLAND_API_KEY
}

gate_public_name_plant() {
  local dir="$WORK/public-name"
  plant_bundle "$dir" "k=process.env.$PUBLIC_NAME;"
  guard_run --dir "$dir"
  expect_caught "$FAKE" "a $PUBLIC_NAME reference in the bundle" "$PUBLIC_NAME"
}

gate_public_value_plant() {
  # Expo inlines a DEFINED public var at export: its name vanishes, only its value is in the bundle.
  local dir="$WORK/public-value"
  local -x "$PUBLIC_NAME=$FAKE2"   # exported for this function's children only; gone on return
  plant_bundle "$dir" "k=\"$FAKE2\";"
  guard_run --dir "$dir"
  expect_caught "$FAKE2" "the inlined value of a defined $PUBLIC_NAME" "$PUBLIC_NAME"
}

gate_empty_dir() {
  local dir
  mkdir -p "$WORK/empty"
  for dir in "$WORK/empty" "$WORK/no-such-dir"; do
    guard_run --dir "$dir"
    [ "$RC" -ne 0 ] || { echo "ratchet: guard exited 0 on $dir — scanning nothing must fail"; return 1; }
    grep -qiF "no bundle files" <<<"$OUT" \
      || { tail -15 <<<"$OUT"; echo "ratchet: guard on $dir failed without saying 'no bundle files' (crash or wrong reason)"; return 1; }
    grep -qF -- "$dir" <<<"$OUT" \
      || { tail -15 <<<"$OUT"; echo "ratchet: guard's 'no bundle files' message does not name $dir"; return 1; }
    if grep -qE '^ +at ' <<<"$OUT"; then
      tail -15 <<<"$OUT"; echo "ratchet: guard crashed with a stack trace on $dir — report it and exit 1"; return 1
    fi
  done
}

gate_self_test() {
  guard_run --self-test
  [ "$RC" -eq 0 ] || { tail -15 <<<"$OUT"; echo "ratchet: embedded-keys --self-test is red"; return 1; }
  grep -qiE "self-test.*pass" <<<"$OUT" \
    || { tail -15 <<<"$OUT"; echo "ratchet: --self-test printed no 'self-test … pass' report (flag ignored?)"; return 1; }
}

gate_publish_script() {
  node -e '
    const p = (require("./package.json").scripts || {}).publish;
    const fail = (m) => { console.log("ratchet: publish script: " + m); process.exit(1); };
    if (typeof p !== "string") fail("missing from package.json scripts");
    if (/;|\|\|/.test(p)) fail("chain steps with && only, so a red step stops the upload");
    const seg = p.split("&&").map((s) => s.trim());
    const steps = [["verify", /^npm run (-s |--silent )?verify$/], ["export", /\bexpo export\b/],
      ["guard", /scripts\/check\/embedded-keys\.ts\b/], ["eas update", /\beas(-cli(@[\w.]+)?)? update\b/]];
    const idx = steps.map(([name, re]) => { const i = seg.findIndex((s) => re.test(s)); if (i < 0) fail("no " + name + " step"); return i; });
    if (!idx.every((v, i) => i === 0 || v > idx[i - 1])) fail("order must be verify -> export -> guard -> eas update: " + JSON.stringify(seg));
    if (idx[3] !== seg.length - 1) fail("eas update must be the last step (npm run publish -- --message ... appends to it)");
    const flag = (s, f) => { const m = s.match(new RegExp("--" + f + "[ =](\\S+)")); return m ? m[1] : null; };
    const [exp, guard, upd] = [seg[idx[1]], seg[idx[2]], seg[idx[3]]];
    if (!/--platform[ =]ios\b/.test(exp)) fail("export must pass --platform ios");
    const dir = flag(exp, "output-dir") || "dist";
    if (/--self-test\b/.test(guard)) fail("the guard step must scan the bundle, not run --self-test");
    if ((flag(guard, "dir") || ".cache/export") !== dir) fail("guard scans a different dir than export wrote (" + dir + ")");
    if (!/--skip-bundler\b/.test(upd) || flag(upd, "input-dir") !== dir)
      fail("eas update must upload the scanned bundle: --skip-bundler --input-dir " + dir + " (otherwise it re-bundles and the guard checked a bundle that is never shipped)");
    if (!/--channel[ =]production\b/.test(upd) || !/--platform[ =]ios\b/.test(upd)) fail("eas update must pass --channel production --platform ios");
    if (!/--environment[ =]production\b/.test(upd)) fail("eas update must pass --environment production (required for SDK >= 55; M0.11 used it)");
    console.log("publish: " + seg.length + " steps in order; guard scans the uploaded bundle " + dir);
  '
}

gate_real_bundle() {
  guard_ready                      # cheap: fail on a missing guard before the slow export
  ios_export
  guard_real                       # the plan's M4.10 V, no args: default dir .cache/export
  expect_clean ".cache/export" "the real exported app bundle"
}

gate_tree_plant() {
  local bundle="$WORK/tree-bundle" rel="$WORK/tree/captured-fixture.ts"
  local idx="$PWD/$WORK/index" objs="$PWD/$WORK/objects" alt
  guard_ready
  plant_bundle "$bundle" "$CLEAN_PAYLOAD"
  alt="$(git rev-parse --absolute-git-dir)/objects"
  mkdir -p "$WORK/tree" "$objs"
  printf 'export const captured = "%s";\n' "$FAKE" > "$rel"
  # Throwaway index + object dir: the plant is git-tracked for the guard; the real index/objects are untouched.
  cp "$(git rev-parse --git-path index)" "$idx"
  GIT_INDEX_FILE="$idx" GIT_OBJECT_DIRECTORY="$objs" GIT_ALTERNATE_OBJECT_DIRECTORIES="$alt" git add -f "$rel"
  GIT_INDEX_FILE="$idx" git ls-files --error-unmatch "$rel" >/dev/null \
    || { echo "ratchet: could not stage the plant in the throwaway index"; return 1; }
  GIT_INDEX_FILE="$idx" GIT_OBJECT_DIRECTORY="$objs" GIT_ALTERNATE_OBJECT_DIRECTORIES="$alt" \
    guard_run --tree --dir "$bundle"
  expect_caught "$FAKE" "a TRANSITLAND_API_KEY value in a git-tracked file" TRANSITLAND_API_KEY captured-fixture.ts
}

gate_tree_clean() {
  local bundle="$WORK/tree-clean-bundle"
  guard_ready
  plant_bundle "$bundle" "$CLEAN_PAYLOAD"
  guard_real --tree --dir "$bundle"
  expect_clean "$bundle" "--tree on the real tracked tree"
}

# 1. M4.8/M4.9 runtime modules exist: http, keys, the three providers, the polling hook, the context
#    (src/live/quota.ts is M4.4's and is gated by m4a_live_domain).
for f in src/live/http.ts src/live/keys.ts src/live/providers/none.ts src/live/providers/swiftly.ts src/live/providers/transitland.ts src/live/use-live-polling.ts src/live/live-context.tsx; do need_file "$f"; done
# 2. M4.8 http.ts fetches through expo/fetch (binary-safe arrayBuffer on Hermes, falsifier R6)
need_re "from ['\"]expo/fetch['\"]" src/live/http.ts
# 3. M4.8 keys live only in the Keychain: keys.ts imports expo-secure-store and no other store; src/live never reads process.env or the public env prefix
need_re "from ['\"]expo-secure-store['\"]" src/live/keys.ts
absent "async-storage|AsyncStorage|expo-sqlite|expo-file-system|localStorage|MMKV" src/live/keys.ts
absent "${PUB}|process\.env" src/live
# 4. M4.9 polling is gated on app state (§4: heartbeat only while the app is active) — non-test code under src/live uses AppState
need_re "\bAppState\b" src/live
# 5. M4.8 http behaviour is tested green: abort -> timeout, fetch rejection -> network, non-2xx -> http status, byte counter
jest_cases src/live/__tests__/http.test.ts 'timeout' 'network' 'non-2xx' 'byte'
# 6. M4.10 the embedded-key guard exists and is runnable (local tsx)
guard_ready
# 7. guard passes a clean Hermes-shaped bundle and reports the scan (empty SWIFTLY_API_KEY and SWIFTLY_AGENCY_KEY=miami are not leaks)
gate_clean_control
# 8. guard FAILS on a planted fake TRANSITLAND_API_KEY value in a binary bundle, names the variable, never echoes the value
gate_literal_plant
# 9. guard FAILS on a public-prefixed *KEY reference in the bundle, names it, never echoes a value
gate_public_name_plant
# 10. guard FAILS on the inlined value of a defined public-prefixed *KEY var (name gone from the bundle), names the var
gate_public_value_plant
# 11. guard FAILS with a 'no bundle files' message naming the dir (not a crash/stack trace) on an empty bundle dir and on a missing one
gate_empty_dir
# 12. guard --self-test proves detection on its own generated fake key
gate_self_test
# 13. M4.10 publish = verify -> export -> guard -> eas update (&&-chained; eas update uploads the exact scanned bundle with --channel production --environment production --platform ios)
gate_publish_script
# 14. M4.10 V: export, then the guard (no args) passes on the real app bundle and reports scanning .cache/export
gate_real_bundle
# 15. --tree FAILS on a planted fake key in a git-tracked file (throwaway index; names variable + file, never the value)
gate_tree_plant
# 16. --tree passes on the real tracked tree (real environment, clean planted bundle)
gate_tree_clean
# 17. repo-wide gate
full_gate
