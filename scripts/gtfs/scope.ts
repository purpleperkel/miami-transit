import { invariant } from '../../src/lib/invariant';

/**
 * What v1 loads from the county feed (plan §1 and §4 step 6): Metrorail and two Metromover routes.
 * Every other route — buses, and the MIA airport mover (14458) — is dropped at load time.
 */

/** Metrorail: ONE route for both lines; the line comes from the stop pattern, not the route. */
export const RAIL_ROUTE_ID = '31009';
/** Metromover Inner Loop (MMI): published as half-trips chained by block_id. */
export const MOVER_INNER_LOOP_ROUTE_ID = '14457';
/** Metromover Omni + Brickell (MMO): one route_id; the legs differ by shape (123747 Omni, 123748 Brickell). */
export const MOVER_OMNI_BRICKELL_ROUTE_ID = '14456';
/** MIA airport mover — in the feed, deliberately out of scope. */
export const EXCLUDED_AIRPORT_MOVER_ROUTE_ID = '14458';

export type Mode = 'rail' | 'mover';

const ROUTE_MODES: ReadonlyMap<string, Mode> = new Map<string, Mode>([
  [RAIL_ROUTE_ID, 'rail'],
  [MOVER_INNER_LOOP_ROUTE_ID, 'mover'],
  [MOVER_OMNI_BRICKELL_ROUTE_ID, 'mover'],
]);

/** The in-scope route_ids, in a fixed order (31009, 14457, 14456). */
export const IN_SCOPE_ROUTE_IDS: readonly string[] = [...ROUTE_MODES.keys()];

/** The feed's agency_timezone must be this; the Mac does all time-zone math in it (plan §4 step 10). */
export const FEED_TIME_ZONE = 'America/New_York';

/** The mode of an in-scope route, or null for a route the pipeline drops. */
export function modeOfRoute(routeId: string): Mode | null {
  invariant(routeId.length > 0, 'a route_id is never empty');
  const mode = ROUTE_MODES.get(routeId) ?? null;
  invariant(routeId !== EXCLUDED_AIRPORT_MOVER_ROUTE_ID || mode === null, 'the airport mover is never in scope');
  return mode;
}

export function isInScopeRoute(routeId: string): boolean {
  invariant(routeId.length > 0, 'a route_id is never empty');
  const inScope = modeOfRoute(routeId) !== null;
  invariant(inScope === IN_SCOPE_ROUTE_IDS.includes(routeId), 'the scope list and the mode table agree');
  return inScope;
}
