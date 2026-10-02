#!/usr/bin/env bash
# m7c_hurry_or_chill — HURRY OR CHILL (plan M7c.1–M7c.3; Jamie's true goal, 2026-10-01): the pure verdict engine, its copy + HurryCard, and the Now-strip / station-sheet wiring.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# Every gate below is ONE simple command on its own line (never `cmd && gate`: under `set -e` a failing
# left side does not stop the script); compound checks live in the card helpers. No gate reads a variable
# or file another gate wrote: the arrays below are fixed text. Run one gate alone, from the repo root
# (sourcing defines lib.sh + the helpers and returns before gate 1):
#   bash -c 'source "$0"; engine_is jog' scripts/ratchet/verify-m7c_hurry_or_chill.sh
#
# ---- API CONTRACT (binding: the direct-call gates import these exact names) -------------------------
# src/domain/hurry/verdict.ts — PURE (relative imports only; loads under plain node + tsx):
#   export function hurryVerdict(input: {
#     now: number; walkMeters: number;                  // epoch s; straight-line metres to the platform
#     departures: readonly { epoch: number; live: boolean; lineId: string | null; headsign: string | null;
#                            stale?: boolean }[];       // sorted by epoch; stale = live data past freshS
#     detour?: number; walkMps?: number; jogMps?: number; boardBufferS?: number; worthItGapS?: number;
#   }): HurryVerdict                                     // defaults 1.3, 1.35, 2.7, 30, 360 (plan M7c.1)
#   HurryVerdict = {
#     kind: 'CHILL' | 'JOG' | 'NOT_WORTH_IT' | 'MISSED' | 'NO_SERVICE';
#     departure: <input departure> | null;  // what the verdict is about: d1 (null only for NO_SERVICE)
#     spareS: number | null;                // CHILL slack-walkS, JOG slack-jogS, UNROUNDED seconds
#     walkS: number; jogS: number;          // walkMeters*detour/walkMps and /jogMps, unrounded
#     next: <input departure> | null;       // NOT_WORTH_IT: the following departure it points at
#     nested: HurryVerdict | null;          // MISSED: the verdict for the first catchable of d2, d3
#     live: boolean;                        // from `departure`
#     confidence: ...;                      // exactly 'low' when departure.live && departure.stale
#   }
#   slack = d.epoch - now - boardBufferS. CHILL if walkS <= slack; else JOG if jogS <= slack and the gap
#   d2.epoch - d1.epoch > worthItGapS (no d2 = last train = JOG); else NOT_WORTH_IT (jog-catchable, d2
#   within the gap); else MISSED: evaluate d2 then d3 (a bounded loop, at most 3 departures, never d4,
#   no recursion) and nest the first catchable one's verdict; [] -> NO_SERVICE.
# src/domain/hurry/platform.ts — PURE:
#   export type Platform = { stationKey: string; stopId: string; directionIds: readonly number[];
#                            latitude: number; longitude: number };
#   export function nearestPlatform(position: { latitude: number; longitude: number },
#     platforms: readonly Platform[], directionId: number | null): { platform: Platform; walkMeters: number } | null
#   — the nearest platform whose directionIds include directionId (any platform when null); walkMeters =
#   straight-line metres (src/lib/geo haversineMeters; the detour factor belongs to the verdict); null when
#   no platform serves that direction. A Mover stop serves BOTH directions (stop 813 lists 0 and 1).
# src/domain/hurry/board.ts — PURE:
#   export function hurryDepartures(rows: readonly DepartureRow[] /* m4a merge-departures */,
#     opts: { stopIds: readonly string[]; now: number; liveStale: boolean }): HurryDeparture[]
#   — rows at those stops, NOT canceled (merge rule 6 keeps canceled rows, struck through), epoch >= now,
#   sorted by epoch; mapped to { epoch, live, lineId, headsign: destName, stale: live && liveStale }.
# src/ui/hurry/copy.ts (or copy.tsx):
#   export function hurryCopy(v: HurryVerdict, ctx: { now: number; clock: (epoch: number) => string }): string
#   export function hurryInline(v, ctx): string    // Now strip inline, <= 14 characters for EVERY verdict
#   export function hurrySentence(v, ctx): string  // VoiceOver: one sentence; says "live" or "scheduled"
#   ctx.clock formats an epoch as the short local clock ("2:14"); copy never does time-zone math itself.
#
# ---- TEST-NAME CONVENTION ---------------------------------------------------------------------------
# Each acceptance case is its OWN passing jest test whose FULL name (describe titles + test title, joined
# by one space, case-insensitive) ENDS with the exact phrase below, starting at a word boundary: every pin
# is '(^| )<phrase>$' over an UNFILTERED run (lib's jest_nonempty). No phrase of this card is a suffix of
# another (case_pin re-checks that), so one catch-all test can satisfy at most one pin. Keep phrases out
# of describe titles; an outer describe in front of the phrase is fine. Write the phrases exactly
# (ASCII; no trailing punctuation or measured values).
M7C_VERDICT_PHRASES=(
  'dep 600 is CHILL with 184.8 s to spare'
  'dep 300 then 1200 is JOG with 77.4 s to spare'
  'dep 300 then 500 is NOT_WORTH_IT pointing at 500'
  'dep 150 then 900 is MISSED nesting CHILL for 900'
  'no departures is NO_SERVICE'
  'stale live departure has low confidence'
)
M7C_COPY_PHRASES=(
  'CHILL reads Chill 3 min to spare'
  'JOG reads Jog makes the 2:14 with 1 min spare'
  'NOT_WORTH_IT reads Not worth it next in 3 min'
  'MISSED reads Missed next 2:26 chill'
  'NO_SERVICE reads No more trains tonight'
  'inline JOG reads Jog'
  'inline text is at most 14 characters'
  'VoiceOver sentence says live or scheduled'
)
M7C_CARD_PHRASES=(
  'live verdict shows the Live badge'
  'scheduled verdict shows the Scheduled badge'
  'hero uses the hero variant'
  'accessibility label is the VoiceOver sentence'
  'JOG fires one Warning haptic per departure'
  'JOG fires again for a new departure'
  'CHILL fires no haptic'
)
M7C_WIRING_PHRASES=(
  'skips a closer platform of the other direction'
  'walkMeters is the straight-line distance to the platform'
  'never offers a canceled departure'
  'Now strip inline shows the hurry verdict'
  'accessory text never shows a feed hash'
)
# m5b's tab-shell test (src/ui/__tests__/tab-shell.test.tsx): its accessory case now expects NowAccessory (R2).
M7C_SHELL_PHRASES=(
  'keeps the BottomAccessory'
)
M7C_PHRASES=("${M7C_VERDICT_PHRASES[@]}" "${M7C_COPY_PHRASES[@]}" "${M7C_CARD_PHRASES[@]}" "${M7C_WIRING_PHRASES[@]}"
  "${M7C_SHELL_PHRASES[@]}")

