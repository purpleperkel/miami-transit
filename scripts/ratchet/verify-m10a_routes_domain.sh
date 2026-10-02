#!/usr/bin/env bash
# m10a_routes_domain — route options domain (plan M10a.1–M10a.3): the Transitous /api/v5/plan client (exact
# URL, exact User-Agent, no key), the itinerary parser over a REAL captured Government Center -> Brickell
# response, the live overlay of m4a predictions onto rail/Mover legs, the first-leg hurry-or-chill verdict
# (m7c's engine), and the polite client (one request in flight, 60 s cache, 429/5xx retry, debounce).
# FIXTURE-ONLY: no gate calls the network. The direct checks import the card's pure modules through tsx.
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/../.."

# ---- Card constants (shared, read-only; no gate reads another gate's output) ----
ROUTES=src/domain/routes
TRANSITOUS=$ROUTES/transitous.ts
OVERLAY=$ROUTES/overlay.ts
POLITE=$ROUTES/polite-client.ts
FIXTURE=$ROUTES/__fixtures__/transitous-plan.json
CAPTURE=$ROUTES/__fixtures__/transitous-plan.capture.json
T_TRANSITOUS=$ROUTES/__tests__/transitous.test.ts
T_OVERLAY=$ROUTES/__tests__/overlay.test.ts
T_POLITE=$ROUTES/__tests__/polite-client.test.ts
VERDICT=src/domain/hurry/verdict.ts   # m7c's verdict engine (this card's dependency)
SCHEDULE_DB=assets/db/schedule.db     # read-only: the stop / station / trip -> line join for real ids

# ---- Test-name pins. Each acceptance case is a LITERAL suffix that a passing test's FULL jest name
# (describe titles + test title) must END with, after a space or at the start: the regex is
# '(^| )<suffix>$', case-insensitive, matched by lib.sh's jest_nonempty on an UNFILTERED run. A title
# has one ending, so one test can satisfy at most one pin — _pin_in_universe proves that statically on
# every call (no pin is a word-boundary suffix of another, and no pin holds a regex metacharacter).
PINS_TRANSITOUS=('request URL is exact' 'User-Agent is exact' 'real fixture parses into >= 3 itineraries'
  'malformed body -> Err without throwing')
PINS_OVERLAY=('matched leg -> live departure, marked live' 'unmatched leg -> unchanged'
  'first-leg verdict near the stop -> CHILL' 'first-leg verdict, only jogging makes it -> JOG')
PINS_POLITE=('within 60 s -> cache hit, no fetch' 'after 60 s -> refetch' 'concurrent calls -> one request in flight'
  '429 -> one retry after backoff' 'retry fails -> unavailable' 'rapid queries -> debounced to one request')
CARD_PINS=("${PINS_TRANSITOUS[@]}" "${PINS_OVERLAY[@]}" "${PINS_POLITE[@]}")

# _pin_in_universe <suffix> — authoring guard: the suffix is a card pin, has no regex metacharacter,
# and no other card pin is equal to it or a word-boundary suffix of it (or it of them), case-insensitively.
_pin_in_universe() {
  local s="$1" p ls lp found=0
  if printf '%s' "$s" | _qgrep '[].*+?^${}()|\\[]'; then
    echo "ratchet: authoring error: pin '$s' holds a regex metacharacter"; return 1
  fi
  ls=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')
  for p in "${CARD_PINS[@]}"; do
    if [ "$p" = "$s" ]; then found=$((found + 1)); continue; fi
    lp=$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')
    case " $ls" in *" $lp") echo "ratchet: authoring error: pin '$p' is a suffix of '$s' — one title could satisfy both"; return 1 ;; esac
    case " $lp" in *" $ls") echo "ratchet: authoring error: pin '$s' is a suffix of '$p' — one title could satisfy both"; return 1 ;; esac
  done
  [ "$found" -eq 1 ] || { echo "ratchet: authoring error: pin '$s' appears $found time(s) in the card's pin universe (need exactly 1)"; return 1; }
}

# jest_pin <test-file> <suffix> — lib's jest_nonempty (unfiltered run, file green, nothing skipped, full-name
# match) with the anchored pin '(^| )<suffix>$' from the card universe.
jest_pin() {
  local file="$1" suffix="$2"
  _pin_in_universe "$suffix" || return 1
  jest_nonempty "$file" "(^| )${suffix}\$"
}

# need_import <file> <module-ERE> — the file imports exactly that relative module (a `from '…'` clause).
need_import() {
  local file="$1" mod="$2"
  need_file "$file" || return 1
  grep -qE -- "from ['\"]${mod}(\\.ts)?['\"]" "$file" \
    || { echo "ratchet: $file does not import from '${mod//\\/}' — it must reuse that module, not reimplement it"; return 1; }
}

