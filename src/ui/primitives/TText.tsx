import { PlatformColor, Text, type TextProps } from 'react-native';

import { invariant } from '@/lib/invariant';

import { TYPE_RAMP, textStyle, type TextVariant } from '../tokens';

/** Which system label color the text takes; both adapt to light and dark mode. */
export type TextTone = 'primary' | 'secondary';

const TONE_COLOR: Readonly<Record<TextTone, string>> = { primary: 'label', secondary: 'secondaryLabel' };

/**
 * TText props: React Native's Text props, less the scaling props the variant owns. Dynamic Type is on
 * everywhere (plan §4 accessibility), so a caller cannot turn font scaling off.
 */
export type TTextProps = Omit<TextProps, 'allowFontScaling' | 'dynamicTypeRamp' | 'maxFontSizeMultiplier'> & {
  readonly variant: TextVariant;
  readonly tone?: TextTone;
};

/**
 * Text in one design-system variant (src/ui/tokens.ts): its size, weight, SF Rounded and tabular
 * digits, the Dynamic Type style it scales with, and that variant's scaling cap.
 */
export function TText({ variant, tone = 'primary', style, ...rest }: TTextProps) {
  const token = TYPE_RAMP[variant];
  invariant(token !== undefined, `"${variant}" is a type-ramp variant`);
  invariant(token.maxScale === null || token.maxScale >= 1, 'a Dynamic Type cap never shrinks text');
  return (
    <Text
      {...rest}
      allowFontScaling
      dynamicTypeRamp={token.ramp}
      // 0 = no cap (React Native's own encoding for "ignore parent and global maxima").
      maxFontSizeMultiplier={token.maxScale ?? 0}
      style={[textStyle(variant), { color: PlatformColor(TONE_COLOR[tone]) }, style]}
    />
  );
}
