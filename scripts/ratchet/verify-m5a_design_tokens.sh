#!/usr/bin/env bash
# m5a_design_tokens — design tokens, WCAG color math, the contrast/CVD-tested line palette, and the TText + Glass primitives (plan M5.1–M5.4).
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Every gate below is ONE statement and runs alone after the preamble: no gate reads a variable or a file
# another gate created. Multi-step gates are wrapped in a gate_* / jest_set function for that reason.
# Run one gate alone, from the repo root (sourcing defines lib.sh + the helpers and stops before gate 1):
#   bash -c 'source "$0"; <gate command>' scripts/ratchet/verify-m5a_design_tokens.sh

# --- card-local helpers (lib.sh has no multi-case jest pin, regex need, mock-label check or hex pin) ---

# card_cases — the CARD-WIDE universe of named jest acceptance cases, one "<set> <ERE>" row per case. Each
# ERE is a FULL-NAME pin: a case-insensitive JS regex matched against jest's fullName ("describe … test")
# and anchored with '$', so the test title must END with the case phrase. A test counts for a case only
# when it matches that case and NO OTHER case of this universe. Four gates (5–8) run the same colors.test.ts;
# checked per gate, one test named for a land case AND a badge case would satisfy two gates at once.
# Checked against the universe, that test is nobody's own test. Helpers only call this; no gate edits it.
card_cases() {
  local line scheme cvd
  printf '%s\n' 'tokens spacing.*4-pt grid$' 'tokens hero maxScale <= 1\.6$' 'tokens minutes.*tabular-nums$'
  printf '%s\n' 'colorMath contrast\(black, white\) = 21$' 'colorMath contrast\(x, x\) = 1$'
  for line in Green Orange Inner Omni Brickell; do
    for scheme in light dark; do
      printf '%s\n' "land $line.*stroke or casing >= 3:1 on map land \\($scheme\\)\$" \
                    "badge $line.*badge text >= 4\\.5:1 \\($scheme\\)\$"
    done
  done
  for scheme in light dark; do
    for cvd in deuteranopia protanopia; do
      printf '%s\n' "green_orange Green/Orange deltaE >= 30 under $cvd \\($scheme\\)\$"
    done
    for cvd in protanopia deuteranopia tritanopia; do
      printf '%s\n' "inner_omni Inner.*/Omni deltaE >= 25 under $cvd \\($scheme\\)\$"
    done
  done
  printf '%s\n' 'ttext hero.*tabular-nums.*largeTitle$'
  printf '%s\n' 'glass solid.*isLiquidGlassAvailable.*false$' 'glass GlassView.*isLiquidGlassAvailable.*true$'
}

# case_set_target <set> — prints "<test-file> <module>": the one test file a case set lives in, and the
# module that file must import (an import path ending in /<module>).
case_set_target() {
  case "$1" in
    tokens) echo "src/ui/__tests__/tokens.test.ts tokens" ;;
    colorMath) echo "src/ui/__tests__/colorMath.test.ts colorMath" ;;
    land|green_orange|inner_omni|badge) echo "src/ui/__tests__/colors.test.ts colors" ;;
    ttext) echo "src/ui/primitives/__tests__/TText.test.tsx TText" ;;
    glass) echo "src/ui/primitives/__tests__/Glass.test.tsx Glass" ;;
    *) echo "ratchet: verify-script authoring error: unknown acceptance-case set '$1'"; return 1 ;;
  esac
}

# jest_set <set> <count> — the set's <count> cases from card_cases, checked by jest_cases in the set's test
# file against the whole card universe. <count> is the number the gate's comment promises.
jest_set() {
  local want="$1" count="$2" target row mine=() universe=()
  target=$(case_set_target "$want") || { echo "$target"; return 1; }
  while IFS= read -r row; do
    universe+=("${row#* }")
    if [ "${row%% *}" = "$want" ]; then mine+=("${row#* }"); fi
  done < <(card_cases)
  [ "${#mine[@]}" -eq "$count" ] \
    || { echo "ratchet: verify-script authoring error: case set '$want' has ${#mine[@]} case(s), the gate promises $count"; return 1; }
  jest_cases "${target% *}" "${target#* }" "$count" "${mine[@]}" "${universe[@]}" || return 1
}

