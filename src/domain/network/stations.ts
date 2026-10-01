import { haversineMeters } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * Plan §4 step 7 (M2.9): cluster the feed's platform stops into stations and give each a clean,
 * stable identity. The county feed has no `parent_station`, so a station is found geometrically:
 * stops of the SAME mode within 60 m of each other are joined (single-linkage, iterative
 * union-find). Rail and Mover never share a station — Government Center rail and Government Center
 * Mover are two stations ~20 m apart, linked by a transfer (build-network), not merged.
 *
 * Identity vs display:
 *  - the KEY mirrors the feed (`rail:government-ctr`): `<mode>:<slug of the cleaned feed name>`.
 *    It is stable across rebuilds and is what the line catalog's sentinels name.
 *  - the NAME is for people: Title Case, no STATION / METRORAIL / direction words, abbreviations
 *    expanded ("Government Center"), at most 28 characters. A name that would be longer is a build
 *    error until DISPLAY_NAME_OVERRIDES gives it a shorter form — never a silent truncation.
 */

export type Mode = 'rail' | 'mover';

/** Stops of one mode this close (metres) are platforms of one station. */
export const CLUSTER_RADIUS_M = 60;
/** The longest display name the UI lays out without truncating. */
export const MAX_NAME_LENGTH = 28;

export type StopInput = {
  readonly stopId: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly mode: Mode;
};

export type Station = {
  readonly key: string;
  readonly mode: Mode;
  readonly name: string;
  /** The centroid of the station's stops. */
  readonly latitude: number;
  readonly longitude: number;
  /** Sorted. */
  readonly stopIds: readonly string[];
};

export type StationIndex = {
  /** Sorted by key. */
  readonly stations: readonly Station[];
  /** stop_id → station key, for every input stop. */
  readonly stationOfStop: ReadonlyMap<string, string>;
};

export type StationError = { readonly kind: 'station'; readonly key: string; readonly message: string };

/** A feed name with its direction and station words removed, still upper case. */
export type CleanedName = { readonly text: string; readonly marked: boolean };

const DIRECTION_SUFFIX = /\s+(NORTH|SOUTH|EAST|WEST)BOUND$/;
/** "… STATION RAIL", "…STAT.RAIL", "… STAT. RAIL", "… METROMOVER STATION", "… STATION". */
const TRAILING_MARKER = /[\s.]*\b(?:(?:METROMOVER|METRORAIL)\s+)?(?:STATION|STAT\.?)(?:\s*RAIL)?$/;
const MARKER_WORD = /\b(?:STATION|METRORAIL|METROMOVER)\b/g;

/** Feed spellings shown differently: abbreviations expanded, a brand's casing, a feed typo. */
const WORD_FORMS: ReadonlyMap<string, string> = new Map([
  ['CTR', 'Center'],
  ['HTS', 'Heights'],
  ['UHEALTH', 'UHealth'],
  ['PROMANADE', 'Promenade'],
]);

/** Display names for stations whose feed name, cleaned, is longer than MAX_NAME_LENGTH. */
export const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  // "Historic Overtown/Lyric Theatre" is 31 characters.
  ['rail:historic-overtown-lyric-theatre', 'Overtown/Lyric Theatre'],
]);

/** Strip the direction suffix and every station marker; `marked` says a marker was present. */
export function cleanStopName(raw: string): CleanedName {
  invariant(typeof raw === 'string', 'a stop name is text');
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim().replace(DIRECTION_SUFFIX, '');
  const withoutTrailing = upper.replace(TRAILING_MARKER, '');
  const text = withoutTrailing.replace(MARKER_WORD, ' ').replace(/\s+/g, ' ').trim();
  const marked = text !== upper;
  invariant(!/\b(?:STATION|METRORAIL|METROMOVER)\b/.test(text), `no station marker survives cleaning: "${text}"`);
  return { text, marked };
}

/** `<mode>:<slug>` — lower case, every run of other characters one hyphen ("M.L. KING" → m-l-king). */
export function stationKey(mode: Mode, cleaned: string): string {
  invariant(cleaned.trim().length > 0, 'a station key needs a name');
  const slug = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  invariant(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `"${cleaned}" slugs to letters and digits`);
  return `${mode}:${slug}`;
}

/** Title Case with the WORD_FORMS spellings: "GOVERNMENT CTR" → "Government Center". */
export function displayName(cleaned: string): string {
  invariant(cleaned === cleaned.toUpperCase(), 'display names are made from cleaned upper-case names');
  const name = cleaned.replace(/[A-Z0-9]+/g, (word) => WORD_FORMS.get(word) ?? word.charAt(0) + word.slice(1).toLowerCase());
  invariant(name.length >= cleaned.length - 1, 'casing never drops words');
  return name;
}

