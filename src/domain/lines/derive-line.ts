import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { linesOfRoute, type LineDef, type LineId, type LineVariant } from './line-catalog';

/**
 * Plan §4 step 8 (M2.10): the line a stop pattern runs on, from its sentinel stations alone.
 *
 * The input is the route and the pattern's ordered STATION keys — deliberately no headsign, so a
 * misleading headsign cannot reach the decision. A pattern on a route that carries one line is that
 * line; on a shared route it must touch exactly one line's sentinels. Touching two lines' sentinels
 * (both branches) or none is an Err, and the pipeline treats it as a build error: a contradiction
 * means the catalog no longer describes the feed (plan risk R9).
 */

export type Derivation = { readonly line: LineId; readonly variant: LineVariant };

export type DeriveError = {
  readonly kind: 'derive';
  readonly reason: 'unknown-route' | 'both-branches' | 'no-sentinel';
  readonly message: string;
};

export function deriveLine(routeId: string, stations: readonly string[]): Result<Derivation, DeriveError> {
  invariant(stations.length >= 2, 'a stop pattern visits at least two stations');
  invariant(stations.every((key) => key.includes(':')), 'patterns are given as station keys');
  const candidates = linesOfRoute(routeId);
  if (candidates.length === 0) {
    return err({ kind: 'derive', reason: 'unknown-route', message: `route ${routeId} carries no catalog line` });
  }
  const visited = new Set(stations);
  const touched = candidates.filter((line) => line.sentinels.some((key) => visited.has(key)));
  if (touched.length > 1) {
    const hits = touched.map((line) => `${line.id} (${line.sentinels.filter((key) => visited.has(key)).join(', ')})`);
    const message = `route ${routeId} pattern touches both branches — ${hits.join(' and ')}: a contradiction; update the sentinels`;
    return err({ kind: 'derive', reason: 'both-branches', message });
  }
  const line = touched[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (line === undefined) {
    const message = `route ${routeId} pattern ${stations.join(' > ')} touches no sentinel of ${candidates.map((c) => c.id).join(' or ')}`;
    return err({ kind: 'derive', reason: 'no-sentinel', message });
  }
  invariant(stations.every((key) => key.startsWith(`${line.mode}:`)), `a ${line.id} pattern visits ${line.mode} stations only`);
  return ok({ line: line.id, variant: variantOf(line, stations) });
}

/** full between the terminals; the line's shuttle when it stays inside the shuttle's stations; else short_turn. */
function variantOf(line: LineDef, stations: readonly string[]): LineVariant {
  const first = stations[0];
  const last = stations[stations.length - 1];
  invariant(first !== undefined && last !== undefined, 'a pattern has a first and a last station');
  const [a, b] = line.terminals;
  if ((first === a && last === b) || (first === b && last === a)) {
    return 'full';
  }
  const shuttle = line.shuttle;
  const variant = shuttle !== null && stations.every((key) => shuttle.stations.includes(key)) ? shuttle.variant : 'short_turn';
  invariant(variant !== 'full', 'only a terminal-to-terminal pattern is full');
  return variant;
}