# card_node <label> <js-body> <required-file>... — the files the check reads must exist (named failure), then
# the body runs as an ES module with tsx loaded (so it imports the card's .ts modules as the app would), from
# the repo root. The body prints 'ratchet: <label>: <reason>' and exits 1 on failure. Network-free: the
# bodies only read committed files and call pure functions.
card_node() {
  local label="$1" body="$2" out f
  shift 2
  for f in "$@"; do need_file "$f" || return 1; done
  [ -f node_modules/tsx/package.json ] || { echo "ratchet: tsx is not installed in node_modules"; return 1; }
  out=$(M10A_GATE="$label" M10A_TRANSITOUS="./$TRANSITOUS" M10A_OVERLAY="./$OVERLAY" M10A_FIXTURE="$FIXTURE" \
    M10A_CAPTURE="$CAPTURE" M10A_DB="$SCHEDULE_DB" \
    node --import tsx --input-type=module -e "$JS_PRELUDE"$'\n'"$body" 2>&1) \
    || { echo "$out" | tail -25; echo "ratchet: $label is red"; return 1; }
  echo "$out" | tail -3
}

# Shared helpers for the direct checks: named failures, the two endpoints, the exact User-Agent, Transitous
# id prefixes, a bounded precision-N polyline decoder and a haversine distance.
JS_PRELUDE=$(cat <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
const E = process.env;
const fail = (m) => { console.log(`ratchet: ${E.M10A_GATE}: ${m}`); process.exit(1); };
const check = (cond, m) => { if (!cond) fail(m); };
// deep-equality: on a mismatch the (trimmed) diff prints FIRST and the named reason LAST, so it survives tail.
const same = (got, want, m) => { try { assert.deepStrictEqual(got, want); } catch (e) { console.log(e.message.split('\n').slice(0, 18).join('\n')); fail(m); } };
const call = (f, what) => { try { return f(); } catch (e) { return fail(`${what} threw ${e?.name ?? 'an error'}: ${e?.message ?? e}`); } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fail(`${p} is not readable JSON (${e.message})`); } };
const load = async (path, names) => {
  let m;
  try { m = await import(path); } catch (e) { return fail(`cannot import ${path}: ${e.message}`); }
  for (const n of names) check(typeof m[n] === 'function', `${path} does not export a function named ${n}`);
  return m;
};
const GC = { latitude: 25.7745, longitude: -80.1953 };          // Government Center (plan M10a.1 fixture)
const BRICKELL = { latitude: 25.7584, longitude: -80.1937 };
const UA = (v) => `MiamiTransit/${v} (+https://github.com/purpleperkel/miami-transit)`;
const TRIP_RE = /^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_.+$/;          // <yyyymmdd>_<hh:mm>_<feed>_<gtfs trip_id>
const ID_RE = /^[A-Za-z0-9-]+_.+$/;                                // <feed>_<gtfs id>
const tripOf = (id) => id.replace(/^\d{8}_\d{1,2}:\d{2}_[A-Za-z0-9-]+_/, '');
const unprefix = (id) => id.replace(/^[A-Za-z0-9-]+_/, '');
const sec = (iso) => Date.parse(iso) / 1000;
const decodePolyline = (s, precision) => {
  const f = 10 ** precision; const pts = []; let i = 0; let lat = 0; let lon = 0;
  while (i < s.length) {
    const d = [0, 0];
    for (let k = 0; k < 2; k++) {
      let shift = 0; let res = 0; let b = 0x20;
      while (b >= 0x20) { if (i >= s.length) return null; b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; }
      d[k] = res & 1 ? ~(res >> 1) : res >> 1;
    }
    lat += d[0]; lon += d[1]; pts.push({ lat: lat / f, lon: lon / f });
  }
  return pts;
};
const metersBetween = (a, b) => {
  const r = Math.PI / 180; const dLat = (b.lat - a.lat) * r; const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};
JS
)

# M10a.1 — the exact /api/v5/plan URL for two queries (both arriveBy values; JS number formatting for the
# coordinates; time = new Date(timeEpoch * 1000).toISOString(); literal ',' and ':' — no percent-encoding).
JS_PLAN_URL=$(cat <<'JS'
const { buildPlanRequest } = await load(E.M10A_TRANSITOUS, ['buildPlanRequest']);
const cases = [
  [{ from: GC, to: BRICKELL, timeEpoch: 1790881200, arriveBy: false },
    'https://api.transitous.org/api/v5/plan?fromPlace=25.7745,-80.1953&toPlace=25.7584,-80.1937&time=2026-10-01T19:00:00.000Z&arriveBy=false'],
  [{ from: BRICKELL, to: { latitude: 25.797964, longitude: -80.25859 }, timeEpoch: 1791036900, arriveBy: true },
    'https://api.transitous.org/api/v5/plan?fromPlace=25.7584,-80.1937&toPlace=25.797964,-80.25859&time=2026-10-03T14:15:00.000Z&arriveBy=true'],
];
for (const [query, want] of cases) {
  const req = call(() => buildPlanRequest(query, '1.0.0'), 'buildPlanRequest(query, "1.0.0")');
  check(req !== null && typeof req === 'object', 'buildPlanRequest returns an object { url, headers }');
  check(req.url === want, `url\n  got:  ${req.url}\n  want: ${want}`);
}
console.log('ok: buildPlanRequest builds the exact /api/v5/plan URL (2 queries, arriveBy false and true)');
JS
)