/** Cluster the stops into stations; every stop lands in exactly one. */
export function buildStations(stops: readonly StopInput[]): Result<StationIndex, StationError> {
  invariant(stops.length > 0, 'stations are built from at least one stop');
  invariant(new Set(stops.map((stop) => stop.stopId)).size === stops.length, 'stop ids are unique');
  const stations: Station[] = [];
  for (const members of clusterStops(stops)) {
    const station = stationOf(members);
    if (!station.ok) {
      return station;
    }
    stations.push(station.value);
  }
  stations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const collision = stations.find((station, i) => i > 0 && stations[i - 1]?.key === station.key);
  if (collision !== undefined) {
    const message = `two clusters more than ${CLUSTER_RADIUS_M} m apart share the key ${collision.key} (one has stops ${collision.stopIds.join(', ')})`;
    return err({ kind: 'station', key: collision.key, message });
  }
  const stationOfStop = new Map(stations.flatMap((station) => station.stopIds.map((stopId) => [stopId, station.key] as const)));
  invariant(stationOfStop.size === stops.length, 'every stop belongs to exactly one station');
  return ok({ stations, stationOfStop });
}

/** Groups of stops, by single-linkage within CLUSTER_RADIUS_M and the same mode, in input order. */
function clusterStops(stops: readonly StopInput[]): StopInput[][] {
  invariant(stops.length > 0, 'clustering needs stops');
  const parent = stops.map((_, i) => i);
  for (let i = 0; i < stops.length; i += 1) {
    for (let j = i + 1; j < stops.length; j += 1) {
      if (closeEnough(stops[i], stops[j])) {
        const [a, b] = [findRoot(parent, i), findRoot(parent, j)];
        parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, StopInput[]>();
  stops.forEach((stop, i) => {
    const root = findRoot(parent, i);
    groups.set(root, [...(groups.get(root) ?? []), stop]);
  });
  invariant([...groups.values()].reduce((n, group) => n + group.length, 0) === stops.length, 'the groups partition the stops');
  return [...groups.values()];
}

function closeEnough(a: StopInput | undefined, b: StopInput | undefined): boolean {
  invariant(a !== undefined && b !== undefined, 'pairs are drawn from inside the stop list');
  invariant(a.stopId !== b.stopId, 'a stop is never paired with itself');
  return a.mode === b.mode && haversineMeters(a, b) <= CLUSTER_RADIUS_M;
}

/** The root of `i` in the union-find forest, halving the path as it climbs (a bounded loop). */
function findRoot(parent: number[], i: number): number {
  invariant(i >= 0 && i < parent.length, 'union-find indices stay inside the forest');
  let node = i;
  for (let step = 0; step < parent.length && parent[node] !== node; step += 1) {
    const up = parent[node] ?? node;
    parent[node] = parent[up] ?? up;
    node = parent[node] ?? node;
  }
  invariant(parent[node] === node, 'the climb ends at a root');
  return node;
}

/** One station from its stops: the best-attested name, its key, and the centroid. */
function stationOf(members: readonly StopInput[]): Result<Station, StationError> {
  const first = members[0];
  invariant(first !== undefined, 'a cluster has at least one stop');
  invariant(members.every((stop) => stop.mode === first.mode), 'a cluster never mixes modes');
  const cleaned = chooseName(members);
  if (cleaned === null) {
    const stops = members.map((stop) => stop.stopId).join(', ');
    return err({ kind: 'station', key: `${first.mode}:?`, message: `stops ${stops} have no name left once station words are removed` });
  }
  const key = stationKey(first.mode, cleaned);
  const name = DISPLAY_NAME_OVERRIDES.get(key) ?? displayName(cleaned);
  if (name.length > MAX_NAME_LENGTH) {
    const message = `${key}: "${name}" is ${name.length} characters (max ${MAX_NAME_LENGTH}); add a DISPLAY_NAME_OVERRIDES entry`;
    return err({ kind: 'station', key, message });
  }
  const latitude = members.reduce((sum, stop) => sum + stop.latitude, 0) / members.length;
  const longitude = members.reduce((sum, stop) => sum + stop.longitude, 0) / members.length;
  const stopIds = members.map((stop) => stop.stopId).sort();
  return ok({ key, mode: first.mode, name, latitude, longitude, stopIds });
}

/**
 * The cluster's name: names that carried a station marker beat bare street names (stop 832 is
 * "BISCAYNE BD@E FLAGLER ST" but its platform-mates say "BAYFRONT PARK METROMOVER STATION"), then
 * the most common spelling, then the alphabetically first — deterministic for any input order.
 * Null when every name is empty once cleaned (a stop called just "STATION").
 */
function chooseName(members: readonly StopInput[]): string | null {
  invariant(members.length > 0, 'a cluster has at least one stop');
  const votes = new Map<string, { marked: boolean; count: number }>();
  for (const stop of members) {
    const { text, marked } = cleanStopName(stop.name);
    const vote = votes.get(text) ?? { marked: false, count: 0 };
    votes.set(text, { marked: vote.marked || marked, count: vote.count + 1 });
  }
  const ranked = [...votes.entries()].filter(([text]) => text.length > 0);
  ranked.sort(([a, x], [b, y]) => Number(y.marked) - Number(x.marked) || y.count - x.count || (a < b ? -1 : a > b ? 1 : 0));
  const best = ranked[0]?.[0] ?? null;
  invariant(best === null || best.length > 0, 'a chosen name is never empty');
  return best;
}
