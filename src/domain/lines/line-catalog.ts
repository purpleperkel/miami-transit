import { invariant } from '../../lib/invariant';
import type { Mode } from '../network/stations';

/**
 * The five v1 lines (plan §1, §4 step 8). The county feed does not say which line a trip is on:
 * Metrorail is ONE route (31009) for Green and Orange, and Metromover route 14456 carries both Omni
 * and Brickell. A line is therefore derived from a trip's STOP PATTERN (derive-line.ts), using the
 * sentinel stations below — never from the headsign, which is wrong on the weekend Green trains
 * ("EHT - CUL SINGLE TRACK AFTER 8PM").
 *
 * Stations are named by their keys (src/domain/network/stations.ts), which mirror the feed's names.
 * If the county renames a station, the build fails on the missing key instead of misfiling trips.
 */

export const LINE_IDS = ['GREEN', 'ORANGE', 'MM_INNER', 'MM_OMNI', 'MM_BRICKELL'] as const;
export type LineId = (typeof LINE_IDS)[number];

/**
 * full: runs terminal to terminal · airport_shuttle: stays on the Orange airport branch (MIA ↔
 * Earlington Heights, the junction) · short_turn: any other part of the line.
 */
export type LineVariant = 'full' | 'short_turn' | 'airport_shuttle';

export type LineDef = {
  readonly id: LineId;
  readonly name: string;
  readonly mode: Mode;
  readonly routeId: string;
  /** The line's two end stations; a pattern running between them is `full`. */
  readonly terminals: readonly [string, string];
  /**
   * Stations only this line serves among the lines sharing its route. A pattern touching one is on
   * this line; touching two lines' sentinels is a contradiction. Empty for a route with one line.
   */
  readonly sentinels: readonly string[];
  /** A branch-only service pattern with its own variant name, or null. */
  readonly shuttle: { readonly variant: LineVariant; readonly stations: readonly string[] } | null;
};

const RAIL_ROUTE = '31009';
const INNER_LOOP_ROUTE = '14457';
const OMNI_BRICKELL_ROUTE = '14456';

export const LINE_CATALOG: readonly LineDef[] = [
  {
    id: 'GREEN',
    name: 'Green Line',
    mode: 'rail',
    routeId: RAIL_ROUTE,
    terminals: ['rail:palmetto', 'rail:dadeland-south'],
    // The Green branch north of the Earlington Heights junction.
    sentinels: ['rail:palmetto', 'rail:okeechobee', 'rail:hialeah', 'rail:tri-rail', 'rail:northside', 'rail:m-l-king', 'rail:brownsville'],
    shuttle: null,
  },
  {
    id: 'ORANGE',
    name: 'Orange Line',
    mode: 'rail',
    routeId: RAIL_ROUTE,
    terminals: ['rail:miami-international-airport', 'rail:dadeland-south'],
    sentinels: ['rail:miami-international-airport'],
    shuttle: { variant: 'airport_shuttle', stations: ['rail:miami-international-airport', 'rail:earlington-hts'] },
  },
  {
    id: 'MM_INNER',
    name: 'Inner Loop',
    mode: 'mover',
    routeId: INNER_LOOP_ROUTE,
    // Published as two half-trips; each runs between these two stations.
    terminals: ['mover:bayfront-park', 'mover:government-center'],
    sentinels: [],
    shuttle: null,
  },
  {
    id: 'MM_OMNI',
    name: 'Omni',
    mode: 'mover',
    routeId: OMNI_BRICKELL_ROUTE,
    terminals: ['mover:school-board', 'mover:government-center'],
    sentinels: [
      'mover:school-board',
      'mover:adrienne-arsht-center',
      'mover:museum-park',
      'mover:eleventh-street',
      'mover:miami-worldcenter',
      'mover:freedom-tower',
    ],
    shuttle: null,
  },
  {
    id: 'MM_BRICKELL',
    name: 'Brickell',
    mode: 'mover',
    routeId: OMNI_BRICKELL_ROUTE,
    terminals: ['mover:financial-district', 'mover:government-center'],
    sentinels: [
      'mover:financial-district',
      'mover:brickell',
      'mover:tenth-street-promanade',
      'mover:brickell-city-centre',
      'mover:fifth-street',
      'mover:riverwalk',
    ],
    shuttle: null,
  },
];

export function lineById(id: LineId): LineDef {
  invariant((LINE_IDS as readonly string[]).includes(id), `"${id}" is a line id`);
  const line = LINE_CATALOG.find((candidate) => candidate.id === id);
  invariant(line !== undefined, `the catalog defines ${id}`);
  return line;
}

/** The catalog lines that run on `routeId`, in catalog order (empty for an unknown route). */
export function linesOfRoute(routeId: string): LineDef[] {
  invariant(routeId.length > 0, 'a route_id is never empty');
  const lines = LINE_CATALOG.filter((line) => line.routeId === routeId);
  invariant(lines.every((line) => line.sentinels.length > 0) || lines.length === 1, 'lines sharing a route each have sentinels');
  return lines;
}

/** Every station key the catalog names (terminals, sentinels, shuttle stations), sorted, once each. */
export function catalogStationKeys(): string[] {
  invariant(LINE_CATALOG.length === LINE_IDS.length, 'the catalog defines each line id once');
  const keys = new Set(LINE_CATALOG.flatMap((line) => [...line.terminals, ...line.sentinels, ...(line.shuttle?.stations ?? [])]));
  invariant(keys.size > 0, 'the catalog names stations');
  return [...keys].sort();
}
