import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { transitousUserAgent } from '../routes/transitous';

/**
 * mfix9 (Jamie, 2026-10-02 09:12: "Also says chill pace for getting to fifth but estimated walk time from Google Maps
 * would put me at 1 min after scheduled arrival"): the Transitous ONE-TO-MANY walk client, pure. One request gives
 * the walking distance ALONG THE STREETS from the rider to every platform a verdict wants. The straight line x m7c's
 * 1.3 detour was the engine's only walk; the streets around a Metromover station are often 1.6-2.1x the straight
 * line (the committed fixture's ratios from Third Street: 2.03, 2.08, 1.31, 1.63, 1.19), so no single factor is right.
 *
 * REQUEST: GET WALK_ROUTER_URL?one=<lat>;<lon>&many=<lat>;<lon>,<lat>;<lon>,...&mode=WALK&max=3600
 *   &maxMatchingDistance=250&arriveBy=false&withDistance=true, written out literally (plain JS number formatting,
 *   a literal ';' and ','), never percent-encoded, as m10a writes /plan. The only header is m10a's User-Agent
 *   (transitousUserAgent, imported). At most WALK_MAX_TARGETS targets: the server's maxOneToManySize (MOTIS v2.11.3,
 *   read from /api/v1/map/initial on 2026-10-02).
 *
 * RESPONSE: one entry per target, in order: {} when no walk reaches it (within WALK_MAX_S), else {duration, distance}.
 *   `distance` is metres along the streets. `duration` is NOT a walking time: osr's foot profile prices a way's
 *   kind (a non-foot way +90, a way with a separate sidewalk +45, each elevator +90) into a routing COST, which is
 *   why the fixture's Riverwalk reads 292.7 m for a "duration" of 519 s (0.56 m/s). So it is kept as `costS`, and
 *   the app walks `distanceM` at the rider's own pace.
 *
 * Neither function throws on what it is handed: a request that cannot be made, or an answer that is not a list of
 * walks, is an Err.
 */

export const WALK_ROUTER_URL = 'https://api.transitous.org/api/v1/one-to-many';
/** The server's maxOneToManySize: a request carries at most this many targets. */
export const WALK_MAX_TARGETS = 128;
/** The longest walk asked for, in the router's cost seconds (an hour on foot). */
export const WALK_MAX_S = 3600;
/** How far (metres) a coordinate may lie from the street network and still be matched to it. */
export const WALK_MATCH_M = 250;

export type WalkRequest = {
  readonly url: string;
  /** Exactly the User-Agent: Transitous takes no key. */
  readonly headers: Readonly<Record<string, string>>;
};

/** A street-routed walk: metres along the streets, and the router's cost in seconds (a preference score, never a time). */
export type WalkPath = { readonly distanceM: number; readonly costS: number };

export type WalkClientError = { readonly kind: 'bad-request' | 'malformed'; readonly message: string };

/** A URL longer than this risks a server's request-line limit (8 KiB is common); 128 targets stay well under it. */
const URL_LIMIT = 8192;

/** The one-to-many request from `from` to each target, in order; an Err for 0 or more than 128 targets or a bad coordinate. */
export function buildWalkRequest(from: LatLon, targets: readonly LatLon[], appVersion: string): Result<WalkRequest, WalkClientError> {
  const problem = requestProblem(from, targets, appVersion);
  if (problem !== null) {
    return err({ kind: 'bad-request', message: problem });
  }
  const many = targets.map(pointText).join(',');
  const url = `${WALK_ROUTER_URL}?one=${pointText(from)}&many=${many}&mode=WALK&max=${WALK_MAX_S}&maxMatchingDistance=${WALK_MATCH_M}&arriveBy=false&withDistance=true`;
  const headers: Record<string, string> = { 'User-Agent': transitousUserAgent(appVersion) };
  invariant(!url.includes('%') && url.split(';').length === targets.length + 2, 'the URL is written out literally: the origin and each target are one <lat>;<lon> pair');
  invariant(url.length < URL_LIMIT, `a request of ${targets.length} targets fits a server's URL limit`);
  return ok({ url, headers });
}