# The plan's copy (M7c.2) and the Now-strip example (M7c.3), byte-exact (U+00B7 middle dot).
M7C_COPY_STRINGS=('Chill · 3 min to spare' 'Jog · makes the 2:14 with 1 min spare' 'Not worth it · next in 3 min'
  'Missed · next 2:26 · chill' 'No more trains tonight' 'Jog · 1 min spare')

# This card's own modules and suites (the repo-wide gates run only once they exist).
M7C_ARTIFACTS=(src/domain/hurry/verdict.ts src/domain/hurry/platform.ts src/domain/hurry/board.ts
  src/domain/hurry/__tests__/verdict.test.ts src/domain/hurry/__tests__/platform.test.ts
  src/domain/hurry/__tests__/board.test.ts src/ui/hurry/HurryCard.tsx src/ui/hurry/useHurryVerdict.ts
  src/ui/hurry/__tests__/copy.test.ts src/ui/hurry/__tests__/HurryCard.test.tsx)

# ---- card helpers (lib.sh has no direct-call oracle, phrase-universe pin, import-graph reach, regex
#      need/absence over non-test code, or mock audit; everything else comes from lib.sh) -------------

# need_files <file>... — every file exists (lib's need_file, one named failure per missing file).
need_files() {
  local f
  for f in "$@"; do need_file "$f" || return 1; done
}

# need_copy_module — the plan's src/ui/hurry/copy module exists (.ts, or .tsx as the plan's brace lists it).
need_copy_module() {
  [ -f src/ui/hurry/copy.ts ] || [ -f src/ui/hurry/copy.tsx ] \
    || { echo "ratchet: missing file src/ui/hurry/copy.ts (or copy.tsx) — the M7c.2 copy module"; return 1; }
}

# case_pin <jest path> <phrase> — the phrase must be one of M7C_PHRASES, and no card phrase may end
# another at a word boundary (authoring guard: then one test name can match only one pin). Then lib's
# jest_nonempty runs the path UNFILTERED (green, nothing failed/skipped/todo) and needs >= 1 passing test
# whose full name matches '(^| )<phrase>$' (regex metacharacters escaped), case-insensitively.
case_pin() {
  local path="$1" phrase="$2" re
  M7C_UNIVERSE="$(printf '%s\n' "${M7C_PHRASES[@]}")" node -e '
const phrase = process.argv[1];
const all = process.env.M7C_UNIVERSE.split("\n").filter((p) => p !== "");
const low = all.map((p) => p.toLowerCase());
if (!all.includes(phrase)) { console.log(`ratchet: authoring error: "${phrase}" is not a pinned phrase of this card`); process.exit(1); }
const clash = [];
if (new Set(low).size !== low.length) clash.push("duplicate phrases");
for (const a of low) for (const b of low) if (a !== b && a.endsWith(" " + b)) clash.push(`"${a}" ends with "${b}"`);
if (clash.length > 0) { console.log(`ratchet: authoring error: pinned phrases overlap (${clash.join("; ")})`); process.exit(1); }
' "$phrase" || return 1
  re="(^| )$(printf '%s' "$phrase" | sed -e 's/[][\\.*^$()+?{}|]/\\&/g')\$"
  jest_nonempty "$path" "$re"
}

# need_pure_export <file> <name>... — the module loads under PLAIN node through tsx (so it pulls in no
# react-native/expo code at runtime) and exports each <name> as a function.
need_pure_export() {
  local file="$1"
  shift
  need_file "$file" || return 1
  local_bin tsx --version >/dev/null || return 1
  node --import tsx - "$file" "$@" <<'NODE' || return 1
const [file, ...names] = process.argv.slice(2);
const href = require("node:url").pathToFileURL(require("node:path").resolve(file)).href;
import(href).then((m) => {
  const missing = names.filter((n) => typeof (m[n] ?? m.default?.[n]) !== "function");
  if (missing.length > 0) { console.log(`ratchet: ${file} does not export function(s): ${missing.join(", ")}`); process.exit(1); }
  console.log(`ratchet: ${file} loads under plain Node and exports ${names.join(", ")}`);
}, (e) => { console.log(`ratchet: ${file} does not load under plain Node (tsx): ${e.message}`); process.exit(1); });
NODE
}

