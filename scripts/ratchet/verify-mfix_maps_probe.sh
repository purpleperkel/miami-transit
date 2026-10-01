#!/usr/bin/env bash
# mfix_maps_probe — Probe fixes: maps:// scored by resolution, notification scored by arrival.
# Plan "M1.19 RESULT" + arbiter ruling 2026-10-01. maps://: RN Linking.openURL is Promise<void>, so success =
# resolve (with ANY value), failure = reject; never read the resolved value. Notification: the probe subscribes
# Notifications.addNotificationReceivedListener BEFORE scheduling, waits up to 15 s for its own identifier, and
# returns ok('received after N s') or an err naming the 15 s timeout and 'Settings > Notifications > Expo Go';
# the subscription is removed on both paths.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."
trap 'echo "ratchet: mfix_maps_probe gate failed at verify script line $LINENO"' ERR

# Every gate below is ONE statement and runs alone after the four lines above: no gate reads a variable or a
# file another gate created. Multi-step gates are wrapped in a function for that reason.
# One test per case: every jest pin is anchored with '$' on a distinct suffix (none is a suffix of another),
# so a single catch-all test can never satisfy two gates.

# --- card-local helpers ------------------------------------------------------------------------------------

# probeMapsLink still calls openURL, and no line of device-probes.ts binds, tests or documents the value openURL
# resolved with (the M1.19 false negative: `const opened = await …; opened ? ok : err`). A read through
# `.then(v => …)` slips past any grep; gate 2 (resolving false must score ok) catches that behaviourally.
maps_probe_ignores_resolved_value() {
  local file=src/ui/diagnostics/device-probes.ts hits rc=0
  need_file "$file" || return 1
  need 'openURL(' "$file" || return 1
  # grep exits 1 when nothing matches (the passing case) and 2 on a real error, which must not pass.
  hits=$(grep -nE \
    -e 'const opened' \
    -e 'opened \?' \
    -e '=[[:space:]]*await[[:space:]]+[A-Za-z_$.]*openURL\(' \
    -e '\(await[[:space:]]+[A-Za-z_$.]*openURL\([^)]*\)\)' \
    -e 'openURL resolves true' \
    "$file") || rc=$?
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) reading $file"; return 1; }
  [ -z "$hits" ] || { echo "$hits"; echo "ratchet: $file still reads or documents openURL's resolved value — RN Linking.openURL is Promise<void>: success = resolve, failure = reject"; return 1; }
}

# The real probe module (not only its tests) is wired to arrival: it subscribes the received-listener, removes
# the subscription (expo-notifications 57 has no removeNotificationSubscription; EventSubscription.remove()),
# reports 'received after', and carries the arbiter's settings hint verbatim.
notification_probe_observes_arrival() {
  local file=src/ui/diagnostics/device-probes.ts
  need_file "$file" || return 1
  need 'addNotificationReceivedListener(' "$file" || return 1
  need '.remove()' "$file" || return 1
  need 'received after' "$file" || return 1
  need 'Settings > Notifications > Expo Go' "$file" || return 1
}

# Guard for the repo-wide gate: this card's two files exist AND all six of its pinned tests exist and pass
# (one jest JSON run of the test file, full names matched case-insensitively like jest -t). Only then does
# `npm run verify` run, so it cannot go green on the unbuilt tree.
gate_full() {
  local probes=src/ui/diagnostics/device-probes.ts tests=src/ui/diagnostics/__tests__/device-probes.test.ts
  local report=.cache/ratchet/mfix_maps_probe.device-probes.json out rc=0
  need_file "$probes" || return 1
  need_file "$tests" || return 1
  mkdir -p .cache/ratchet || { echo "ratchet: cannot create .cache/ratchet"; return 1; }
  rm -f "$report"
  # A red file still writes the report; the per-name check below decides, and full_gate re-runs everything.
  out=$(local_bin jest --ci --runTestsByPath "$tests" --json --outputFile="$report" 2>&1) || rc=$?
  [ -s "$report" ] || { echo "$out" | tail -20; echo "ratchet: jest (exit $rc) wrote no JSON report for $tests"; return 1; }
  node - "$tests" "$report" \
    'probeMapsLink passes when openURL resolves undefined$' \
    'probeMapsLink passes when openURL resolves false$' \
    'probeMapsLink fails naming the URL when openURL rejects$' \
    'probeNotification reports received when the listener fires$' \
    'probeNotification fails after 15 s with the Expo Go settings hint$' \
    'probeNotification removes its listener on both paths$' <<'NODE' || return 1
const fs = require("node:fs");
const [file, report, ...wanted] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(report, "utf8"));
const tests = r.testResults.flatMap((suite) => suite.assertionResults);
const problems = wanted.flatMap((pat) => {
  const hits = tests.filter((t) => new RegExp(pat, "i").test(t.fullName));
  if (hits.length === 0) return [`no test named /${pat}/i`];
  return hits.some((t) => t.status === "passed") ? [] : [`a test named /${pat}/i exists but did not pass`];
});
if (problems.length > 0) {
  console.log(`ratchet: ${file}: this card's tests are not all present and green: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`ratchet: ${file}: all ${wanted.length} card tests present and green`);
NODE
  full_gate || return 1
}

# --- maps:// scored by resolution ---------------------------------------------------------------------------
# 1. A: openURL resolving undefined (RN's real Promise<void>) scores the maps:// probe ok — the exact phone case M1.19 scored FAIL.
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeMapsLink passes when openURL resolves undefined$'
# 2. A: openURL resolving false still scores ok — resolving with ANY value is success (kills a `.then(v => v === false ? err : ok)` read).
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeMapsLink passes when openURL resolves false$'
# 3. A: openURL rejecting scores err, and the error names the maps:// URL it could not open.
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeMapsLink fails naming the URL when openURL rejects$'
# 4. device-probes.ts still calls openURL but no longer binds, branches on, or documents its resolved value (`const opened` / `opened ?` gone).
maps_probe_ignores_resolved_value

# --- notification scored by arrival -------------------------------------------------------------------------
# 5. A: the received-listener firing for the probe's own identifier scores ok('received after N s').
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeNotification reports received when the listener fires$'
# 6. A: no arrival within 15 s scores err naming the 15 s timeout and 'Settings > Notifications > Expo Go'.
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeNotification fails after 15 s with the Expo Go settings hint$'
# 7. A: the listener subscription is removed on the received path AND the timeout path.
jest_nonempty src/ui/diagnostics/__tests__/device-probes.test.ts 'probeNotification removes its listener on both paths$'
# 8. device-probes.ts subscribes addNotificationReceivedListener, calls .remove(), reports 'received after', and carries the hint verbatim.
notification_probe_observes_arrival

# --- repo-wide ----------------------------------------------------------------------------------------------
# 9. Guarded: both card files exist and gates 1-3 + 5-7's tests are present and green, then tsc (app + scripts),
#    eslint --max-warnings 0, standards checker, jest, node:test.
gate_full

echo "mfix_maps_probe: all 9 gates green"
