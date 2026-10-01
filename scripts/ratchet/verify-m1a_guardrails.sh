#!/usr/bin/env bash
# m1a_guardrails — strict TS, ESLint rules, jest, invariant/Result, standards checker, npm run verify (plan M1.1–M1.7)
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Temp probes this script writes are removed even when a gate fails part-way.
trap 'rm -f .cache/ratchet/m1a-lib-probe.ts src/app/ratchet-probe-tmp.tsx' EXIT

# ---- card-local helpers -------------------------------------------------------------------
# local_bin, need_file, jest_nonempty, nodetest_nonempty, nodetest_case and full_gate come from
# lib.sh. Do not redefine them here: a definition after `source lib.sh` shadows the lib version.

# `tsc --showConfig` JSON on stdin must resolve every strict flag M1.1 names to true.
assert_strict_flags() {
  RATCHET_TSCONFIG="$1" node -e '
const o = JSON.parse(require("fs").readFileSync(0, "utf8")).compilerOptions || {};
const want = ["strict", "noUncheckedIndexedAccess", "noImplicitReturns", "noUnusedLocals", "noUnusedParameters"];
const bad = want.filter((k) => o[k] !== true);
if (bad.length > 0) { console.log(`ratchet: ${process.env.RATCHET_TSCONFIG} does not resolve ${bad.join(", ")} to true`); process.exit(1); }
console.log(`${process.env.RATCHET_TSCONFIG}: strict flags OK`);'
}

# 1. M1.1 pins: tsx 4.23.15 and @types/node 26.6.3 are devDependencies and installed at exactly those versions
node -e '
const fs = require("fs");
const dev = JSON.parse(fs.readFileSync("package.json", "utf8")).devDependencies || {};
const want = { "tsx": "4.23.15", "@types/node": "26.6.3" };
const bad = [];
for (const [name, ver] of Object.entries(want)) {
  if (!dev[name]) { bad.push(`${name} is not in devDependencies (npm i -D ${name}@${ver})`); continue; }
  const f = `node_modules/${name}/package.json`;
  const got = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).version : "absent";
  if (got !== ver) bad.push(`${name} installed ${got}, plan pins ${ver}`);
}
if (bad.length > 0) { console.log("ratchet: " + bad.join("; ")); process.exit(1); }
console.log("tsx + @types/node pins OK");'

# 2. M1.1 strict app tsconfig: tsconfig.json resolves strict, noUncheckedIndexedAccess, noImplicitReturns, noUnusedLocals, noUnusedParameters
local_bin tsc --showConfig | assert_strict_flags tsconfig.json

# 3. M1.1 scripts tsconfig: scripts/tsconfig.json exists, resolves the same strict flags, and its program includes the standards checker
need_file scripts/tsconfig.json
local_bin tsc --showConfig -p scripts/tsconfig.json | assert_strict_flags scripts/tsconfig.json
scripts_files=$(local_bin tsc -p scripts/tsconfig.json --listFilesOnly)
grep -q '/scripts/check/standards\.ts$' <<<"$scripts_files" \
  || { echo "ratchet: scripts/tsconfig.json does not type-check scripts/check/standards.ts"; exit 1; }

# 4. M1.1 V: the app and the scripts both type-check under strict, and tsx runs
need_file scripts/tsconfig.json
local_bin tsc --noEmit
local_bin tsc --noEmit -p scripts/tsconfig.json
local_bin tsx --version

# 5. M1.2 V (plan check): max-lines-per-function, no-floating-promises and no-restricted-imports are errors for src/domain
need_file eslint.config.js
local_bin eslint --print-config src/domain/x.ts | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8")).rules;
const bad = ["max-lines-per-function", "@typescript-eslint/no-floating-promises", "no-restricted-imports"].filter((k) => !r[k] || r[k][0] !== 2);
if (bad.length > 0) { console.log("ratchet: not set to error for src/domain: " + bad.join(", ")); process.exit(1); }
console.log("M1.2 print-config OK");'