# engine_is <case> — ONE direct call of the SHIPPED pure module under plain node + tsx, compared with the
# plan's numbers (independent of the builder's tests: a right-named test asserting a wrong value cannot
# pass this). Cases: chill jog not_worth_it missed no_service stale_low (plan M7c.1 A); gap_boundary
# last_train bounded_3 overrides (card additions from M7c.1's rules + inputs); platform_direction
# platform_distance board (card additions for M7c.3's walkMeters + departures).
engine_is() {
  local which="$1"
  case "$which" in
    platform_*) need_file src/domain/hurry/platform.ts || return 1 ;;
    board) need_file src/domain/hurry/board.ts || return 1 ;;
    *) need_file src/domain/hurry/verdict.ts || return 1 ;;
  esac
  node --import tsx --input-type=module - "$which" <<'NODE' || return 1
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const which = process.argv[2];
const fail = (m) => { console.log(`ratchet: engine ${which}: ${m}`); process.exit(1); };
const load = async (file, name) => {
  let m;
  try { m = await import(pathToFileURL(resolve(file)).href); } catch (e) { fail(`${file} does not load under plain Node (tsx): ${e.message}`); }
  const f = m[name] ?? m.default?.[name];
  if (typeof f !== "function") fail(`${file} exports no function ${name}`);
  return f;
};
const call = (what, f, ...args) => { try { return f(...args); } catch (e) { return fail(`${what} threw: ${e.message}`); } };
const show = (v) => JSON.stringify(v);
const eq = (got, want, what) => { if (got !== want) fail(`${what} = ${show(got)}; required ${show(want)}`); };
const near = (got, want, tol, what) => { if (typeof got !== "number" || !(Math.abs(got - want) <= tol)) fail(`${what} = ${show(got)}; plan requires ${want} ± ${tol}`); };
const dep = (epoch, live = false, stale) => ({ epoch, live, lineId: "GREEN", headsign: "Dadeland South", ...(stale === undefined ? {} : { stale }) });
async function verdictCase() {
  const H = await load("src/domain/hurry/verdict.ts", "hurryVerdict");
  const v = (epochs, extra = {}, live = false) => call(`hurryVerdict(deps ${show(epochs)} ${show(extra)})`, H, { now: 0, walkMeters: 400, departures: epochs.map((e) => dep(e, live)), ...extra });
  const epochsOf = (x) => [x?.departure?.epoch, x?.next?.epoch, x?.nested?.departure?.epoch, x?.nested?.next?.epoch];
  switch (which) {
    case "chill": { const x = v([600]); eq(x.kind, "CHILL", "kind (dep 600)"); eq(x.departure?.epoch, 600, "departure.epoch"); near(x.spareS, 184.8, 0.05, "spareS"); near(x.walkS, 385.2, 0.05, "walkS (400 m x 1.3 / 1.35)"); near(x.jogS, 192.6, 0.05, "jogS (400 m x 1.3 / 2.7)"); return "dep 600 -> CHILL, spare 184.8 s, walkS 385.2, jogS 192.6"; }
    case "jog": { const x = v([300, 1200]); eq(x.kind, "JOG", "kind (dep 300, next 1200)"); eq(x.departure?.epoch, 300, "departure.epoch"); near(x.spareS, 77.4, 0.05, "spareS"); return "dep 300 then 1200 -> JOG, spare 77.4 s"; }
    case "not_worth_it": { const x = v([300, 500]); eq(x.kind, "NOT_WORTH_IT", "kind (dep 300, next 500)"); eq(x.departure?.epoch, 300, "departure.epoch"); eq(x.next?.epoch, 500, "next.epoch (the departure it points at)"); return "dep 300 then 500 -> NOT_WORTH_IT pointing at 500"; }
    case "missed": { const x = v([150, 900]); eq(x.kind, "MISSED", "kind (dep 150, next 900)"); eq(x.departure?.epoch, 150, "departure.epoch"); eq(x.nested?.kind, "CHILL", "nested.kind"); eq(x.nested?.departure?.epoch, 900, "nested.departure.epoch"); near(x.nested?.spareS, 484.8, 0.05, "nested.spareS (870 - 385.2)"); return "dep 150 then 900 -> MISSED nesting CHILL for 900"; }
    case "no_service": { const x = v([]); eq(x.kind, "NO_SERVICE", "kind ([])"); return "[] -> NO_SERVICE"; }
    case "stale_low": {
      const stale = call("hurryVerdict(stale live dep 600)", H, { now: 0, walkMeters: 400, departures: [dep(600, true, true)] });
      eq(stale.confidence, "low", "confidence (live, stale)"); eq(stale.live, true, "live (live, stale)");
      const fresh = call("hurryVerdict(fresh live dep 600)", H, { now: 0, walkMeters: 400, departures: [dep(600, true, false)] });
      if (fresh.confidence === "low") fail("a FRESH live departure has confidence low; only stale live data is low"); eq(fresh.live, true, "live (live, fresh)");
      const sched = v([600]); if (sched.confidence === "low") fail("a scheduled departure has confidence low"); eq(sched.live, false, "live (scheduled)");
      return "stale live -> confidence low; fresh live and scheduled are not low; live carried from the departure";
    }
    case "gap_boundary": { const at = v([300, 660]); eq(at.kind, "NOT_WORTH_IT", "kind (gap exactly 360 s: JOG needs gap > worthItGapS)"); eq(at.next?.epoch, 660, "next.epoch"); const over = v([300, 661]); eq(over.kind, "JOG", "kind (gap 361 s)"); return "gap 360 -> NOT_WORTH_IT, gap 361 -> JOG (worthItGapS default 360, strict >)"; }
    case "last_train": { const x = v([300]); eq(x.kind, "JOG", "kind (dep 300, no later departure: the last train is always worth a jog)"); near(x.spareS, 77.4, 0.05, "spareS"); return "a jog-catchable last train -> JOG"; }
    case "bounded_3": { const x = v([100, 110, 120, 2000]); eq(x.kind, "MISSED", "kind (d1..d3 all missed)"); eq(x.departure?.epoch, 100, "departure.epoch"); if (epochsOf(x).includes(2000)) fail("the verdict reached d4 (epoch 2000); the MISSED loop evaluates at most 3 departures"); return "d1..d3 missed -> MISSED, d4 never evaluated"; }
    case "overrides": {
      eq(v([600, 1200], { walkMps: 0.9 }).kind, "JOG", "kind with walkMps 0.9 (default would be CHILL)");
      eq(v([300, 1200], { jogMps: 1.5 }).kind, "MISSED", "kind with jogMps 1.5 (default would be JOG)");
      const d = v([450, 2000], { detour: 2 }); eq(d.kind, "JOG", "kind with detour 2 (default would be CHILL)"); near(d.walkS, 592.6, 0.05, "walkS with detour 2");
      eq(v([400, 2000], { boardBufferS: 0 }).kind, "CHILL", "kind with boardBufferS 0 (default would be JOG)");
      eq(v([300, 1200], { worthItGapS: 1000 }).kind, "NOT_WORTH_IT", "kind with worthItGapS 1000 (default would be JOG)");
      return "detour, walkMps, jogMps, boardBufferS and worthItGapS each override their default";
    }
    default: return fail("unknown engine case");
  }
}
async function platformCase() {
  const N = await load("src/domain/hurry/platform.ts", "nearestPlatform");
  const geo = await load("src/lib/geo.ts", "haversineMeters");
  const P = { latitude: 25.7743, longitude: -80.1937 };
  const pf = (stationKey, stopId, directionIds, latitude) => ({ stationKey, stopId, directionIds, latitude, longitude: -80.1937 });
  const C0 = pf("rail:c", "C0", [0], 25.7748), A1 = pf("rail:a", "A1", [1], 25.7753), A0 = pf("rail:a", "A0", [0], 25.7754);
  const B = pf("mover:b", "B01", [0, 1], 25.7763), D1 = pf("rail:d", "D1", [1], 25.7843);
  const all = [D1, B, A0, A1, C0];
  const pick = (list, dir) => call(`nearestPlatform(P, ${show(list.map((p) => p.stopId))}, ${dir})`, N, P, list, dir);
  if (which === "platform_direction") {
    eq(pick(all, 1)?.platform?.stopId, "A1", "direction 1 platform (C0 is closer but serves only direction 0)");
    eq(pick(all, 0)?.platform?.stopId, "C0", "direction 0 platform");
    eq(pick(all, null)?.platform?.stopId, "C0", "nearest platform with no direction");
    eq(pick([C0, B], 1)?.platform?.stopId, "B01", "a stop serving both directions (Mover) for direction 1");
    eq(pick([C0], 1), null, "no platform serves direction 1");
    eq(pick([], null), null, "no platforms");
    return "nearest platform in the trip direction; two-direction stops match either; null when none";
  }
  const hit = pick(all, 1);
  near(hit?.walkMeters, geo(P, A1), 0.5, "walkMeters to A1 (straight-line haversine, no detour)");
  return `walkMeters = ${hit.walkMeters.toFixed(1)} m, the straight-line distance`;
}
async function boardCase() {
  const B = await load("src/domain/hurry/board.ts", "hurryDepartures");
  const row = (key, stopId, epoch, live, canceled) => ({ key, tripId: key, stopId, lineId: "GREEN", destName: "Dadeland South", epoch, scheduledEpoch: epoch, delayS: live && !canceled ? 0 : null, live, canceled, departure: null, prediction: null });
  const rows = [row("t1", "S1", 100, false, false), row("t2", "S1", 400, true, true), row("t3", "S2", 450, false, false), row("t4", "S1", 500, true, false), row("t5", "S1", 700, false, false)];
  const out = call("hurryDepartures(stale)", B, rows, { stopIds: ["S1"], now: 200, liveStale: true });
  if (!Array.isArray(out)) fail(`hurryDepartures returned ${show(out)}, not an array`);
  eq(show(out.map((d) => d.epoch)), show([500, 700]), "epochs (drops the canceled 400, the other platform's 450 and the past 100)");
  eq(out[0].live, true, "[0].live"); eq(out[0].stale, true, "[0].stale (live data past freshS)"); eq(out[0].lineId, "GREEN", "[0].lineId"); eq(out[0].headsign, "Dadeland South", "[0].headsign (from destName)");
  eq(out[1].live, false, "[1].live"); if (out[1].stale) fail("a scheduled departure is never stale");
  const fresh = call("hurryDepartures(fresh)", B, rows, { stopIds: ["S1"], now: 200, liveStale: false });
  if (fresh[0]?.stale) fail("with fresh live data no departure is stale");
  return "canceled, other-platform and past rows dropped; live/stale/lineId/headsign mapped";
}
const run = which.startsWith("platform_") ? platformCase : which === "board" ? boardCase : verdictCase;
console.log(`ratchet: engine ${which}: ${await run()}`);
NODE
}