# M10a.1 — the exact User-Agent for two app versions, as a plain header object; no key anywhere.
JS_PLAN_UA=$(cat <<'JS'
const { buildPlanRequest } = await load(E.M10A_TRANSITOUS, ['buildPlanRequest']);
for (const v of ['1.0.0', '2.3.4']) {
  const req = call(() => buildPlanRequest({ from: GC, to: BRICKELL, timeEpoch: 1790881200, arriveBy: false }, v), `buildPlanRequest(query, "${v}")`);
  const h = req?.headers;
  check(h !== null && typeof h === 'object' && !Array.isArray(h) && typeof h.get !== 'function', 'headers is a plain object of name -> value (not a Headers instance)');
  check(h['User-Agent'] === UA(v), `User-Agent for app version ${v}\n  got:  ${h['User-Agent']}\n  want: ${UA(v)}`);
  const keyish = Object.keys(h).filter((n) => /authori[sz]ation|api-?key|token|secret|cookie/i.test(n));
  check(keyish.length === 0, `Transitous takes no key, yet the headers carry ${keyish.join(', ')}`);
  check(!/key|token|secret/i.test(new URL(req.url).search), `the URL carries a key-like parameter: ${req.url}`);
}
console.log('ok: User-Agent is exactly "MiamiTransit/<version> (+https://github.com/purpleperkel/miami-transit)"; no key');
JS
)

# M10a.1 fixture — the committed body is a Transitous v5 /plan response for Government Center -> Brickell.
JS_FIXTURE_SHAPE=$(cat <<'JS'
const fx = readJson(E.M10A_FIXTURE);
const KEYS = ['requestParameters', 'debugOutput', 'from', 'to', 'direct', 'itineraries', 'previousPageCursor', 'nextPageCursor'];
const missing = KEYS.filter((k) => fx === null || typeof fx !== 'object' || !(k in fx));
check(missing.length === 0, `not a Transitous /api/v5/plan body as received: missing ${missing.join(', ')}`);
const at = (p, ll) => Math.abs(p?.lat - ll.latitude) < 1e-9 && Math.abs(p?.lon - ll.longitude) < 1e-9;
check(fx.from?.name === 'START' && at(fx.from, GC), 'from is not START at 25.7745,-80.1953 (Government Center)');
check(fx.to?.name === 'END' && at(fx.to, BRICKELL), 'to is not END at 25.7584,-80.1937 (Brickell)');
check(Array.isArray(fx.itineraries) && fx.itineraries.length >= 3, `need >= 3 itineraries, got ${fx.itineraries?.length}`);
check(fx.itineraries.every((it) => Array.isArray(it?.legs) && it.legs.length > 0), 'every itinerary has a non-empty legs array');
const legs = fx.itineraries.flatMap((it) => it.legs);
check(legs.every((l) => l.realTime === false), 'every leg must be realTime:false (Transitous Miami times are schedule-only; that is why the live overlay exists)');
check(legs.some((l) => l.mode === 'WALK'), 'no WALK leg');
check(legs.some((l) => l.mode === 'TRAM' && l.routeShortName === 'MMO'), 'no Metromover leg (mode TRAM, routeShortName MMO): capture a weekday daytime trip');
check(legs.some((l) => l.mode === 'REGIONAL_RAIL' && l.routeShortName === '2600'), 'no Metrorail leg (mode REGIONAL_RAIL, routeShortName 2600): capture a weekday daytime trip');
const transit = legs.filter((l) => l.tripId !== undefined);
const bad = transit.filter((l) => !TRIP_RE.test(String(l.tripId)) || !ID_RE.test(String(l.from?.stopId)) || !ID_RE.test(String(l.to?.stopId)) || !ID_RE.test(String(l.routeId)));
check(bad.length === 0, `transit legs must carry Transitous ids (tripId <yyyymmdd>_<hh:mm>_<feed>_<trip_id>; stopId/routeId <feed>_<id>): ${bad.slice(0, 3).map((l) => l.tripId).join(', ')}`);
console.log(`ok: ${fx.itineraries.length} itineraries, ${legs.length} legs (WALK, TRAM MMO, REGIONAL_RAIL 2600), all realTime:false`);
JS
)