# 6. §4 rule values: max-lines-per-function max 60, no-empty + switch-exhaustiveness-check at error, src/domain bans react, react-native, expo*, @/
need_file eslint.config.js
local_bin eslint --print-config src/domain/x.ts | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8")).rules;
const bad = [];
const mlf = r["max-lines-per-function"];
const max = mlf && (typeof mlf[1] === "number" ? mlf[1] : mlf[1] && mlf[1].max);
if (!mlf || mlf[0] !== 2 || max !== 60) bad.push(`max-lines-per-function must be error with max 60 (got ${JSON.stringify(mlf)})`);
for (const k of ["no-empty", "@typescript-eslint/switch-exhaustiveness-check"]) if (!r[k] || r[k][0] !== 2) bad.push(`${k} must be error`);
const nri = JSON.stringify(r["no-restricted-imports"] || []);
const bans = [["react", /react(?![\w-])/], ["react-native", /react-native/], ["expo*", /expo/], ["@/ aliases", /@\//]];
for (const [label, re] of bans) if (!re.test(nri)) bad.push(`no-restricted-imports for src/domain does not ban ${label}`);
if (bad.length > 0) { console.log("ratchet: " + bad.join("; ")); process.exit(1); }
console.log("§4 eslint values OK");'

# 7. M1.2 V: the whole repo lints clean with zero warnings
need_file eslint.config.js
local_bin eslint . --max-warnings 0

# 8. M1.3 jest setup: jest, jest-expo, @types/jest are devDependencies; package.json jest block has preset jest-expo/ios and testMatch confined to src/**/__tests__
node -e '
const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
const dev = p.devDependencies || {};
const j = p.jest;
const bad = [];
for (const k of ["jest", "jest-expo", "@types/jest"]) if (!dev[k]) bad.push(`${k} is not in devDependencies`);
if (!j) bad.push("package.json has no jest block");
else {
  if (j.preset !== "jest-expo/ios") bad.push(`jest.preset is ${JSON.stringify(j.preset)}, plan says "jest-expo/ios"`);
  const tm = [].concat(j.testMatch || []);
  if (tm.length === 0 || !tm.every((t) => /(^|\/)src\//.test(t) && /__tests__/.test(t))) bad.push(`jest.testMatch must be confined to src/**/__tests__ (got ${JSON.stringify(j.testMatch)})`);
}
if (bad.length > 0) { console.log("ratchet: " + bad.join("; ")); process.exit(1); }
console.log("jest block OK");'

# 9. M1.3 jest scope: jest lists the src/lib tests and nothing outside <repo>/src (scripts/ node:test files stay out of jest)
jest_list=$(local_bin jest --ci --listTests)
grep -q '/src/lib/__tests__/' <<<"$jest_list" || { echo "ratchet: jest --listTests does not include src/lib/__tests__"; exit 1; }
stray=$(grep -E '^/' <<<"$jest_list" | grep -v "^$(pwd -P)/src/" || true)
[ -z "$stray" ] || { echo "ratchet: jest picks up tests outside src/: $stray"; exit 1; }

# 10. M1.4 V: the invariant + Result jest tests exist and pass, none skipped
jest_nonempty src/lib

# 11. M1.4 acceptance, run directly: invariant(false) throws InvariantError; isOk(ok(1)); !isOk(err("e"))
need_file src/lib/invariant.ts
need_file src/lib/result.ts
mkdir -p .cache/ratchet
cat > .cache/ratchet/m1a-lib-probe.ts <<'EOF'
import { invariant, InvariantError } from '../../src/lib/invariant';
import { err, isOk, ok } from '../../src/lib/result';

let thrown: unknown = null;
try {
  invariant(false);
} catch (e) {
  thrown = e;
}
if (!(thrown instanceof InvariantError)) {
  console.log('ratchet: invariant(false) did not throw an InvariantError');
  process.exit(1);
}
if (!isOk(ok(1))) {
  console.log('ratchet: isOk(ok(1)) is false');
  process.exit(1);
}
if (isOk(err('e'))) {
  console.log('ratchet: isOk(err("e")) is true');
  process.exit(1);
}
console.log('invariant + Result acceptance OK');
EOF
node --import tsx .cache/ratchet/m1a-lib-probe.ts
rm -f .cache/ratchet/m1a-lib-probe.ts

# 12. M1.5 V: the standards checker node:test suite runs green with >= 1 real test and zero fail/skipped/todo/cancelled
nodetest_nonempty scripts/check/__tests__/standards.test.ts

# 13. M1.5: a 61-line function is flagged (>= 1 passing test whose full name matches /fn-length/i)
nodetest_case scripts/check/__tests__/standards.test.ts fn-length 1

# 14. M1.5: a function with 1 invariant() is flagged (>= 1 passing test named /assertions/i)
nodetest_case scripts/check/__tests__/standards.test.ts assertions 1

# 15. M1.5: a TODO marker is flagged (>= 1 passing test named /marker/i)
nodetest_case scripts/check/__tests__/standards.test.ts marker 1

# 16. M1.5: an it.skip is flagged (>= 1 passing test named /skipped-test/i)
nodetest_case scripts/check/__tests__/standards.test.ts skipped-test 1

# 17. M1.6: a self-call AND a cross-file a<->b cycle are each flagged (>= 2 passing tests named /recursion/i)
nodetest_case scripts/check/__tests__/standards.test.ts recursion 2

# 18. M1.6: a swallowing catch is flagged (>= 1 passing test named /silent-catch/i)
nodetest_case scripts/check/__tests__/standards.test.ts silent-catch 1

# 19. M1.5: a clean snippet gives 0 violations (>= 1 passing test named /clean/i)
nodetest_case scripts/check/__tests__/standards.test.ts clean 1

# 20. The checker really scans src/app: an unasserted named function dropped there turns it red, naming the file and the rule
need_file scripts/check/standards.ts
local_bin tsx --version >/dev/null
printf '%s\n' 'export function ratchetProbeUnasserted(n: number): number {' '  return n + 1;' '}' > src/app/ratchet-probe-tmp.tsx
probe_rc=0
probe_out=$(local_bin tsx scripts/check/standards.ts 2>&1) || probe_rc=$?
rm -f src/app/ratchet-probe-tmp.tsx
[ "$probe_rc" -ne 0 ] \
  || { echo "ratchet: standards checker exited 0 with an unasserted function in src/app — it does not scan src/app"; exit 1; }
grep -q 'ratchet-probe-tmp' <<<"$probe_out" \
  || { echo "$probe_out" | tail -15; echo "ratchet: standards checker went red but did not name src/app/ratchet-probe-tmp.tsx"; exit 1; }
grep -q 'assertions' <<<"$probe_out" \
  || { echo "$probe_out" | tail -15; echo "ratchet: standards checker did not report the 'assertions' rule for the probe"; exit 1; }

# 21. Retrofit, path-independent (survives M1.18's move to src/app/(tabs)/): every .tsx found under src/app has >= 2 invariant( calls, and a full standards-checker run reports no violation in any src/app file
[ -d src/app ] || { echo "ratchet: src/app does not exist"; exit 1; }
app_tsx=$(find src/app -type f -name '*.tsx' -not -path '*/__tests__/*' | sort)
[ -n "$app_tsx" ] || { echo "ratchet: no .tsx route files found under src/app"; exit 1; }
while IFS= read -r f; do
  n=$({ grep -oE '(^|[^[:alnum:]_$.])invariant\(' "$f" || true; } | wc -l | tr -d ' ')
  [ "$n" -ge 2 ] || { echo "ratchet: $f has $n invariant() call(s) — retrofit it to >= 2 per named function"; exit 1; }
done <<<"$app_tsx"
need_file scripts/check/standards.ts
std_rc=0
std_out=$(local_bin tsx scripts/check/standards.ts 2>&1) || std_rc=$?
if [ "$std_rc" -ne 0 ]; then
  app_hits=$(grep -F 'src/app/' <<<"$std_out" || true)
  [ -z "$app_hits" ] \
    || { echo "$app_hits" | head -20; echo "ratchet: the standards checker reports violations in src/app — the retrofit is incomplete"; exit 1; }
  echo "$std_out" | tail -15
  echo "ratchet: the standards checker exited $std_rc and named no src/app file — only a green run certifies src/app (the red is elsewhere; see gate 22)"
  exit 1
fi

# 22. M1.6 V: the standards checker passes on the whole repo (retrofitted src/app included)
need_file scripts/check/standards.ts
local_bin tsx scripts/check/standards.ts

# 23. M1.7: the verify script (following npm run chains) runs tsc for app + scripts, eslint --max-warnings 0, the standards checker, jest and node:test
node -e '
const s = JSON.parse(require("fs").readFileSync("package.json", "utf8")).scripts || {};
if (!s.verify) { console.log("ratchet: package.json has no verify script (M1.7)"); process.exit(1); }
const seen = new Set();
const queue = ["verify"];
let text = "";
for (let i = 0; i < 50 && queue.length > 0; i += 1) {
  const name = queue.shift();
  if (seen.has(name) || typeof s[name] !== "string") continue;
  seen.add(name);
  text += "\n" + s[name];
  for (const m of s[name].matchAll(/npm(?:\s+--?[\w-]+)*\s+run(?:\s+--?[\w-]+)*\s+([\w:.-]+)/g)) queue.push(m[1]);
}
const need = [
  ["tsc for the app and for scripts/tsconfig.json", (t) => (t.match(/\btsc\b/g) || []).length >= 2 && /tsc[^&|;\n]*(-p|--project)[ =]scripts\/tsconfig\.json/.test(t)],
  ["eslint with --max-warnings 0", (t) => /(eslint|expo lint)[^&|;\n]*--max-warnings[ =]0/.test(t)],
  ["the standards checker (scripts/check/standards.ts)", (t) => /scripts\/check\/standards\.ts/.test(t)],
  ["jest", (t) => /\bjest(?![\w-])/.test(t)],
  ["node:test (node ... --test)", (t) => /\bnode\b[^&|;\n]*--test(?![\w-])/.test(t)],
];
const missing = need.filter(([, ok]) => !ok(text)).map(([label]) => label);
if (missing.length > 0) { console.log("ratchet: npm run verify does not run: " + missing.join("; ")); process.exit(1); }
console.log("verify script composition OK");'

# 24. M1.7 V: npm run verify exists and is green (this card creates it)
full_gate