# copy_is <case> — ONE call of the SHIPPED src/ui/hurry/copy module, fed verdicts made by the SHIPPED
# engine, under the repo's own jest (jest-expo/ios: the app's babel transform and `@/` resolution), via a
# throwaway oracle test in the gitignored .cache (removed whether the check passes or fails). Cases:
# chill jog not_worth_it missed no_service (the plan's five strings, byte-exact), inline_jog ("Jog"; mfix8 labelled copy: the inline verdict is the word alone),
# inline_max14 (every verdict, a 2-hour CHILL and an all-missed board included), sentence (VoiceOver).
copy_is() {
  local which="$1" dir out rc=0
  need_copy_module || return 1
  need_file src/domain/hurry/verdict.ts || return 1
  mkdir -p .cache || { echo "ratchet: cannot create .cache"; return 1; }
  dir="$PWD/.cache/ratchet-m7c-oracle.$$.$RANDOM"
  mkdir -p "$dir" || { echo "ratchet: cannot create $dir"; return 1; }
  cat > "$dir/copy.oracle.test.ts" <<'TS'
const path = require('node:path');
const CASE = process.env.M7C_CASE ?? '';
const fail = (m: string): never => { throw new Error(`ratchet-oracle: ${CASE}: ${m}`); };
const show = (v: unknown): string =>
  typeof v === 'string' ? JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : `${typeof v} ${String(v)}`;
const load = (rel: string, names: string[]): Record<string, any> => {
  let mod: Record<string, any> = {};
  try { mod = require(path.join(process.cwd(), rel)); } catch (e) { fail(`${rel} does not load under jest: ${(e as Error).message}`); }
  for (const n of names) if (typeof mod[n] !== 'function') fail(`${rel} exports no function ${n}`);
  return mod;
};
const { hurryVerdict } = load('src/domain/hurry/verdict', ['hurryVerdict']);
const { hurryCopy, hurryInline, hurrySentence } = load('src/ui/hurry/copy', ['hurryCopy', 'hurryInline', 'hurrySentence']);
const dep = (epoch: number, live: boolean) => ({ epoch, live, lineId: 'GREEN', headsign: 'Dadeland South' });
const verdict = (walkMeters: number, epochs: number[], live = false) => hurryVerdict({ now: 0, walkMeters, departures: epochs.map((e) => dep(e, live)) });
const CLOCK: Record<number, string> = { 300: '2:14', 900: '2:26' };
const ctx = { now: 0, clock: (e: number) => CLOCK[e] ?? '9:59' };
const kindIs = (v: any, k: string) => { if (v?.kind !== k) fail(`the engine gave ${show(v?.kind)}, expected ${k} — fix the engine first`); };
const same = (got: unknown, want: string, what: string) => { if (got !== want) fail(`${what} returned ${show(got)}; the plan requires ${show(want)}`); };
const board = () => ({
  chill: verdict(400, [600]), twoHourChill: verdict(400, [7200]), jog: verdict(400, [300, 1200]), notWorthIt: verdict(400, [300, 500]),
  missed: verdict(400, [150, 900]), allMissed: verdict(400, [100, 110, 120, 2000]), noService: verdict(400, []),
});
const CASES: Record<string, () => void> = {
  chill: () => { const v = verdict(400, [600]); kindIs(v, 'CHILL'); same(hurryCopy(v, ctx), 'Chill · 3 min to spare', 'hurryCopy(CHILL dep 600)'); },
  jog: () => { const v = verdict(400, [300, 1200]); kindIs(v, 'JOG'); same(hurryCopy(v, ctx), 'Jog · makes the 2:14 with 1 min spare', 'hurryCopy(JOG dep 300 at 2:14)'); },
  not_worth_it: () => { const v = verdict(100, [100, 180]); kindIs(v, 'NOT_WORTH_IT'); same(hurryCopy(v, ctx), 'Not worth it · next in 3 min', 'hurryCopy(NOT_WORTH_IT, next 180 s away)'); },
  missed: () => { const v = verdict(400, [150, 900]); kindIs(v, 'MISSED'); same(hurryCopy(v, ctx), 'Missed · next 2:26 · chill', 'hurryCopy(MISSED, nested CHILL at 2:26)'); },
  no_service: () => { const v = verdict(400, []); kindIs(v, 'NO_SERVICE'); same(hurryCopy(v, ctx), 'No more trains tonight', 'hurryCopy(NO_SERVICE)'); },
  inline_jog: () => { const v = verdict(400, [300, 1200]); kindIs(v, 'JOG'); same(hurryInline(v, ctx), 'Jog', 'hurryInline(JOG, 77.4 s spare)'); },
  inline_max14: () => {
    const wide = { now: 0, clock: () => '12:59' };
    for (const [name, v] of Object.entries(board())) {
      const s = hurryInline(v, wide);
      if (typeof s !== 'string' || s.trim().length === 0 || [...s].length > 14) fail(`hurryInline(${name}) = ${show(s)}: inline text must be 1-14 characters for every verdict`);
    }
  },
  sentence: () => {
    for (const [name, v] of Object.entries(board())) {
      const s = hurrySentence(v, ctx);
      if (typeof s !== 'string' || !/^[A-Z]/.test(s) || !/\.$/.test(s) || s.includes('·') || s.trim().split(/\s+/).length < 4) {
        fail(`hurrySentence(${name}) = ${show(s)} is not one full sentence (capital first letter, ends with ".", no "·", >= 4 words)`);
      }
    }
    const live = hurrySentence(verdict(400, [600], true), ctx);
    if (!/\blive\b/i.test(live) || /\bscheduled\b/i.test(live)) fail(`a live CHILL sentence must say "live" (and not "scheduled"): ${show(live)}`);
    const sched = hurrySentence(verdict(400, [600], false), ctx);
    if (!/\bscheduled\b/i.test(sched) || /\blive\b/i.test(sched)) fail(`a scheduled CHILL sentence must say "scheduled" (and not "live"): ${show(sched)}`);
  },
};
it('ratchet oracle', () => {
  const run = CASES[CASE];
  if (run === undefined) fail('unknown oracle case');
  run();
  expect(CASE.length).toBeGreaterThan(0);
});
TS
  out=$(M7C_CASE="$which" local_bin jest --ci --rootDir "$PWD" --roots "$dir" --testMatch '**/*.oracle.test.ts' 2>&1) || rc=$?
  rm -rf "$dir"
  if [ "$rc" -ne 0 ]; then
    if echo "$out" | _qgrep "ratchet-oracle:"; then echo "$out" | grep -m1 "ratchet-oracle:"; else echo "$out" | tail -25; fi
    echo "ratchet: copy oracle '$which' failed"; return 1
  fi
  echo "$out" | _qgrep -E "Tests: +1 passed, 1 total" \
    || { echo "$out" | tail -15; echo "ratchet: the copy oracle '$which' did not run"; return 1; }
  echo "ratchet: copy oracle '$which' holds on the shipped copy + engine"
}

