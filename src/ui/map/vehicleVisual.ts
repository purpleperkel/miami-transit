import { isStaleSighting, type Sighting } from '../../domain/live/staleness';
import type { LiveLineId } from '../../domain/live/types';
import type { Mode } from '../../domain/network/stations';
import { invariant } from '../../lib/invariant';
import { COLOR_SCHEMES, type ColorScheme, lineColors, MAP_LAND } from '../colors';
import { ZOOM_BUCKETS, type ZoomBucket } from './mapGeometry';

/**
 * Marker visuals (plan M5.8; M5.9's VehicleMarker builds on this module). A marker's VISUAL KEY names
 * everything that changes how it looks — and nothing about where it is. Markers are keyed and
 * memoised on it, so a marker re-renders (and react-native-maps rebuilds its native view) when its
 * appearance changes, never merely because a position ticked (M5.10 moves vehicles every 250 ms).
 */

/** Apple's minimum tappable area, in points, for every marker however small it is drawn. */
export const MIN_HIT_AREA_PT = 44;

export type VisualFacet = string | number | boolean;

/** The subject, then each facet in name order: "station:rail:palmetto|bucket=2|mode=rail|scheme=light|selected=false". */
export function visualKey(subject: string, facets: Readonly<Record<string, VisualFacet>>): string {
  invariant(subject.length > 0 && !subject.includes('|'), `"${subject}" names the marker`);
  const names = Object.keys(facets).sort();
  invariant(names.length > 0 && names.every((name) => /^[A-Za-z]+$/.test(name)), 'a key has facets, each named by a plain word');
  return [subject, ...names.map((name) => `${name}=${String(facets[name])}`)].join('|');
}

export type StationVisualInput = {
  readonly stationKey: string;
  readonly mode: Mode;
  readonly selected: boolean;
  readonly bucket: ZoomBucket;
  readonly scheme: ColorScheme;
};

export type StationVisual = {
  readonly key: string;
  readonly diameterPt: number;
  readonly ringPt: number;
  readonly fill: string;
  readonly ring: string;
  /** The square the marker's view occupies, and so the area a tap lands in. */
  readonly hitPt: number;
};

/** Dot diameter by zoom bucket (0 system … 3 street): rail stations stand out; the dense Mover stations stay smaller. */
const STATION_DOT_PT: Readonly<Record<Mode, Readonly<Record<ZoomBucket, number>>>> = {
  rail: { 0: 6, 1: 8, 2: 10, 3: 12 },
  mover: { 0: 4, 1: 6, 2: 8, 3: 10 },
};
const SELECTED_GROWTH_PT = 4;
/** The ring: 2 pt, thinner on the smallest dots so their fill still shows, 3 pt when selected. */
const RING_PT = 2;
const SMALL_DOT_RING_PT = 1.5;
const SMALL_DOT_PT = 8;
const SELECTED_RING_PT = 3;

/**
 * How a station marker looks: a land-coloured dot ringed in its system's neutral grey (src/ui/colors.ts
 * neutral trunk), which a selected station fills and enlarges. The grey keeps the dot from reading as
 * one line's colour where several lines meet.
 */
export function stationVisual(input: StationVisualInput): StationVisual {
  invariant(ZOOM_BUCKETS.includes(input.bucket) && COLOR_SCHEMES.includes(input.scheme), 'a known zoom bucket and colour scheme');
  const neutral = lineColors(input.mode === 'rail' ? 'RAIL_TRUNK' : 'MM_TRUNK', input.scheme);
  const dotPt = STATION_DOT_PT[input.mode][input.bucket];
  const visual: StationVisual = {
    key: visualKey(`station:${input.stationKey}`, { mode: input.mode, selected: input.selected, bucket: input.bucket, scheme: input.scheme }),
    diameterPt: dotPt + (input.selected ? SELECTED_GROWTH_PT : 0),
    ringPt: input.selected ? SELECTED_RING_PT : dotPt < SMALL_DOT_PT ? SMALL_DOT_RING_PT : RING_PT,
    fill: input.selected ? neutral.stroke : MAP_LAND[input.scheme],
    ring: input.selected ? neutral.casing : neutral.stroke,
    hitPt: MIN_HIT_AREA_PT,
  };
  invariant(visual.diameterPt > 2 * visual.ringPt && visual.diameterPt <= visual.hitPt, 'the dot shows its fill and fits its hit area');
  return visual;
}

/** The eight directions a vehicle's nose can point: 0 north, 1 north-east, 2 east … 7 north-west. */
export const OCTANTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export type Octant = (typeof OCTANTS)[number];

/**
 * The compass octant nearest a bearing (degrees clockwise from north, any real number): ROUNDED to
 * the nearest 45°, so 359° points north (0), not north-west — flooring would give 7.
 */
export function bearingOctant(bearing: number): Octant {
  invariant(Number.isFinite(bearing), `a bearing is a finite number of degrees, got ${bearing}`);
  const degrees = ((bearing % 360) + 360) % 360;
  const octant = (Math.round(degrees / 45) % 8) as Octant;
  invariant(OCTANTS.includes(octant), `${bearing}° gives octant ${octant}`);
  return octant;
}