# M10a.1 fixture realness + PUBLIC-REPO DATA RULE (arbiter 2026-10-01): TRANSIT legs keep their polyline (GTFS-shape
# derived, public) and it must decode to legGeometry.length points that start/end within 150 m of the leg's own
# from/to (a hand-shaped fixture cannot fake routed geometry); WALK/non-transit legs carry NO legGeometry (OSM-derived,
# ODbL: stripped before commit); and the JSON carries a top-level _provenance naming Transitous, OpenStreetMap/ODbL
# and the public-repo data rule.
JS_FIXTURE_GEOMETRY=$(cat <<'JS'
const fx = readJson(E.M10A_FIXTURE);
check(Array.isArray(fx?.itineraries), 'the fixture has no itineraries array');
const pv = fx?._provenance;
check(pv && typeof pv === 'object', 'the fixture needs a top-level _provenance object (source, captured, license) — public-repo data rule');
const lic = JSON.stringify(pv ?? {});
for (const w of ['Transitous', 'OpenStreetMap', 'ODbL', 'public-repo data rule']) check(lic.includes(w), `_provenance must mention "${w}"`);
const NON_TRANSIT = new Set(['WALK', 'BIKE', 'CAR', 'CAR_PARKING', 'FLEX', 'RENTAL', 'ODM']);
let transit = 0; let walk = 0;
fx.itineraries.forEach((it, i) => (it.legs ?? []).forEach((l, j) => {
  const where = `itinerary ${i} leg ${j} (${l.mode})`; const g = l.legGeometry;
  if (NON_TRANSIT.has(String(l.mode))) {
    check(g === undefined, `${where}: walking geometry is OSM-derived (ODbL) — strip legGeometry before committing (public-repo data rule)`);
    walk += 1; return;
  }
  check(g && typeof g.points === 'string' && g.points.length > 0 && Number.isInteger(g.precision) && Number.isInteger(g.length), `${where}: transit legGeometry {points, precision, length} is missing (keep transit-leg geometry as received)`);
  const pts = decodePolyline(g.points, g.precision);
  check(pts !== null && pts.length === g.length, `${where}: the polyline decodes to ${pts?.length} points, legGeometry.length says ${g.length}`);
  const d0 = metersBetween(pts[0], l.from); const d1 = metersBetween(pts[pts.length - 1], l.to);
  check(d0 <= 150 && d1 <= 150, `${where}: the geometry starts ${d0.toFixed(0)} m / ends ${d1.toFixed(0)} m from the leg's from/to (limit 150 m)`);
  transit += 1;
}));
(Array.isArray(fx.direct) ? fx.direct : []).forEach((it, i) => (it.legs ?? []).forEach((l, j) => {
  check(l.legGeometry === undefined, `direct ${i} leg ${j} (${l.mode}): direct (walk-only) geometry is OSM-derived (ODbL) — strip legGeometry (public-repo data rule)`);
}));
check(transit > 0, 'no transit legs to check');
check(walk > 0, 'no walk legs found — a Government Center → Brickell plan always walks to/from the platform');
console.log(`ok: ${transit} transit leg polylines decode onto their endpoints; ${walk} walk legs carry no OSM geometry; provenance present`);
JS
)

# M10a.1 fixture ids — every rail/Mover leg's boarding and alighting stop, feed prefix stripped, is a stop in
# the committed schedule.db (proves the prefix rule the overlay relies on, against the ids m4a uses).
JS_FIXTURE_DB=$(cat <<'JS'
const fx = readJson(E.M10A_FIXTURE);
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(E.M10A_DB, { readOnly: true });
const stop = db.prepare('SELECT 1 AS hit FROM stop WHERE stop_id = ?');
const legs = (fx?.itineraries ?? []).flatMap((it) => it.legs ?? []).filter((l) => l.mode === 'TRAM' || l.mode === 'REGIONAL_RAIL');
check(legs.length > 0, 'the fixture has no rail/Mover leg');
const missing = new Set();
for (const l of legs) for (const p of [l.from, l.to]) if (stop.get(unprefix(String(p?.stopId))) === undefined) missing.add(String(p?.stopId));
db.close();
check(missing.size === 0, `rail/Mover stops not in schedule.db once the feed prefix is stripped: ${[...missing].join(', ')}`);
console.log(`ok: ${legs.length} rail/Mover legs; every stop joins schedule.db after stripping the feed prefix`);
JS
)

