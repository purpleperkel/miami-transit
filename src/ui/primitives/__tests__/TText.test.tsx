import type { ReactElement } from 'react';
import { PlatformColor, StyleSheet, Text, type TextProps } from 'react-native';

import { TText } from '../TText';
import { renderPrimitive, unmountAll } from './render-primitive';

/** M5.4 TText: the type ramp reaches React Native's Text as size, face, tabular digits and Dynamic Type. */

afterEach(unmountAll);

/** The props React Native's Text received when `element` rendered. */
async function textProps(element: ReactElement): Promise<TextProps> {
  const tree = await renderPrimitive(element);
  const texts = tree.root.findAllByType(Text);
  expect(texts).toHaveLength(1);
  const props = texts[0]?.props as TextProps | undefined;
  expect(props).toBeDefined();
  return props as TextProps;
}

describe('TText', () => {
  it('hero renders tabular-nums with dynamicTypeRamp largeTitle', async () => {
    const props = await textProps(<TText variant="hero">6 min</TText>);
    const style = StyleSheet.flatten(props.style);
    expect(style.fontVariant).toContain('tabular-nums');
    expect(props.dynamicTypeRamp).toBe('largeTitle');
    expect(props.maxFontSizeMultiplier).toBe(1.6);
    expect([style.fontSize, style.fontWeight, style.fontFamily]).toEqual([56, '700', 'ui-rounded']);
    expect([props.allowFontScaling, props.children]).toEqual([true, '6 min']);
  });

  it('body text scales with dynamic type, uncapped and proportional', async () => {
    const props = await textProps(<TText variant="body">Government Center</TText>);
    expect([props.dynamicTypeRamp, props.maxFontSizeMultiplier, props.allowFontScaling]).toEqual(['body', 0, true]);
    expect(StyleSheet.flatten(props.style).fontVariant).toBeUndefined();
  });

  it('tone picks the system label color, and a caller style still applies', async () => {
    const props = await textProps(
      <TText variant="caption" tone="secondary" style={{ textAlign: 'right' }}>
        then 14, 26
      </TText>,
    );
    const style = StyleSheet.flatten(props.style);
    expect(style.color).toEqual(PlatformColor('secondaryLabel'));
    expect([style.textAlign, style.fontSize]).toEqual(['right', 12]);
  });
});