# need_lits <file-or-dir> <string>... — the path exists and contains EVERY fixed string (tests included).
need_lits() {
  local path="$1" s
  shift
  [ -e "$path" ] || { echo "ratchet: missing $path — the milestone's tests do not exist yet"; return 1; }
  for s in "$@"; do
    grep -rqF -- "$s" "$path" || { echo "ratchet: '$s' does not appear in $path"; return 1; }
  done
}

# need_all <file> <ERE>... — the file exists and matches EVERY extended regex.
need_all() {
  local file="$1" re
  shift
  need_file "$file" || return 1
  for re in "$@"; do
    grep -qE -- "$re" "$file" || { echo "ratchet: expected /$re/ in $file"; return 1; }
  done
}

# need_src <dir> <ERE>... — the dir exists and EVERY regex matches some NON-TEST .ts/.tsx line under it.
need_src() {
  local dir="$1" re rc
  shift
  [ -d "$dir" ] || { echo "ratchet: missing $dir"; return 1; }
  for re in "$@"; do
    rc=0
    grep -rqE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ -- "$re" "$dir" || rc=$?
    [ "$rc" -eq 0 ] && continue
    [ "$rc" -eq 1 ] && { echo "ratchet: expected /$re/ in non-test code under $dir"; return 1; }
    echo "ratchet: grep failed (exit $rc) scanning $dir"; return 1
  done
}

# absent_src <ERE> <dir>... — every dir exists and NO non-test .ts/.tsx line under them matches. (A
# function, not `! grep`: bash's `set -e` ignores a failing `!`-negated command.) grep exit 2 is an error.
absent_src() {
  local re="$1" d hits rc=0
  shift
  for d in "$@"; do [ -d "$d" ] || { echo "ratchet: missing $d"; return 1; }; done
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ -- "$re" "$@") || rc=$?
  [ "$rc" -le 1 ] || { echo "ratchet: grep failed (exit $rc) scanning $*"; return 1; }
  [ -z "$hits" ] || { echo "$hits" | head -5; echo "ratchet: forbidden /$re/ in non-test code under $*"; return 1; }
}

# reaches <entry> <ERE>... — the entry exists and its VALUE-import closure (TypeScript AST; `import type`
# is erased; ./ ../ and @/ specifiers followed to .ts/.tsx files, plus require()/import()) contains, for
# every ERE (case-insensitive), a repo path or an external package recorded as 'pkg:<specifier>'. An ERE
# written '!<ERE>' is the opposite: NO path in the closure may match it (an import-graph absence, so a
# comment naming the module neither fails it nor an aliased re-export slips past it).
# Walked with an explicit queue (no recursion).
reaches() {
  need_file "$1" || return 1
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [entry, ...patterns] = process.argv.slice(2);
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const EXT = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];
function resolveSpec(from, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  if (base === null) return null;
  const hit = EXT.map((e) => base + e).find((p) => /\.tsx?$/.test(p) && isFile(p));
  return hit === undefined ? null : hit;
}
function typeOnly(clause) {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return clause.name === undefined && named !== undefined && ts.isNamedImports(named)
    && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
}
function specsOf(abs) {
  const kind = abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const stack = [sf];
  for (let guard = 0; stack.length > 0 && guard < 200000; guard += 1) {
    const n = stack.pop();
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!typeOnly(n.importClause)) out.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, (k) => { stack.push(k); });
  }
  return out;
}
const start = path.resolve(ROOT, entry);
const queue = [start];
const seen = new Set(queue);
const found = new Set([rel(start)]);
for (let i = 0; i < queue.length && i < 5000; i += 1) {
  for (const spec of specsOf(queue[i])) {
    const next = resolveSpec(queue[i], spec);
    if (next === null) {
      if (!spec.startsWith('.') && !spec.startsWith('@/')) found.add(`pkg:${spec}`);
      continue;
    }
    if (!seen.has(next)) { seen.add(next); queue.push(next); found.add(rel(next)); }
  }
}
const all = [...found];
const wanted = patterns.filter((p) => !p.startsWith('!'));
const banned = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
const missing = wanted.filter((p) => !all.some((f) => new RegExp(p, 'i').test(f)));
if (missing.length > 0) {
  fail(`${entry} never imports (directly or transitively, value imports only) a module matching ${missing.map((p) => `/${p}/i`).join(', ')}; it reaches: ${all.filter((f) => f.startsWith('src/')).join(', ')}`);
}
const forbidden = all.filter((f) => banned.some((p) => new RegExp(p, 'i').test(f)));
if (forbidden.length > 0) fail(`${entry} must not reach ${banned.map((p) => `/${p}/i`).join(', ')}, but its value-import closure holds ${forbidden.join(', ')}`);
console.log(`ratchet: ${entry} reaches ${wanted.map((p) => `/${p}/i`).join(', ') || 'only allowed modules'}${banned.length > 0 ? ` and never ${banned.map((p) => `/${p}/i`).join(', ')}` : ''}`);
NODE
}