# M10a.1 fixture provenance — the capture record matches buildPlanRequest for Government Center -> Brickell at
# the URL's own time with app.json's version (exact URL + exact User-Agent), status 200, and the body's
# itineraries depart inside the searched window.
JS_CAPTURE=$(cat <<'JS'
const { buildPlanRequest } = await load(E.M10A_TRANSITOUS, ['buildPlanRequest']);
const cap = readJson(E.M10A_CAPTURE);
const fx = readJson(E.M10A_FIXTURE);
same(Object.keys(cap ?? {}).sort(), ['capturedAt', 'status', 'url', 'userAgent'], 'the capture record is exactly {url, userAgent, capturedAt, status}');
check(cap.status === 200, `status ${cap.status}: commit a 200 response`);
const capturedAt = Date.parse(cap.capturedAt);
check(Number.isFinite(capturedAt) && capturedAt >= Date.parse('2026-10-01T00:00:00Z') && capturedAt <= Date.now() + 60000, `capturedAt ${cap.capturedAt} is not an ISO instant between 2026-10-01 and now`);
const t = sec(new URL(cap.url).searchParams.get('time') ?? '');
check(Number.isInteger(t), `the capture URL has no usable time parameter: ${cap.url}`);
const version = readJson('app.json')?.expo?.version;
check(typeof version === 'string' && version.length > 0, 'app.json has no expo.version');
const req = call(() => buildPlanRequest({ from: GC, to: BRICKELL, timeEpoch: t, arriveBy: false }, version), 'buildPlanRequest');
check(cap.url === req.url, `the fixture was not fetched from buildPlanRequest's URL\n  capture: ${cap.url}\n  builder: ${req.url}`);
check(cap.userAgent === req.headers['User-Agent'] && cap.userAgent === UA(version), `the fixture was not fetched with the exact User-Agent\n  capture: ${cap.userAgent}\n  want:    ${UA(version)}`);
const starts = (fx?.itineraries ?? []).map((it) => sec(it.startTime));
check(starts.length > 0 && starts.every((s) => Number.isFinite(s) && s >= t - 120 && s <= t + 6 * 3600), `itineraries do not depart within [time - 2 min, time + 6 h] of the capture URL's time ${new Date(t * 1000).toISOString()}`);
console.log(`ok: captured ${cap.capturedAt} from ${cap.url} with "${cap.userAgent}"`);
JS
)

# M10a.1 — parseItineraries(real fixture): ok; every itinerary and every leg kept, in order; fields mapped.
JS_PARSE_FIXTURE=$(cat <<'JS'
const { parseItineraries } = await load(E.M10A_TRANSITOUS, ['parseItineraries']);
const fx = readJson(E.M10A_FIXTURE);
const r = call(() => parseItineraries(fx), 'parseItineraries(fixture)');
check(r?.ok === true, `parseItineraries(fixture) is not ok: ${JSON.stringify(r?.error)}`);
const its = r.value;
check(Array.isArray(its) && its.length === fx.itineraries.length, `every itinerary is kept: got ${its?.length}, the fixture has ${fx.itineraries.length}`);
fx.itineraries.forEach((raw, i) => {
  const legs = its[i]?.legs;
  check(Array.isArray(legs) && legs.length === raw.legs.length, `itinerary ${i}: every leg is kept, in order`);
  raw.legs.forEach((rl, j) => {
    const l = legs[j]; const where = `itinerary ${i} leg ${j} (${rl.mode})`;
    same({ mode: l?.mode, routeShortName: l?.routeShortName, headsign: l?.headsign, fromName: l?.from?.name, toName: l?.to?.name,
      fromEpoch: l?.from?.epoch, toEpoch: l?.to?.epoch, durationS: l?.durationS, distanceM: l?.distanceM, realTime: l?.realTime, live: l?.live },
    { mode: rl.mode, routeShortName: rl.routeShortName ?? null, headsign: rl.headsign ?? null, fromName: rl.from.name, toName: rl.to.name,
      fromEpoch: sec(rl.startTime), toEpoch: sec(rl.endTime), durationS: rl.duration, distanceM: rl.distance ?? null, realTime: rl.realTime, live: false },
    `${where}: parsed fields (epochs = startTime/endTime in epoch s; distanceM null when Transitous gives no distance; live false until overlaid)`);
    if (rl.tripId !== undefined) check(typeof l.tripId === 'string' && l.tripId.length > 0 && typeof l.from.stopId === 'string', `${where}: a transit leg keeps its tripId and boarding stopId`);
    else check(l.tripId === null, `${where}: a leg without a trip has tripId null`);
  });
});
console.log(`ok: ${its.length} itineraries, ${its.reduce((n, it) => n + it.legs.length, 0)} legs parsed field-for-field`);
JS
)

