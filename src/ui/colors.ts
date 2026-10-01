import type { LiveLineId } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { isHexColor } from './colorMath';

/**
 * The line palette (plan §4 "UX system", M5.3). Each line is drawn as a casing under a stroke (rail
 * 5 pt, Mover 3.5 pt, casing 3 pt wider). Its badges and vehicle bullets are filled with the stroke
 * and lettered in `badgeText`. Contrast and color-blind distance are tested in
 * src/ui/__tests__/colors.test.ts with src/ui/colorMath.ts.
 *
 * Strokes are the plan §4 table, with ONE deviation:
 * - Dark Orange is #F9763C, not the plan's #FF7A45. The plan's dark Green/Orange pair measures CIE76
 *   deltaE 27.9 under protanopia (Machado 2009), short of the 30 the plan requires. #F9763C is the
 *   nearest sRGB color to #FF7A45 (deltaE 2.9, about one just-noticeable difference) that clears 30
 *   with a margin of 1, still 4.99:1 on dark land and 7.7:1 under black badge text. Found by
 *   grid search, 2026-10-01. This is an open plan conflict for Jamie to ratify or overrule.
 *
 * Casings:
 * - Light: each stroke's sRGB channels × 0.75, a same-hue shade. For Green, Orange and Inner Loop
 *   it lands at 5.3–5.6:1 on light land, matching the plan's Brickell casing #8A6100 (5.3:1).
 *   Brickell keeps the plan's casing, because a 0.75 shade of its yellow is only 3.05:1.
 * - Dark: one shared shadow, the dark land × 0.5 (#0F1822), darker than the land under every bright
 *   stroke. In dark mode each stroke carries the contrast itself.
 *
 * Badge text is black or white, whichever reaches 4.5:1 on the stroke.
 *
 * The trunk ids (RAIL_TRUNK, MM_TRUNK) are vehicles on shared track with no known trip. They render
 * in the plan's neutral #6E6E73 / #AEAEB2.
 */

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** One line's colors in one scheme, each a '#RRGGBB' sRGB string. */
export type LineColors = {
  /** The line itself, and the fill of its badges and vehicle bullets. */
  readonly stroke: string;
  /** Drawn under the stroke, 3 pt wider: the edge that carries contrast where the stroke cannot. */
  readonly casing: string;
  /** Letters and text on a stroke-filled badge. */
  readonly badgeText: string;
};

/**
 * The map's land fill under MapKit `mutedStandard`, the map type src/app/(tabs)/index.tsx draws.
 * It is the color every line is drawn over. Apple does not publish MapKit's palette, so both values
 * are MEASURED (2026-10-01) as the dominant sRGB color of an inland area:
 * - light #FAFAF3: 50.3% of an inland region of an iPhone capture of this app's own map (M3 phone
 *   check; Display P3, color-matched to sRGB with CoreGraphics). A macOS 15.7 MKMapSnapshotter render
 *   (mutedStandard, aqua, 25.785 N 80.225 W, span 0.02°) gives the identical #FAFAF3.
 * - dark #1D2F43: the same MKMapSnapshotter render in the darkAqua appearance (22.9% of the frame,
 *   the most common color). No dark-mode phone capture exists yet.
 */
export const MAP_LAND: Readonly<Record<ColorScheme, string>> = { light: '#FAFAF3', dark: '#1D2F43' };

const BLACK = '#000000';
const WHITE = '#FFFFFF';
/** The dark scheme's shared casing: MAP_LAND.dark at half intensity. */
const DARK_CASING = '#0F1822';

const NEUTRAL_TRUNK: Readonly<Record<ColorScheme, LineColors>> = {
  light: { stroke: '#6E6E73', casing: '#535356', badgeText: WHITE },
  dark: { stroke: '#AEAEB2', casing: DARK_CASING, badgeText: BLACK },
};

export const LINE_PALETTE: Readonly<Record<LiveLineId, Readonly<Record<ColorScheme, LineColors>>>> = {
  GREEN: {
    light: { stroke: '#0E9F6E', casing: '#0B7753', badgeText: BLACK },
    dark: { stroke: '#35D49A', casing: DARK_CASING, badgeText: BLACK },
  },
  ORANGE: {
    light: { stroke: '#E8590C', casing: '#AE4309', badgeText: BLACK },
    dark: { stroke: '#F9763C', casing: DARK_CASING, badgeText: BLACK },
  },
  MM_INNER: {
    light: { stroke: '#0E95D0', casing: '#0B709C', badgeText: BLACK },
    dark: { stroke: '#5AD1FF', casing: DARK_CASING, badgeText: BLACK },
  },
  MM_OMNI: {
    light: { stroke: '#2E3FB0', casing: '#232F84', badgeText: WHITE },
    dark: { stroke: '#7C83FF', casing: DARK_CASING, badgeText: BLACK },
  },
  MM_BRICKELL: {
    light: { stroke: '#F2B705', casing: '#8A6100', badgeText: BLACK },
    dark: { stroke: '#FFD24A', casing: DARK_CASING, badgeText: BLACK },
  },
  RAIL_TRUNK: NEUTRAL_TRUNK,
  MM_TRUNK: NEUTRAL_TRUNK,
};

/** A line's (or neutral trunk's) colors in one scheme. */
export function lineColors(id: LiveLineId, scheme: ColorScheme): LineColors {
  invariant(COLOR_SCHEMES.includes(scheme), `"${scheme}" is a color scheme`);
  const colors = LINE_PALETTE[id]?.[scheme];
  invariant(
    colors !== undefined && isHexColor(colors.stroke) && isHexColor(colors.casing) && isHexColor(colors.badgeText),
    `"${id}" has '#RRGGBB' colors in the ${scheme} scheme`,
  );
  return colors;
}
