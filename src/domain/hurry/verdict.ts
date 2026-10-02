import { invariant } from '../../lib/invariant';

/**
 * Plan M7c.1 — HURRY OR CHILL, the verdict engine (Jamie's headline question: "is it worth hurrying or
 * jogging to the station to catch the next train, or can I relax?"). Pure: relative imports only, so
 * the app, the Mac scripts and the verify gate's plain-node calls all run this exact module.
 *
 *   walkS = walkMeters × detour / walkMps      jogS = walkMeters × detour / jogMps
 *   (walkMeters: routed street metres with detour 1, or straight-line metres with the default detour — mfix9)
 *   slack(d) = d.epoch − now − boardBufferS     (time left for the walk, keeping a moment to board)
 *
 * Judging the first departure d1:
 *   1. CHILL         walkS ≤ slack — a walk makes it; spareS = slack − walkS.
 *   2. JOG           jogS ≤ slack and the gap to the following departure is STRICTLY greater than
 *                    worthItGapS, or there is no following departure (the last train is always worth a
 *                    jog); spareS = slack − jogS.
 *   3. NOT_WORTH_IT  jogS ≤ slack, but the following departure leaves within worthItGapS: `next` points
 *                    at it.
 *   4. MISSED        even a jog misses d1: d2, then d3, are judged by rules 1–3 in a BOUNDED loop (at most
 *                    MAX_JUDGED departures, never d4 — no recursion) and the first one a jog still makes is
 *                    nested as a value; `nested` is null when none of them can be made.
 *   5. NO_SERVICE    no departures at all.
 * A judged departure's "following departure" is simply the next one in the list: for d3 that is d4, read
 * only for d3's gap rule (is a jog worth it when another train follows within worthItGapS?). d4 is never
 * itself judged or nested, so the verdict is about d1, d2 or d3 alone.
 *
 * Every number stays UNROUNDED (the copy rounds, src/ui/hurry/copy.ts). Each verdict carries `live` from
 * the departure it is about, and confidence 'low' exactly when that departure is live data past its
 * provider's fresh limit (`stale`, set by board.ts from providerConfig(provider).freshS).
 */

/** One departure the engine weighs (board.ts makes them from the merged departure board). */
export type HurryDeparture = {
  /** When it leaves, epoch s. */
  readonly epoch: number;
  /** A realtime time (merge rule 6), not the timetable's. */
  readonly live: boolean;
  readonly lineId: string | null;
  readonly headsign: string | null;
  /** Live data older than its provider's fresh limit; absent or false for fresh live and scheduled times. */
  readonly stale?: boolean;
  /** The departure's identity across prediction updates (merge-departures' row key), when known. */
  readonly key?: string;
};

export const HURRY_KINDS = ['CHILL', 'JOG', 'NOT_WORTH_IT', 'MISSED', 'NO_SERVICE'] as const;
export type HurryKind = (typeof HURRY_KINDS)[number];

/** 'low' when the verdict rests on stale live data; 'normal' for fresh live data and the timetable. */
export type HurryConfidence = 'normal' | 'low';

export type HurryVerdict = {
  readonly kind: HurryKind;
  /** The departure the verdict is about (d1); null only for NO_SERVICE. */
  readonly departure: HurryDeparture | null;
  /** CHILL: slack − walkS; JOG: slack − jogS; otherwise null. Unrounded seconds. */
  readonly spareS: number | null;
  readonly walkS: number;
  readonly jogS: number;
  /** NOT_WORTH_IT: the following departure it points at; otherwise null. */
  readonly next: HurryDeparture | null;
  /** MISSED: the verdict on the first of d2, d3 a jog still makes, or null when neither can be made. */
  readonly nested: HurryVerdict | null;
  readonly live: boolean;
  readonly confidence: HurryConfidence;
};

export type HurryInput = {
  /** Now, epoch s. */
  readonly now: number;
  /**
   * Metres to the platform: routed street metres (detour 1) or straight-line metres (× detour). mfix9: a verdict walks
   * Transitous's street-routed distance when the app knows one, else the straight line with the default detour.
   */
  readonly walkMeters: number;
  /** Sorted by epoch. */
  readonly departures: readonly HurryDeparture[];
  readonly detour?: number;
  readonly walkMps?: number;
  readonly jogMps?: number;
  readonly boardBufferS?: number;
  readonly worthItGapS?: number;
};

/** Plan M7c.1's defaults. The paces are Jamie's settings (src/ui/settings/walking-pace.ts) in the app. */
export const HURRY_DEFAULTS = Object.freeze({ detour: 1.3, walkMps: 1.35, jogMps: 2.7, boardBufferS: 30, worthItGapS: 360 });

/** The MISSED loop judges at most this many departures: d1, d2, d3. */
export const MAX_JUDGED = 3;

/** The resolved inputs every rule reads. */
type Pace = { readonly now: number; readonly walkS: number; readonly jogS: number; readonly boardBufferS: number; readonly worthItGapS: number };