# M10a.1 — malformed bodies are Err values, never throws; a valid body with no itineraries is ok([]).
JS_PARSE_MALFORMED=$(cat <<'JS'
const { parseItineraries } = await load(E.M10A_TRANSITOUS, ['parseItineraries']);
const fx = readJson(E.M10A_FIXTURE);
const good = fx.itineraries[0];
const leg0 = good.legs[0];
const bodies = [
  ['null', null], ['a number', 42], ['an HTML error page', '<html>502 Bad Gateway</html>'], ['an empty object', {}],
  ['itineraries not an array', { itineraries: {} }], ['legs not an array', { itineraries: [{ ...good, legs: 'x' }] }],
  ['a leg with a numeric mode', { itineraries: [{ ...good, legs: [{ ...leg0, mode: 7 }] }] }],
  ['a leg with an unparseable startTime', { itineraries: [{ ...good, legs: [{ ...leg0, startTime: 'soon' }] }] }],
  ['a leg without from', { itineraries: [{ ...good, legs: [{ ...leg0, from: undefined }] }] }],
];
for (const [name, body] of bodies) {
  const r = call(() => parseItineraries(body), `parseItineraries(${name})`);
  check(r?.ok === false && r.error !== undefined, `${name} must be an Err, got ${JSON.stringify(r)?.slice(0, 200)}`);
}
const empty = call(() => parseItineraries({ ...fx, itineraries: [] }), 'parseItineraries(no itineraries)');
check(empty?.ok === true && Array.isArray(empty.value) && empty.value.length === 0, 'a valid body with no itineraries is ok([]), not an Err');
console.log(`ok: ${bodies.length} malformed bodies -> Err without throwing; no itineraries -> ok([])`);
JS
)

# M10a.2 — overlayLive on the REAL fixture's ids with m4a-shaped LivePredictions (GTFS ids, as Transitland's
# departures give them): every leg boarding a predicted trip AT the predicted stop takes the live departure
# and is marked live; every other leg is deep-equal to its parsed self; the input is not mutated;
# scheduled-only rows, another trip, or the same trip at another stop move nothing.
JS_OVERLAY_REAL=$(cat <<'JS'
const { parseItineraries } = await load(E.M10A_TRANSITOUS, ['parseItineraries']);
const { overlayLive } = await load(E.M10A_OVERLAY, ['overlayLive']);
const fx = readJson(E.M10A_FIXTURE);
const parsed = call(() => parseItineraries(fx), 'parseItineraries(fixture)');
check(parsed?.ok === true, 'parseItineraries(fixture) is not ok');
const its = parsed.value;
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(E.M10A_DB, { readOnly: true });
const stationQ = db.prepare('SELECT s.station_key AS k FROM stop st JOIN station s ON s.station_idx = st.station_idx WHERE st.stop_id = ?');
const lineQ = db.prepare('SELECT p.line_id AS l FROM trip t JOIN pattern p ON p.pattern_idx = t.pattern_idx WHERE t.trip_id = ?');
const legs = fx.itineraries.flatMap((it) => it.legs);
const rail = legs.find((l) => l.mode === 'REGIONAL_RAIL' && l.routeShortName === '2600');
const mover = legs.find((l) => l.mode === 'TRAM' && l.routeShortName === 'MMO');
check(rail !== undefined && mover !== undefined, 'the fixture needs a Metrorail and a Metromover leg');
const DELAY = 150;
const prediction = (l, stopRaw, epochIso, over = {}) => {
  const stopId = unprefix(stopRaw); const tripId = tripOf(l.tripId);
  return { tripId, routeId: unprefix(l.routeId), lineId: lineQ.get(tripId)?.l ?? null, stopId, stationKey: stationQ.get(stopId)?.k ?? null,
    epoch: sec(epochIso) + DELAY, scheduledEpoch: sec(epochIso), delayS: DELAY, realtime: true, canceled: false, headsign: l.headsign ?? null, ...over };
};
const preds = [prediction(rail, rail.from.stopId, rail.startTime), prediction(mover, mover.from.stopId, mover.startTime)];
const alight = prediction(rail, rail.to.stopId, rail.endTime);   // the same trip, predicted at its alighting stop
db.close();
const before = JSON.stringify(its);
const out = call(() => overlayLive(its, preds), 'overlayLive(itineraries, predictions)');
check(JSON.stringify(its) === before, 'overlayLive mutated its input itineraries');
check(Array.isArray(out) && out.length === its.length, 'overlayLive returns every itinerary, in order');
const live = new Map(preds.map((p) => [`${p.tripId}@${p.stopId}`, p]));
let matched = 0;
fx.itineraries.forEach((raw, i) => { let carry = 0; raw.legs.forEach((rl, j) => {
  const got = out[i]?.legs?.[j]; const where = `itinerary ${i} leg ${j} (${rl.mode} ${rl.routeShortName ?? ''})`;
  const p = rl.tripId !== undefined ? live.get(`${tripOf(rl.tripId)}@${unprefix(rl.from.stopId)}`) : undefined;
  if (p === undefined) {
    // Amended at the mfix5 flip (arbiter ruling 2026-10-02): a WALK right after a late ride shifts by the delay of that ride;
    // a ride no prediction matches keeps its schedule and absorbs the delay (later legs are compared unchanged).
    if (rl.tripId === undefined && carry !== 0) { const l = its[i].legs[j]; same(got, { ...l, from: { ...l.from, epoch: l.from.epoch + carry }, to: { ...l.to, epoch: l.to.epoch + carry } }, `${where}: a walk right after a late ride must shift by its delay (${carry} s)`); return; }
    if (rl.tripId !== undefined) carry = 0;
    same(got, its[i].legs[j], `${where}: a leg no live prediction matches must be unchanged`); return;
  }
  matched += 1; carry = p.delayS ?? 0;
  check(got?.from?.epoch === p.epoch && got?.live === true, `${where}: boarding live trip ${p.tripId} at stop ${p.stopId} must take the live departure ${p.epoch} and be marked live (got epoch ${got?.from?.epoch}, live ${got?.live})`);
}); });
check(matched >= 2, `only ${matched} leg(s) matched the rail + Mover predictions — match on the GTFS trip_id and stop_id (strip the Transitous prefixes)`);
const staticRows = preds.map((p) => ({ ...p, realtime: false, epoch: null, delayS: null }));
same(call(() => overlayLive(its, staticRows), 'overlayLive(scheduled-only)'), its, 'scheduled-only predictions (realtime false, epoch null) must leave every leg unchanged');
same(call(() => overlayLive(its, [{ ...preds[0], tripId: '999999999' }]), 'overlayLive(other trip)'), its, 'a prediction for another trip must leave every leg unchanged');
const out3 =call(() => overlayLive(its, [alight]), 'overlayLive(same trip, alighting stop)');
its.forEach((it, i) => it.legs.forEach((l, j) => check(out3[i]?.legs?.[j]?.from?.epoch === l.from.epoch, `itinerary ${i} leg ${j}: a prediction for the same trip at ANOTHER stop (${alight.stopId}) must not move the boarding departure`)));
console.log(`ok: ${matched} legs took live departures on real ids; unmatched legs, scheduled-only rows, other trips and other stops changed nothing`);
JS
)