# jest_cases <test-file> <module> <n> <case-ERE>×n <universe-ERE>... — the exact test file must import the
# module under test, then ONE local-jest run of that file (a JSON report) must be green: >= 1 passed,
# 0 failed, 0 skipped/todo (so the plan's V for the file is covered). Every case must be a member of the
# universe, and each must be matched by >= 1 PASSED test whose full name matches NO other universe case.
# Why not lib's jest_nonempty "<file>" "<name>": it pins one name per run and cannot require distinct tests.
jest_cases() {
  local file="$1" mod="$2" report out rc=0
  shift 2
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  grep -qE "from ['\"][^'\"]*/${mod}['\"]" "$file" \
    || { echo "ratchet: $file does not import the module under test ('…/$mod') — acceptance must exercise the real module"; return 1; }
  report=$(mktemp) || { echo "ratchet: mktemp failed"; return 1; }
  out=$(local_bin jest --ci --runTestsByPath "$file" --json --outputFile="$report" 2>&1) \
    || { echo "$out" | tail -30; rm -f "$report"; echo "ratchet: jest red (or not installed) for $file"; return 1; }
  [ -s "$report" ] || { echo "$out" | tail -15; rm -f "$report"; echo "ratchet: jest wrote no JSON report for $file"; return 1; }
  node - "$file" "$report" "$@" <<'NODE' || rc=1
const fs = require("node:fs");
const [file, report, count, ...rest] = process.argv.slice(2);
const n = Number(count);
const wanted = rest.slice(0, n);
const universe = rest.slice(n);
const authoring = [];
if (!(n >= 1) || wanted.length !== n || universe.length < n) authoring.push(`bad arguments (${n} case(s), ${universe.length} in the universe)`);
if (new Set(universe).size !== universe.length) authoring.push("card_cases lists a case twice");
wanted.filter((c) => !universe.includes(c)).forEach((c) => authoring.push(`/${c}/i is not in card_cases`));
if (authoring.length > 0) {
  console.log(`ratchet: verify-script authoring error: ${authoring.join("; ")}`);
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(report, "utf8"));
const tests = r.testResults.flatMap((suite) => suite.assertionResults);
const res = universe.map((pat) => new RegExp(pat, "i"));
const problems = [];
if (r.success !== true) problems.push("jest reported success=false");
if (r.numPassedTests < 1) problems.push("no test passed");
if (r.numFailedTests > 0 || r.numFailedTestSuites > 0) problems.push("failing tests/suites");
if (r.numPendingTests > 0 || r.numTodoTests > 0) problems.push("skipped/todo tests are forbidden");
wanted.forEach((pat) => {
  const i = universe.indexOf(pat);
  const hits = tests.filter((t) => res[i].test(t.fullName));
  const own = hits.filter((t) => t.status === "passed" && res.every((other, j) => j === i || !other.test(t.fullName)));
  if (hits.length === 0) problems.push(`no test's full name ends with /${pat}/i`);
  else if (hits.some((t) => t.status !== "passed")) problems.push(`a test named /${pat}/i did not pass`);
  else if (own.length === 0) problems.push(`/${pat}/i has no test of its own: every match also matches another card case (${hits.map((t) => t.fullName).join(" ; ")}) — one test per case`);
});
if (problems.length > 0) {
  console.log(`ratchet: ${file}: ${problems.join("; ")}`);
  console.log(`tests: ${tests.map((t) => `[${t.status}] ${t.fullName}`).join("  ;  ")}`);
  process.exit(1);
}
console.log(`ratchet: ${file}: ${r.numPassedTests} passed; ${n} named case(s), each its own passing test (distinct across the card's ${universe.length} cases)`);
NODE
  rm -f "$report"
  return "$rc"
}