# wired_into <entry> <ERE>... — this card's wiring modules exist first (so an unbuilt card fails on its
# OWN artifact), then <entry> (m6b's station route, or this card's Now accessory) reaches every ERE.
wired_into() {
  need_files src/ui/hurry/useHurryVerdict.ts src/ui/hurry/HurryCard.tsx || return 1
  need_copy_module || return 1
  reaches "$@"
}

# native_mocks_labelled <test-dir>... — every jest.mock/doMock in these test dirs names a module by
# literal, carries '// test-time mock of native module' on its line or the line above, and mocks a NATIVE
# module (expo*, @expo/*, react-native*, @react-native*). Mocking our own code is a stub.
native_mocks_labelled() {
  local d
  for d in "$@"; do [ -d "$d" ] || { echo "ratchet: missing $d — the milestone's tests do not exist yet"; return 1; }; done
  node - "$@" <<'NODE' || return 1
const fs = require('node:fs'), path = require('node:path');
const LABEL = 'test-time mock of native module';
const NATIVE = /^(expo([-/][\w./-]*)?|@expo\/[\w./-]+|react-native([-/][\w./-]*)?|@react-native(-[\w-]+)?\/[\w./-]+)$/;
const files = [], todo = process.argv.slice(2), problems = [];
for (let guard = 0; todo.length > 0 && guard < 10000; guard++) {
  const p = todo.pop();
  if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
  else if (/\.(ts|tsx|js|jsx)$/.test(p)) files.push(p);
}
let mocks = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8'), lines = text.split('\n');
  const calls = (text.match(/jest\.(mock|doMock)\(/g) || []).length;
  const re = /jest\.(mock|doMock)\(\s*(['"`])([^'"`]+)\2/g;
  let m, literal = 0;
  while ((m = re.exec(text)) !== null) {
    literal++; mocks++;
    const n = text.slice(0, m.index).split('\n').length - 1;
    const near = `${lines[n] ?? ''}\n${lines[n - 1] ?? ''}`;
    if (!near.includes(LABEL)) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") lacks the "// ${LABEL}" label`);
    if (!NATIVE.test(m[3])) problems.push(`${f}:${n + 1} jest.${m[1]}("${m[3]}") mocks a non-native module (a stub of our own code)`);
  }
  if (literal !== calls) problems.push(`${f}: ${calls - literal} jest.mock call(s) without a literal module name`);
}
if (problems.length > 0) { console.log(problems.join('\n')); console.log('ratchet: test-time mocks must be labelled native modules only'); process.exit(1); }
console.log(`ratchet: ${files.length} test files, ${mocks} labelled native-module mocks`);
NODE
}

# _m7c_ast <cmd> <args>... — checks over the TypeScript AST (comments are trivia, never nodes, so a comment
# or a string naming a thing never satisfies them). Explicit stacks, no recursion.
#   calls <dir> <name>                 a NON-TEST .ts/.tsx under <dir> calls name(…) or x.name(…)
#   mounts <file> <outer> <inner>      <file> renders a JSX <inner> element inside a JSX <outer> element
#   uses <file> <name> <spec-ERE>      <file> value-imports <name> from a specifier matching ^ERE$ AND
#                                      references <name> outside the import
_m7c_ast() {
  node - "$@" <<'NODE' || return 1
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.cwd();
const fail = (m) => { console.log(`ratchet: ${m}`); process.exit(1); };
let ts;
try { ts = require(path.join(ROOT, 'node_modules', 'typescript')); } catch (e) { fail(`typescript is not installed in node_modules (${e.message})`); }
const [cmd, target, a, b] = process.argv.slice(2);
if (!fs.existsSync(target)) fail(`missing ${target}`);
const parse = (f) => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function nodes(root) {
  const out = [], stack = [root];
  for (let g = 0; stack.length > 0 && g < 500000; g += 1) { const n = stack.pop(); out.push(n); ts.forEachChild(n, (k) => { stack.push(k); }); }
  return out;
}
const tag = (el, sf) => el.tagName.getText(sf);
if (cmd === 'calls') {
  const files = [], todo = [target];
  for (let g = 0; todo.length > 0 && g < 10000; g += 1) {
    const p = todo.pop();
    if (fs.statSync(p).isDirectory()) { if (path.basename(p) !== '__tests__') for (const e of fs.readdirSync(p)) todo.push(path.join(p, e)); }
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
  }
  const hit = files.find((f) => nodes(parse(f)).some((n) => ts.isCallExpression(n)
    && ((ts.isIdentifier(n.expression) && n.expression.text === a) || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === a))));
  if (hit === undefined) fail(`no non-test code under ${target} calls ${a}(…) (comments and strings do not count; searched ${files.length} files)`);
  console.log(`ratchet: ${hit} calls ${a}(…)`);
} else if (cmd === 'mounts') {
  const sf = parse(target);
  const outers = nodes(sf).filter((n) => ts.isJsxElement(n) && tag(n.openingElement, sf) === a);
  const inside = outers.some((o) => nodes(o).some((n) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n !== o.openingElement && tag(n, sf) === b));
  if (!inside) fail(`${target} renders no <${b}> element inside a <${a}> element (${outers.length} <${a}> found; comments do not count)`);
  console.log(`ratchet: ${target} mounts <${b}> inside <${a}>`);
} else if (cmd === 'uses') {
  const sf = parse(target), re = new RegExp(`^(${b})$`);
  const imp = sf.statements.find((s) => ts.isImportDeclaration(s) && !(s.importClause && s.importClause.isTypeOnly) && re.test(s.moduleSpecifier.text)
    && s.importClause && s.importClause.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some((e) => !e.isTypeOnly && e.name.text === a));
  if (imp === undefined) fail(`${target} does not value-import { ${a} } from /^(${b})$/`);
  const refs = nodes(sf).filter((n) => ts.isIdentifier(n) && n.text === a && !(n.pos >= imp.pos && n.end <= imp.end));
  if (refs.length === 0) fail(`${target} imports ${a} but never uses it`);
  console.log(`ratchet: ${target} imports ${a} and uses it ${refs.length} time(s)`);
} else fail(`unknown _m7c_ast command '${cmd}'`);
NODE
}

# now_strip_calls_inline — this card's copy module exists first, then its Now accessory (src/ui/now, non-test)
# calls hurryInline: the inline (<= 14-character) verdict text is what the accessory shows.
now_strip_calls_inline() {
  need_copy_module || return 1
  need_src src/ui/now 'hurryInline\('
}

# accessory_replaces_data_version — the tab bar's BottomAccessory shows this card's NowAccessory INSTEAD of
# the debug DataVersionAccessory (ruling R2: the data version stays reachable in Data & Settings /
# Diagnostics, not in the accessory). An import-graph absence, not a text check: the tab layout's value-import
# closure reaches NowAccessory.tsx and NEVER src/ui/diagnostics/DataVersionAccessory.tsx — so a doc comment
# naming the old accessory does not fail it, and an aliased import or re-export of it does not slip past.
accessory_replaces_data_version() {
  need_file src/ui/now/NowAccessory.tsx || return 1
  reaches 'src/app/(tabs)/_layout.tsx' 'src/ui/now/NowAccessory\.tsx$' '!src/ui/diagnostics/DataVersionAccessory\.tsx$'
}

# tab_shell_expects_now — m5b's tab-shell test keeps its accessory case, now about the accessory the layout
# really mounts (R2: the ONE m5b test change m7c may make): the test value-imports NowAccessory from the
# module the layout reaches and uses it, and its 'keeps the BottomAccessory' case passes (unfiltered run).
tab_shell_expects_now() {
  local test=src/ui/__tests__/tab-shell.test.tsx
  need_file src/ui/now/NowAccessory.tsx || return 1
  _m7c_ast uses "$test" NowAccessory '\.\./now/NowAccessory|@/ui/now/NowAccessory' || return 1
  case_pin "$test" 'keeps the BottomAccessory'
}

# full_gate_built — the repo-wide gate, run only once this card's modules and suites exist (on an unbuilt
# tree it would merely re-prove earlier cards' green).
full_gate_built() {
  need_files "${M7C_ARTIFACTS[@]}" || return 1
  need_copy_module || return 1
  full_gate
}

# ios_export_built — a fresh iOS export (lib's ios_export), run only once this card's modules exist AND the
# tab layout reaches NowAccessory and, through it, the hurry hook, so Metro has to bundle the hurry code.
ios_export_built() {
  need_files "${M7C_ARTIFACTS[@]}" || return 1
  need_copy_module || return 1
  reaches 'src/app/(tabs)/_layout.tsx' 'src/ui/now/NowAccessory\.tsx$' 'src/ui/hurry/useHurryVerdict\.ts$' || return 1
  ios_export
}

if (return 0 2>/dev/null); then return 0; fi
trap 'echo "ratchet: m7c_hurry_or_chill gate failed at verify script line $LINENO"' ERR

# ===== M7c.1 Verdict engine (pure) =====================================================================
# 1. src/domain/hurry/verdict.ts is pure (loads under plain node + tsx) and exports hurryVerdict.
need_pure_export src/domain/hurry/verdict.ts hurryVerdict
# 2. A, shipped code: now 0, walkMeters 400, dep 600 -> CHILL, spare 184.8 s; walkS 385.2, jogS 192.6 (defaults 1.3 / 1.35 / 2.7 / 30).
engine_is chill
# 3. A, shipped code: dep 300 then 1200 -> JOG, spare 77.4 s.
engine_is jog
# 4. A, shipped code: dep 300 then 500 -> NOT_WORTH_IT, pointing (next) at 500.
engine_is not_worth_it
# 5. A, shipped code: dep 150 then 900 -> MISSED, nesting CHILL for 900 (spare 484.8 s).
engine_is missed
# 6. A, shipped code: [] -> NO_SERVICE.
engine_is no_service
# 7. A, shipped code: a stale live departure -> confidence 'low' (fresh live and scheduled are not low); live carried from the departure.
engine_is stale_low
# 8. Card addition (rule 2 "gap > worthItGapS", default 360): gap 360 -> NOT_WORTH_IT, 361 -> JOG.
engine_is gap_boundary
# 9. Card addition: a jog-catchable departure with no later one (the last train) -> JOG, never NOT_WORTH_IT.
engine_is last_train
# 10. Card addition (rule 4 "bounded loop of at most 3"): d1..d3 all missed -> MISSED; d4 is never evaluated.
engine_is bounded_3
# 11. Card addition (paces are user settings, M7c.3): detour, walkMps, jogMps, boardBufferS and worthItGapS each override their default.
engine_is overrides
# 12-17. A, named tests: each plan case is its own passing jest test (full name ends with the phrase).
case_pin src/domain/hurry/__tests__/verdict.test.ts 'dep 600 is CHILL with 184.8 s to spare'
case_pin src/domain/hurry/__tests__/verdict.test.ts 'dep 300 then 1200 is JOG with 77.4 s to spare'
case_pin src/domain/hurry/__tests__/verdict.test.ts 'dep 300 then 500 is NOT_WORTH_IT pointing at 500'
case_pin src/domain/hurry/__tests__/verdict.test.ts 'dep 150 then 900 is MISSED nesting CHILL for 900'
case_pin src/domain/hurry/__tests__/verdict.test.ts 'no departures is NO_SERVICE'
case_pin src/domain/hurry/__tests__/verdict.test.ts 'stale live departure has low confidence'
# 18. Plan V (M7c.1): `jest src/domain/hurry` is non-empty and green, nothing skipped.
jest_nonempty src/domain/hurry

# ===== M7c.2 Copy + HurryCard ==========================================================================
# 19-23. Plan copy, byte-exact, on the shipped copy fed by the shipped engine (clock injected: 300 -> 2:14, 900 -> 2:26).
copy_is chill
copy_is jog
copy_is not_worth_it
copy_is missed
copy_is no_service
# 24. M7c.3's inline example on the shipped copy: JOG with 77.4 s spare -> "Jog · 1 min".
copy_is inline_jog
# 25. M7c.3: the inline text is 1-14 characters for EVERY verdict (a 2-hour CHILL and an all-missed board included).
copy_is inline_max14
# 26. M7c.2 "VoiceOver label is a full sentence": capital, ends with ".", no "·", >= 4 words; says "live" / "scheduled" (the label hides the badge).
copy_is sentence
# 27. The copy tests assert the plan's strings literally (U+00B7 middle dot).
need_lits src/ui/hurry/__tests__/copy.test.ts "${M7C_COPY_STRINGS[@]}"
# 28-35. Named copy tests, one per case.
case_pin src/ui/hurry/__tests__/copy.test.ts 'CHILL reads Chill 3 min to spare'
case_pin src/ui/hurry/__tests__/copy.test.ts 'JOG reads Jog makes the 2:14 with 1 min spare'
case_pin src/ui/hurry/__tests__/copy.test.ts 'NOT_WORTH_IT reads Not worth it next in 3 min'
case_pin src/ui/hurry/__tests__/copy.test.ts 'MISSED reads Missed next 2:26 chill'
case_pin src/ui/hurry/__tests__/copy.test.ts 'NO_SERVICE reads No more trains tonight'
case_pin src/ui/hurry/__tests__/copy.test.ts 'inline JOG reads Jog'
case_pin src/ui/hurry/__tests__/copy.test.ts 'inline text is at most 14 characters'
case_pin src/ui/hurry/__tests__/copy.test.ts 'VoiceOver sentence says live or scheduled'
# 36. HurryCard renders the hero through m5a's TText with variant 'hero', and its accessibilityLabel is the copy module's hurrySentence.
need_all src/ui/hurry/HurryCard.tsx "from ['\"][^'\"]*/TText['\"]" "variant=\\{?['\"]hero['\"]" 'accessibilityLabel' 'hurrySentence' "from ['\"][^'\"]*/copy['\"]"
# 37. The JOG cue is a Warning haptic from expo-haptics, in this card's non-test UI code.
need_src src/ui/hurry "from ['\"]expo-haptics['\"]" 'NotificationFeedbackType\.Warning'
# 38-44. Named HurryCard tests, one per case.
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'live verdict shows the Live badge'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'scheduled verdict shows the Scheduled badge'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'hero uses the hero variant'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'accessibility label is the VoiceOver sentence'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'JOG fires one Warning haptic per departure'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'JOG fires again for a new departure'
case_pin src/ui/hurry/__tests__/HurryCard.test.tsx 'CHILL fires no haptic'
# 45. Every jest.mock in this card's tests is a LABELLED NATIVE-module mock (no stubs of our own code).
native_mocks_labelled src/domain/hurry/__tests__ src/ui/hurry/__tests__
# 46. Plan V (M7c.2): `jest src/ui/hurry` is non-empty and green, nothing skipped.
jest_nonempty src/ui/hurry
# 47. Plan §4 step 10 (the phone never does time-zone math): no Date/Intl clock code in this card's non-test code.
absent_src 'new Date\(|Intl\.DateTimeFormat|toLocale(Date|Time)?String|getU?T?C?Hours\(|getTimezoneOffset' src/domain/hurry src/ui/hurry

# ===== M7c.3 Wiring ====================================================================================
# 48. Location -> nearest platform: src/domain/hurry/platform.ts is pure and exports nearestPlatform.
need_pure_export src/domain/hurry/platform.ts nearestPlatform
# 49. Card addition, shipped code: the nearest platform IN THE TRIP DIRECTION (a closer wrong-direction platform is skipped; a two-direction Mover stop matches either; null when none).
engine_is platform_direction
# 50. Card addition, shipped code: walkMeters is the straight-line (haversine) distance to that platform.
engine_is platform_distance
# 51-52. Named platform tests.
case_pin src/domain/hurry/__tests__/platform.test.ts 'skips a closer platform of the other direction'
case_pin src/domain/hurry/__tests__/platform.test.ts 'walkMeters is the straight-line distance to the platform'
# 53. Departures from the schedule + live merge: src/domain/hurry/board.ts is pure and exports hurryDepartures.
need_pure_export src/domain/hurry/board.ts hurryDepartures
# 54. Card addition, shipped code: canceled (merge rule 6 keeps them, struck through), other-platform and past rows are never offered; live/stale mapped.
engine_is board
# 55. Named board test.
case_pin src/domain/hurry/__tests__/board.test.ts 'never offers a canceled departure'
# 56. The hook composes the real pieces: the verdict, platform and board modules, m4a's merge, m4b's live context, m8b's walking-pace settings (paces) and expo-location.
reaches src/ui/hurry/useHurryVerdict.ts 'src/domain/hurry/verdict\.ts$' 'src/domain/hurry/platform\.ts$' 'src/domain/hurry/board\.ts$' 'src/domain/live/merge-departures\.ts$' 'src/live/live-context\.tsx$' 'src/ui/settings/walking-pace\.ts$' '^pkg:expo-location$'
# 57. Staleness uses the per-provider fresh threshold (§3 / constants.ts freshS: Swiftly 75 s, Transitland 180 s since mfix3 — the feed-fresh limit), not a flat number.
need_src src/ui/hurry '\.freshS\b'
# 58. The Now accessory module exists where the plan puts it (moved from m7b gate 12 by ruling R2; m7b extends it later with trip context).
need_file src/ui/now/NowAccessory.tsx
# 59. Inline vs regular text follows the real accessory placement: non-test src/ui/now CALLS NativeTabs.BottomAccessory.usePlacement() (moved from m7b gate 14; an AST call — a comment or string does not count).
_m7c_ast calls src/ui/now usePlacement
# 60. NowAccessory is mounted in the tab bar's BottomAccessory: a JSX <NowAccessory> element inside <NativeTabs.BottomAccessory> (moved from m7b gate 16; AST, so a JSX comment does not count).
_m7c_ast mounts 'src/app/(tabs)/_layout.tsx' NativeTabs.BottomAccessory NowAccessory
# 61. ...and that element is the real module: the tab layout's value-import closure reaches src/ui/now/NowAccessory.tsx.
reaches 'src/app/(tabs)/_layout.tsx' 'src/ui/now/NowAccessory\.tsx$'
# 62. R2: NowAccessory REPLACES the debug DataVersionAccessory: the layout's import closure never reaches src/ui/diagnostics/DataVersionAccessory.tsx (the data version lives on in Data & Settings / Diagnostics).
accessory_replaces_data_version
# 63. m5b's tab-shell accessory case now expects NowAccessory (the one m5b test change R2 allows), imported from the mounted module, and passes.
tab_shell_expects_now
# 64. R2 (mfix2's accessory contract, carried to the accessory that replaces it): a Now-accessory test under src/ui/now
#     — its own passing case — asserts the rendered accessory text never shows a feed hash (no /Data [0-9a-f]{6,}/).
case_pin src/ui/now 'accessory text never shows a feed hash'
# 65. The Now strip (this card's NowAccessory) reaches the hook and the copy...
wired_into src/ui/now/NowAccessory.tsx 'src/ui/hurry/useHurryVerdict\.ts$' 'src/ui/hurry/copy\.tsx?$'
# 66. ...and its non-test code calls hurryInline (the <= 14-character inline text).
now_strip_calls_inline
# 67. Named Now-strip test (anywhere under src/ui/now), asserting the plan's inline example literally.
case_pin src/ui/now 'Now strip inline shows the hurry verdict'
# 68. The Now-strip tests carry the inline example "Jog · 1 min".
need_lits src/ui/now/__tests__ 'Jog · 1 min spare'
# 69. The station sheet header (m6b's route) reaches HurryCard and the hook.
wired_into 'src/app/station/[stationKey].tsx' 'src/ui/hurry/HurryCard\.tsx$' 'src/ui/hurry/useHurryVerdict\.ts$'

# ===== Whole card ======================================================================================
# 70. Repo-wide gate (tsc app + scripts, eslint incl. src/domain purity, standards incl. no recursion, jest, node:test), once this card's modules exist.
full_gate_built
# 71. Metro bundles the app for iOS with the hurry code reached from the tab layout through the mounted Now accessory.
ios_export_built

echo "m7c_hurry_or_chill: all 71 gates green"