# The repo-wide gate, only once every artifact of this card (and m7c's engine) exists — on an unbuilt tree
# it would merely re-prove the previous card's green.
CARD_FILES=("$TRANSITOUS" "$OVERLAY" "$POLITE" "$FIXTURE" "$CAPTURE" "$T_TRANSITOUS" "$T_OVERLAY" "$T_POLITE" "$VERDICT")
full_gate_built() {
  local f
  for f in "${CARD_FILES[@]}"; do need_file "$f" || return 1; done
  full_gate
}

# ================================ GATES (one per line; each runs alone) ================================

# --- M10a.1 Transitous client (pure) ---
# 1. The pure Transitous client lives where the plan puts it.
need_file src/domain/routes/transitous.ts
# 2. Direct tsx call: buildPlanRequest(query, appVersion).url is the exact /api/v5/plan URL for two queries (arriveBy false/true).
card_node plan-url "$JS_PLAN_URL" "$TRANSITOUS"
# 3. Direct tsx call: headers['User-Agent'] is exactly "MiamiTransit/<version> (+https://github.com/purpleperkel/miami-transit)" for two versions; no key header or parameter.
card_node plan-user-agent "$JS_PLAN_UA" "$TRANSITOUS"
# 4. The fixture is a Transitous v5 /plan body for Government Center -> Brickell: >= 3 itineraries; WALK, TRAM MMO and REGIONAL_RAIL 2600 legs; all realTime false; Transitous-prefixed ids.
card_node fixture-shape "$JS_FIXTURE_SHAPE" "$FIXTURE"
# 5. The fixture is a real capture: every leg's polyline decodes to legGeometry.length points that land on its own endpoints.
card_node fixture-geometry "$JS_FIXTURE_GEOMETRY" "$FIXTURE"
# 6. The fixture's rail/Mover stops, feed prefix stripped, are stops in schedule.db (the id rule the overlay relies on).
card_node fixture-stops-in-db "$JS_FIXTURE_DB" "$FIXTURE" "$SCHEDULE_DB"
# 7. The capture record proves the fixture came from buildPlanRequest's exact URL with the exact User-Agent (app.json version), HTTP 200.
card_node fixture-provenance "$JS_CAPTURE" "$CAPTURE" "$FIXTURE" "$TRANSITOUS" app.json
# 8. Direct tsx call: parseItineraries(fixture) is ok and keeps every itinerary and leg, field for field.
card_node parse-fixture "$JS_PARSE_FIXTURE" "$TRANSITOUS" "$FIXTURE"
# 9. Direct tsx call: malformed bodies -> Err without throwing; a body with no itineraries -> ok([]).
card_node parse-malformed "$JS_PARSE_MALFORMED" "$TRANSITOUS" "$FIXTURE"
# 10. A (M10a.1): URL exact — its own passing test.
jest_pin src/domain/routes/__tests__/transitous.test.ts 'request URL is exact'
# 11. A (M10a.1): User-Agent exact — its own passing test.
jest_pin src/domain/routes/__tests__/transitous.test.ts 'User-Agent is exact'
# 12. A (M10a.1): the real fixture parses into >= 3 itineraries — its own passing test.
jest_pin src/domain/routes/__tests__/transitous.test.ts 'real fixture parses into >= 3 itineraries'
# 13. A (M10a.1): a malformed body -> Err, no throw — its own passing test.
jest_pin src/domain/routes/__tests__/transitous.test.ts 'malformed body -> Err without throwing'

