import type { TextProps, TextStyle } from 'react-native';

import { invariant } from '../lib/invariant';

/**
 * Design tokens (plan §4 "UX system", M5.1): the spacing scale, corner radii and type ramp every
 * screen draws from. Plain data plus one pure mapping (type-only react-native imports), so a test
 * reads them without rendering anything.
 */

/** The spacing scale in points. Every step sits on the 4-pt grid. */
export const SPACING = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export type SpacingStep = keyof typeof SPACING;

/** Corner radii in points, on the same 4-pt grid (md matches iOS grouped-list cards). */
export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** An iOS Dynamic Type text style, as React Native's `Text` takes it (`dynamicTypeRamp`). */
export type DynamicTypeRamp = NonNullable<TextProps['dynamicTypeRamp']>;

/** One step of the type ramp. Sizes are points at the default ("Large") content size. */
export type TypeToken = {
  readonly fontSize: number;
  readonly fontWeight: '400' | '600' | '700';
  /** SF Rounded, the face of the big countdown figures. */
  readonly rounded: boolean;
  /** Fixed-width digits, so a ticking countdown never shifts sideways. */
  readonly tabularNums: boolean;
  /** The Dynamic Type style the text scales with. */
  readonly ramp: DynamicTypeRamp;
  /** The most Dynamic Type may enlarge it (React Native's maxFontSizeMultiplier); null = uncapped. */
  readonly maxScale: number | null;
};

/**
 * Display figures stop growing at 1.6× (56 pt → 89.6 pt at the largest accessibility size), so the
 * "Leave in 6 min" hero and a departure's minutes never push their labels off a phone screen.
 */
export const DISPLAY_MAX_SCALE = 1.6;

/**
 * The type ramp. `hero` is the trip card's "Leave in 6 min" (56 pt SF Rounded, tabular, plan §4);
 * `minutes` is the station sheet's large minutes figure. Text styles follow Apple's defaults and
 * scale with Dynamic Type without a cap.
 */
export const TYPE_RAMP = {
  hero: { fontSize: 56, fontWeight: '700', rounded: true, tabularNums: true, ramp: 'largeTitle', maxScale: DISPLAY_MAX_SCALE },
  minutes: { fontSize: 34, fontWeight: '700', rounded: true, tabularNums: true, ramp: 'largeTitle', maxScale: DISPLAY_MAX_SCALE },
  title: { fontSize: 22, fontWeight: '700', rounded: false, tabularNums: false, ramp: 'title2', maxScale: null },
  headline: { fontSize: 17, fontWeight: '600', rounded: false, tabularNums: false, ramp: 'headline', maxScale: null },
  body: { fontSize: 17, fontWeight: '400', rounded: false, tabularNums: false, ramp: 'body', maxScale: null },
  subhead: { fontSize: 15, fontWeight: '400', rounded: false, tabularNums: false, ramp: 'subheadline', maxScale: null },
  footnote: { fontSize: 13, fontWeight: '400', rounded: false, tabularNums: false, ramp: 'footnote', maxScale: null },
  caption: { fontSize: 12, fontWeight: '400', rounded: false, tabularNums: false, ramp: 'caption1', maxScale: null },
} as const satisfies Readonly<Record<string, TypeToken>>;

export type TextVariant = keyof typeof TYPE_RAMP;
export const TEXT_VARIANTS = Object.keys(TYPE_RAMP) as readonly TextVariant[];

/** The React Native text style for a variant: size, weight, SF Rounded and tabular digits. */
export function textStyle(variant: TextVariant): TextStyle {
  const token: TypeToken = TYPE_RAMP[variant];
  invariant(token !== undefined, `"${variant}" is a type-ramp variant`);
  const style: TextStyle = {
    fontSize: token.fontSize,
    fontWeight: token.fontWeight,
    ...(token.rounded ? { fontFamily: 'ui-rounded' } : {}),
    ...(token.tabularNums ? { fontVariant: ['tabular-nums'] } : {}),
  };
  invariant(style.fontSize === token.fontSize && style.fontSize > 0, 'the style keeps the token size');
  return style;
}