# need_all_re <file> <ERE>... — the file exists and every ERE matches >= 1 line of it.
need_all_re() {
  local file="$1" re
  shift
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  for re in "$@"; do
    grep -qE -- "$re" "$file" || { echo "ratchet: expected /$re/ in $file"; return 1; }
  done
}

# need_hex <file> <#RRGGBB>... — the file exists and contains every hex value (case-insensitive).
need_hex() {
  local file="$1" hex
  shift
  [ -f "$file" ] || { echo "ratchet: missing file $file"; return 1; }
  for hex in "$@"; do
    grep -qiF -- "$hex" "$file" || { echo "ratchet: plan §4 palette value $hex is not in $file"; return 1; }
  done
}

# labelled_mock <test-file> <module> — the test file calls jest.mock('<module>', …) and EVERY such call
# carries the repo's label '// test-time mock of native module' (same line or the line above).
labelled_mock() {
  local file="$1" mod="$2"
  [ -f "$file" ] || { echo "ratchet: missing $file — the milestone's tests do not exist yet"; return 1; }
  node - "$file" "$mod" <<'NODE' || return 1
const fs = require("node:fs");
const [file, mod] = process.argv.slice(2);
const label = "// test-time mock of native module";
const lines = fs.readFileSync(file, "utf8").split("\n");
const call = new RegExp("jest\\.mock\\(\\s*['\"`]" + mod.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&") + "['\"`]");
const at = lines.flatMap((line, i) => (call.test(line) ? [i] : []));
if (at.length === 0) {
  console.log(`ratchet: ${file} never calls jest.mock('${mod}') — the native module must be a named test-time mock`);
  process.exit(1);
}
const bare = at.filter((i) => !lines[i].includes(label) && !(i > 0 && lines[i - 1].includes(label)));
if (bare.length > 0) {
  console.log(`ratchet: ${file}:${bare[0] + 1} jest.mock('${mod}') is not labelled '${label}'`);
  process.exit(1);
}
console.log(`ratchet: ${file}: ${at.length} labelled jest.mock('${mod}') call(s)`);
NODE
}

# M5.2 oracle: import the REAL src/ui/colorMath.ts under node+tsx (it must stay pure — no react-native)
# and check contrast() against WCAG 2.x reference values, independent of the builder's own tests.
gate_contrast_oracle() {
  need_file src/ui/colorMath.ts || return 1
  node --import tsx -e '
const fail = (m) => { console.log("ratchet: colorMath oracle: " + m); process.exit(1); };
import("./src/ui/colorMath.ts").then((m) => {
  if (typeof m.contrast !== "function") fail("src/ui/colorMath.ts does not export contrast(a, b)");
  const near = (got, want, tol) => typeof got === "number" && Math.abs(got - want) <= tol;
  const bw = m.contrast("#000000", "#FFFFFF");
  if (!near(bw, 21, 0.01)) fail("contrast(#000000, #FFFFFF) = " + bw + ", want 21 ± 0.01");
  const wb = m.contrast("#FFFFFF", "#000000");
  if (!near(wb, 21, 0.01)) fail("contrast(#FFFFFF, #000000) = " + wb + ", want 21 ± 0.01 (order-independent)");
  for (const x of ["#000000", "#FFFFFF", "#0E9F6E", "#8A6100"]) {
    const c = m.contrast(x, x);
    if (!near(c, 1, 1e-9)) fail("contrast(" + x + ", " + x + ") = " + c + ", want 1");
  }
  const mid = m.contrast("#767676", "#FFFFFF");
  if (!near(mid, 4.54, 0.01)) fail("contrast(#767676, #FFFFFF) = " + mid + ", want 4.54 ± 0.01 (WCAG relative luminance with sRGB linearization)");
  console.log("colorMath oracle: contrast(black, white) = " + bw.toFixed(4) + "; contrast(x, x) = 1; #767676 on white = " + mid.toFixed(2));
}, (e) => fail("cannot import src/ui/colorMath.ts under node+tsx (keep it pure: no react-native/expo imports): " + e.message))
  .catch((e) => fail("contrast() threw: " + e.message));
' || return 1
}

# The card's five modules exist, then the repo-wide gate runs with them in it (a bare full_gate is green on
# the unbuilt tree and proves nothing about M5.1–M5.4).
gate_full() {
  local f
  for f in src/ui/tokens.ts src/ui/colorMath.ts src/ui/colors.ts src/ui/primitives/TText.tsx src/ui/primitives/Glass.tsx; do
    need_file "$f" || return 1
  done
  full_gate || return 1
}

# Sourced rather than executed: helpers are defined; run no gate.
if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m5a_design_tokens gate failed at verify script line $LINENO"' ERR

# --- M5.1 Tokens (src/ui/tokens.ts; V: jest src/ui/__tests__/tokens.test.ts) ---
# 1. A: spacing on the 4-pt grid, hero maxScale <= 1.6, minutes tabular-nums — 3 distinct named cases on the real tokens module, file green.
jest_set tokens 3

# --- M5.2 colorMath (src/ui/colorMath.ts; V: jest src/ui/__tests__/colorMath.test.ts) ---
# 2. A: contrast(black, white) = 21 ± 0.01 and contrast(x, x) = 1 — 2 distinct named cases on the real colorMath module, file green.
jest_set colorMath 2
# 3. Oracle: the real exported contrast() gives 21 ± 0.01 for black/white (either order), 1 for x/x, 4.54 for #767676 on white.
gate_contrast_oracle

# --- M5.3 Line palette (src/ui/colors.ts; V: jest src/ui/__tests__/colors.test.ts) ---
# 4. The palette carries the plan §4 values (light strokes, Brickell casing, dark Inner/Omni/Brickell); dark Green/Orange are
#    left free because the plan's #35D49A/#FF7A45 measure deltaE76 27.9 < 30 under protanopia (see the card note).
need_hex src/ui/colors.ts '#0E9F6E' '#E8590C' '#0E95D0' '#2E3FB0' '#F2B705' '#8A6100' '#5AD1FF' '#7C83FF' '#FFD24A'
# 5. A: for all 5 lines in light AND dark, stroke or casing >= 3:1 against map land (10 named cases, each its own test card-wide).
jest_set land 10
# 6. A: Green/Orange deltaE >= 30 under deuteranopia and protanopia, light and dark (4 named cases, each its own test card-wide).
jest_set green_orange 4
# 7. A: Inner Loop/Omni deltaE >= 25 under protanopia, deuteranopia and tritanopia, light and dark (6 named cases, each its own test card-wide).
jest_set inner_omni 6
# 8. A: badge text >= 4.5:1 on every line color in light AND dark (10 named cases, each its own test card-wide).
jest_set badge 10

# --- M5.4 TText + Glass primitives (src/ui/primitives/{TText,Glass}.tsx; V: jest src/ui/primitives) ---
# 9. A: the TText hero variant renders tabular-nums with dynamicTypeRamp largeTitle (named case on the real TText, file green).
jest_set ttext 1
# 10. Glass.tsx is built on expo-glass-effect: imports it, gates on isLiquidGlassAvailable(), renders GlassView.
need_all_re src/ui/primitives/Glass.tsx "from ['\"]expo-glass-effect['\"]" 'isLiquidGlassAvailable\(' 'GlassView'
# 11. The Glass test mocks expo-glass-effect only as a labelled test-time mock of a native module.
labelled_mock src/ui/primitives/__tests__/Glass.test.tsx expo-glass-effect
# 12. A: Glass falls back to solid (no GlassView) when the mocked isLiquidGlassAvailable() is false, and renders GlassView when it
#     is true — 2 distinct named cases on the real Glass, file green.
jest_set glass 2
# 13. Plan V (M5.4): every test under src/ui/primitives runs green, >= 1 passed, none skipped.
jest_nonempty src/ui/primitives

# --- Repo-wide ---
# 14. The card's modules exist and npm run verify (tsc app+scripts, eslint --max-warnings 0, standards, jest, node:test) is green with them.
gate_full