/**
 * A live fix as a marker draws it: its provider, its age on our clock (what VoiceOver reads), and how it
 * stands against its own feed — the feed header's age and the fix's lag behind it (staleness.ts).
 */
export type LiveSighting = Sighting & { readonly ageS: number };

/**
 * A live fix is STALE by the relative rule (src/domain/live/staleness.ts): its feed is older than the
 * provider's freshS (Swiftly 75 s, Transitland 180 s), or it lags that feed by more than lagStaleS
 * (Swiftly 60 s, Transitland 90 s). The pill reads the same feed age, so pill and markers agree.
 */
export function isStale(live: LiveSighting): boolean {
  invariant(Number.isFinite(live.ageS) && live.ageS >= 0, `a fix's age is a non-negative number of seconds, got ${live.ageS}`);
  invariant(live.feedAgeS >= 0 && live.lagS >= 0, 'a sighting measures non-negative ages');
  return isStaleSighting(live);
}

/** Rail vehicles are 24 pt rounded squares carrying a letter; Mover vehicles are 16 pt dots (plan §4 "Vehicles"). */
export const RAIL_VEHICLE_PT = 24;
export const MOVER_VEHICLE_PT = 16;
/** A stale vehicle is drawn at half opacity, with a clock badge (§4). */
export const STALE_OPACITY = 0.5;
const RAIL_CORNER_PT = 6;
const SOLID_RING_PT = 1.5;
const HOLLOW_RING_PT = 2.5;

/** The letter bullet of a rail line: G, O, or M for a train on the shared trunk whose line is unknown. */
const RAIL_LETTER: Readonly<Partial<Record<LiveLineId, string>>> = { GREEN: 'G', ORANGE: 'O', RAIL_TRUNK: 'M' };

export type VehicleVisualInput = {
  readonly vehicleKey: string;
  readonly mode: Mode;
  readonly lineId: LiveLineId;
  /** live = drawn at a live fix (solid); scheduled = a timetable position (hollow). */
  readonly source: 'live' | 'scheduled';
  /** The live fix against its feed; null for a scheduled vehicle. */
  readonly live: LiveSighting | null;
  readonly bearing: number | null;
  readonly scheme: ColorScheme;
};

export type VehicleVisual = {
  readonly key: string;
  readonly sizePt: number;
  readonly cornerPt: number;
  readonly fill: string;
  readonly ring: string;
  readonly ringPt: number;
  /** The letter bullet (rail only) and its colour. */
  readonly letter: string | null;
  readonly letterColor: string;
  readonly hollow: boolean;
  readonly stale: boolean;
  readonly opacity: number;
  /** Where the heading nose points, or null when the bearing is unknown. */
  readonly octant: Octant | null;
  readonly hitPt: number;
};

/**
 * How a vehicle marker looks (plan §4 "Vehicles", M5.9). LIVE is SOLID: filled with the line's
 * stroke, ringed in its casing, the letter in its badge text. SCHEDULED is HOLLOW: land-filled,
 * ringed and lettered in the line's ink (the casing on light land, the stroke on dark land, whichever
 * carries the contrast). A STALE live vehicle (isStale: the relative rule) is drawn at half opacity with a
 * clock badge.
 */
export function vehicleVisual(input: VehicleVisualInput): VehicleVisual {
  invariant((input.source === 'live') === (input.live !== null), 'a live vehicle carries its fix age, and only a live one does');
  const colors = lineColors(input.lineId, input.scheme);
  const hollow = input.source === 'scheduled';
  const ink = input.scheme === 'light' ? colors.casing : colors.stroke;
  const stale = input.live !== null && isStale(input.live);
  const octant = input.bearing === null ? null : bearingOctant(input.bearing);
  const rail = input.mode === 'rail';
  const visual: VehicleVisual = {
    key: visualKey(`vehicle:${input.vehicleKey}`, { line: input.lineId, source: input.source, stale, heading: octant ?? 'none', scheme: input.scheme }),
    sizePt: rail ? RAIL_VEHICLE_PT : MOVER_VEHICLE_PT,
    cornerPt: rail ? RAIL_CORNER_PT : MOVER_VEHICLE_PT / 2,
    fill: hollow ? MAP_LAND[input.scheme] : colors.stroke,
    ring: hollow ? ink : colors.casing,
    ringPt: hollow ? HOLLOW_RING_PT : SOLID_RING_PT,
    letter: rail ? (RAIL_LETTER[input.lineId] ?? null) : null,
    letterColor: hollow ? ink : colors.badgeText,
    hollow,
    stale,
    opacity: stale ? STALE_OPACITY : 1,
    octant,
    hitPt: MIN_HIT_AREA_PT,
  };
  invariant(!rail || visual.letter !== null, `a train on ${input.lineId} carries a letter bullet`);
  invariant(visual.sizePt < visual.hitPt && visual.fill !== visual.ring, 'the marker fits its hit area and its ring shows');
  return visual;
}
