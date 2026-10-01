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