# --- M10a.2 Live overlay + first-leg verdict ---
# 14. The overlay module lives in the routes domain.
need_file src/domain/routes/overlay.ts
# 15. The overlay consumes m4a's LivePrediction (imports ../live/types), not a look-alike type.
need_import src/domain/routes/overlay.ts '\.\./live/types'
# 16. m7c's verdict engine has landed (dependency).
need_file src/domain/hurry/verdict.ts
# 17. firstLegVerdict runs m7c's engine (overlay.ts imports ../hurry/verdict), not a second copy of the rules.
need_import src/domain/routes/overlay.ts '\.\./hurry/verdict'
# 18. Direct tsx call on REAL ids: matched rail + Mover legs take the live departure and are marked live; a walk right after a late ride shifts by its delay (mfix5); everything else is unchanged.
card_node overlay-real-ids "$JS_OVERLAY_REAL" "$OVERLAY" "$TRANSITOUS" "$FIXTURE" "$SCHEDULE_DB"
# 19. A (M10a.2): matched leg updated and marked live — its own passing test.
jest_pin src/domain/routes/__tests__/overlay.test.ts 'matched leg -> live departure, marked live'
# 20. A (M10a.2): unmatched leg unchanged — its own passing test.
jest_pin src/domain/routes/__tests__/overlay.test.ts 'unmatched leg -> unchanged'
# 21. A (M10a.2): verdict computed — near the boarding stop with time to spare -> CHILL, its own passing test.
jest_pin src/domain/routes/__tests__/overlay.test.ts 'first-leg verdict near the stop -> CHILL'
# 22. A (M10a.2): verdict computed — only a jog makes the first transit leg -> JOG, its own passing test.
jest_pin src/domain/routes/__tests__/overlay.test.ts 'first-leg verdict, only jogging makes it -> JOG'

# --- M10a.3 Polite client ---
# 23. The polite client lives in the routes domain.
need_file src/domain/routes/polite-client.ts
# 24. The polite client sends buildPlanRequest's exact URL + User-Agent and parses with parseItineraries (imports ./transitous).
need_import src/domain/routes/polite-client.ts '\./transitous'
# 25. A (M10a.3): cache hit — same (from, to, minute) within 60 s -> no fetch; its own test (injected fetch + clock).
jest_pin src/domain/routes/__tests__/polite-client.test.ts 'within 60 s -> cache hit, no fetch'
# 26. A (M10a.3): the 60 s cache from the other side — after 60 s -> a new fetch; its own test.
jest_pin src/domain/routes/__tests__/polite-client.test.ts 'after 60 s -> refetch'
# 27. A (M10a.3): no double request — concurrent calls -> one request in flight; its own test.
jest_pin src/domain/routes/__tests__/polite-client.test.ts 'concurrent calls -> one request in flight'
# 28. A (M10a.3): 429 handling — one retry after a backoff (injected sleep); its own test.
jest_pin src/domain/routes/__tests__/polite-client.test.ts '429 -> one retry after backoff'
# 29. Plan M10a.3: the retry also failing (429/5xx/network) -> {kind:'unavailable'}, never a throw; its own test.
jest_pin src/domain/routes/__tests__/polite-client.test.ts 'retry fails -> unavailable'
# 30. Plan M10a.3: a debounce on typing — rapid successive queries -> one request; its own test.
jest_pin src/domain/routes/__tests__/polite-client.test.ts 'rapid queries -> debounced to one request'

# --- Card-wide ---
# 31. Plan V (M10a.1-3): `jest src/domain/routes` is non-empty, green, nothing skipped.
jest_nonempty src/domain/routes
# 32. Repo-wide gate (tsc app + scripts, eslint incl. src/domain purity, standards, jest, node:test, argv ban), once every card artifact and m7c's engine exist.
full_gate_built
