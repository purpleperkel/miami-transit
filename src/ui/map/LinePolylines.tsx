import type { ReactElement } from 'react';
import { Polyline } from 'react-native-maps';

import { invariant } from '@/lib/invariant';

import { isHexColor } from '../colorMath';
import { type ColorScheme, lineColors } from '../colors';
import { CASING_EXTRA_PT, type LineSegment, strokeWidthOf } from './lineLayout';

/**
 * The lines on the map (plan M5.7, §4 "Lines"): every segment is TWO polylines, a casing 3 pt wider
 * than the stroke drawn under it, in the line's palette colours (src/ui/colors.ts). A dimmed line
 * (another line is in focus) keeps its colours at 0.3 alpha.
 *
 * Apple Maps draws overlays in the order they are added (Polyline zIndex is Google-only on iOS), so
 * the layers go: dimmed casings, dimmed strokes, then casings and strokes of the lines in focus —
 * no casing ever cuts across a stroke drawn before it, and a focused line is never under a dimmed one.
 */

export const DIMMED_ALPHA = 0.3;

export type PolylineStyle = { readonly strokeColor: string; readonly strokeWidth: number };

/** A colour at the given alpha, as `rgba(r, g, b, a)`. */
export function withAlpha(hex: string, alpha: number): string {
  invariant(isHexColor(hex), `"${hex}" is a '#RRGGBB' colour`);
  invariant(alpha >= 0 && alpha <= 1, `alpha ${alpha} is between 0 and 1`);
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgba(${channels.join(', ')}, ${alpha})`;
}

/** The casing and stroke of one segment in one colour scheme. */
export function segmentStyles(segment: LineSegment, scheme: ColorScheme): { readonly casing: PolylineStyle; readonly stroke: PolylineStyle } {
  const colors = lineColors(segment.lineId, scheme);
  const width = strokeWidthOf(segment.lineId);
  const alpha = segment.dimmed ? DIMMED_ALPHA : 1;
  const styles = {
    casing: { strokeColor: alpha === 1 ? colors.casing : withAlpha(colors.casing, alpha), strokeWidth: width + CASING_EXTRA_PT },
    stroke: { strokeColor: alpha === 1 ? colors.stroke : withAlpha(colors.stroke, alpha), strokeWidth: width },
  };
  invariant(styles.casing.strokeWidth === styles.stroke.strokeWidth + CASING_EXTRA_PT, 'the casing is 3 pt wider than the stroke');
  invariant(segment.coordinates.length >= 2, `segment ${segment.id} has at least one leg to draw`);
  return styles;
}

export type LinePolylinesProps = { readonly segments: readonly LineSegment[]; readonly scheme: ColorScheme };

export function LinePolylines({ segments, scheme }: LinePolylinesProps) {
  invariant(new Set(segments.map((segment) => segment.id)).size === segments.length, 'every segment has its own id');
  const dimmed = segments.filter((segment) => segment.dimmed);
  const focused = segments.filter((segment) => !segment.dimmed);
  invariant(dimmed.length + focused.length === segments.length, 'every segment is dimmed or in focus');
  return (
    <>
      {layerPolylines(dimmed, 'casing', scheme)}
      {layerPolylines(dimmed, 'stroke', scheme)}
      {layerPolylines(focused, 'casing', scheme)}
      {layerPolylines(focused, 'stroke', scheme)}
    </>
  );
}

/** One layer of the drawing: the casing — or the stroke — of every segment, in segment order. */
function layerPolylines(segments: readonly LineSegment[], part: 'casing' | 'stroke', scheme: ColorScheme): ReactElement[] {
  invariant(part === 'casing' || part === 'stroke', 'a layer draws casings or strokes');
  const polylines = segments.map((segment) => (
    <Polyline key={`${segment.id}:${part}`} coordinates={[...segment.coordinates]} {...segmentStyles(segment, scheme)[part]} lineCap="round" lineJoin="round" />
  ));
  invariant(polylines.length === segments.length, 'one polyline per segment in each layer');
  return polylines;
}