export function hurryVerdict(input: HurryInput): HurryVerdict {
  const pace = paceOf(input);
  const departures = input.departures;
  invariant(departures.every((d, i) => Number.isFinite(d.epoch) && (i === 0 || (departures[i - 1] as HurryDeparture).epoch <= d.epoch)), 'departures come sorted by epoch');
  if (departures.length === 0) {
    return noService(pace);
  }
  const first = judge(departures, 0, pace);
  if (first !== null) {
    return first;
  }
  let nested: HurryVerdict | null = null;
  for (let i = 1; i < Math.min(departures.length, MAX_JUDGED) && nested === null; i += 1) {
    nested = judge(departures, i, pace);
  }
  const verdict = verdictOf('MISSED', departures[0] as HurryDeparture, null, null, nested, pace);
  invariant(nested === null || nested.kind !== 'MISSED', 'a nested verdict is one a jog still makes');
  return verdict;
}

/** The defaults filled in and checked, with the walk and jog times. */
function paceOf(input: HurryInput): Pace {
  const { detour, walkMps, jogMps, boardBufferS, worthItGapS } = { ...HURRY_DEFAULTS, ...definedOnly(input) };
  invariant(Number.isFinite(input.now) && Number.isFinite(input.walkMeters) && input.walkMeters >= 0, 'now and a non-negative walk distance');
  invariant(
    detour >= 1 && walkMps > 0 && jogMps >= walkMps && Number.isFinite(jogMps) && boardBufferS >= 0 && worthItGapS >= 0,
    `usable paces: detour ${detour}, walk ${walkMps} m/s, jog ${jogMps} m/s, buffer ${boardBufferS} s, gap ${worthItGapS} s`,
  );
  const meters = input.walkMeters * detour;
  return { now: input.now, walkS: meters / walkMps, jogS: meters / jogMps, boardBufferS, worthItGapS };
}

/** The optional settings the caller gave (an explicit undefined keeps the default). */
function definedOnly(input: HurryInput): Partial<typeof HURRY_DEFAULTS> {
  const given = { detour: input.detour, walkMps: input.walkMps, jogMps: input.jogMps, boardBufferS: input.boardBufferS, worthItGapS: input.worthItGapS };
  const defined = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as Partial<typeof HURRY_DEFAULTS>;
  invariant(Object.values(defined).every((value) => typeof value === 'number'), 'every setting given is a number');
  invariant(Object.keys(defined).length <= Object.keys(given).length, 'only given settings are kept');
  return defined;
}

/** Rules 1–3 on departures[i]: its verdict when a jog still makes it, else null (missed). */
function judge(departures: readonly HurryDeparture[], i: number, pace: Pace): HurryVerdict | null {
  const departure = departures[i];
  invariant(departure !== undefined && i < MAX_JUDGED, `only d1..d${MAX_JUDGED} are judged, asked for d${i + 1}`);
  const slack = departure.epoch - pace.now - pace.boardBufferS;
  if (pace.walkS <= slack) {
    return verdictOf('CHILL', departure, slack - pace.walkS, null, null, pace);
  }
  if (pace.jogS > slack) {
    return null;
  }
  const following = departures[i + 1] ?? null;
  invariant(following === null || following.epoch >= departure.epoch, 'the following departure leaves no earlier');
  return following === null || following.epoch - departure.epoch > pace.worthItGapS
    ? verdictOf('JOG', departure, slack - pace.jogS, null, null, pace)
    : verdictOf('NOT_WORTH_IT', departure, null, following, null, pace);
}

function verdictOf(
  kind: Exclude<HurryKind, 'NO_SERVICE'>,
  departure: HurryDeparture,
  spareS: number | null,
  next: HurryDeparture | null,
  nested: HurryVerdict | null,
  pace: Pace,
): HurryVerdict {
  invariant((spareS !== null) === (kind === 'CHILL' || kind === 'JOG') && (spareS === null || spareS >= 0), `${kind} carries a spare exactly when it is CHILL or JOG`);
  invariant((next !== null) === (kind === 'NOT_WORTH_IT') && (nested === null || kind === 'MISSED'), `${kind} points and nests only as its rule says`);
  const confidence: HurryConfidence = departure.live && departure.stale === true ? 'low' : 'normal';
  return { kind, departure, spareS, walkS: pace.walkS, jogS: pace.jogS, next, nested, live: departure.live, confidence };
}

function noService(pace: Pace): HurryVerdict {
  invariant(Number.isFinite(pace.walkS) && Number.isFinite(pace.jogS), 'the walk and jog times are known even with no train');
  const verdict: HurryVerdict = { kind: 'NO_SERVICE', departure: null, spareS: null, walkS: pace.walkS, jogS: pace.jogS, next: null, nested: null, live: false, confidence: 'normal' };
  invariant(verdict.departure === null, 'NO_SERVICE is about no departure');
  return verdict;
}