/** Why the request cannot be made, or null when it can. */
function requestProblem(from: LatLon, targets: readonly LatLon[], appVersion: string): string | null {
  invariant(Number.isSafeInteger(targets.length), 'the targets are a list');
  let problem: string | null = null;
  if (!/^\S+$/.test(appVersion)) {
    problem = `the app version is one token, got "${appVersion}"`;
  } else if (targets.length === 0 || targets.length > WALK_MAX_TARGETS) {
    problem = `a one-to-many request carries 1 to ${WALK_MAX_TARGETS} targets, got ${targets.length}`;
  } else if (!isLatLon(from)) {
    problem = `the origin ${from.latitude};${from.longitude} is not a finite coordinate`;
  } else {
    const bad = targets.findIndex((target) => !isLatLon(target));
    problem = bad < 0 ? null : `target ${bad} is not a finite coordinate`;
  }
  invariant(problem !== null || (isLatLon(from) && targets.length >= 1 && targets.every((target) => isLatLon(target))), 'a request is only made from and to real coordinates');
  return problem;
}

/** `<lat>;<lon>` in plain JS number formatting: what MOTIS reads as one place. */
function pointText(point: LatLon): string {
  invariant(isLatLon(point), 'only a real coordinate is written into the query');
  const text = `${point.latitude};${point.longitude}`;
  invariant(!/[,&%\s]/.test(text), 'a place never holds the list separator, a parameter break or an escape');
  return text;
}

/** The answer to a request with `n` targets: per target, in order, its WalkPath (null: no walk); an Err for anything else. */
export function parseWalkTimes(json: unknown, n: number): Result<readonly (WalkPath | null)[], WalkClientError> {
  invariant(Number.isSafeInteger(n) && n >= 1 && n <= WALK_MAX_TARGETS, `an answer is read for the 1 to ${WALK_MAX_TARGETS} targets asked for, got ${n}`);
  if (!Array.isArray(json)) {
    return err({ kind: 'malformed', message: `the body is ${json === null ? 'null' : typeof json}, not a list of walks` });
  }
  const entries: readonly unknown[] = json;
  if (entries.length !== n) {
    return err({ kind: 'malformed', message: `the body holds ${entries.length} walks for ${n} targets` });
  }
  const paths: (WalkPath | null)[] = [];
  for (const [i, entry] of entries.entries()) {
    const path = walkPathOf(entry, i);
    if (!path.ok) {
      return err({ kind: 'malformed', message: path.error });
    }
    paths.push(path.value);
  }
  invariant(paths.length === n, 'one walk, or none, per target asked for');
  return ok(paths);
}

/** Entry `i`: {} is no walk (null); a finite, non-negative distance AND duration is a WalkPath; anything else says why not. */
function walkPathOf(entry: unknown, i: number): Result<WalkPath | null, string> {
  invariant(Number.isSafeInteger(i) && i >= 0 && i < WALK_MAX_TARGETS, `an entry answers one of at most ${WALK_MAX_TARGETS} targets, got index ${i}`);
  const record = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Readonly<Record<string, unknown>>) : null;
  if (record === null) {
    return err(`walk ${i}: want {} or {duration, distance}, got ${JSON.stringify(entry) ?? typeof entry}`);
  }
  if (Object.keys(record).length === 0) {
    return ok(null);
  }
  const { distance, duration } = record;
  if (typeof distance !== 'number' || typeof duration !== 'number' || !Number.isFinite(distance) || !Number.isFinite(duration) || distance < 0 || duration < 0) {
    return err(`walk ${i}: want a finite, non-negative distance and duration, got distance ${String(distance)}, duration ${String(duration)}`);
  }
  invariant(Object.keys(record).length >= 2, 'a walk answers with its distance AND its routing cost (a duration alone is an Err)');
  return ok({ distanceM: distance, costS: duration });
}
