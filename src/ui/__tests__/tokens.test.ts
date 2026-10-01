import { DISPLAY_MAX_SCALE, RADIUS, SPACING, TEXT_VARIANTS, TYPE_RAMP, textStyle } from '../tokens';

/** M5.1 design tokens: the 4-pt grid, the hero's Dynamic Type cap, tabular minutes. */

describe('design tokens', () => {
  it('spacing is on the 4-pt grid', () => {
    const steps = Object.values(SPACING);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(steps.filter((points) => points <= 0 || points % 4 !== 0)).toEqual([]);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('corner radii share the 4-pt grid', () => {
    const radii = Object.values(RADIUS);
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((points) => points <= 0 || points % 4 !== 0)).toEqual([]);
  });

  it('hero maxScale <= 1.6', () => {
    const cap = TYPE_RAMP.hero.maxScale;
    expect(cap).toBeLessThanOrEqual(1.6);
    expect(cap).toBeGreaterThanOrEqual(1);
    expect(cap).toBe(DISPLAY_MAX_SCALE);
    expect(TYPE_RAMP.hero.fontSize).toBe(56);
  });

  it('minutes use tabular-nums', () => {
    expect(TYPE_RAMP.minutes.tabularNums).toBe(true);
    expect(textStyle('minutes').fontVariant).toEqual(['tabular-nums']);
    expect(textStyle('hero').fontVariant).toEqual(['tabular-nums']);
  });

  it('the countdown figures are sf rounded; text styles are not', () => {
    expect([textStyle('hero').fontFamily, textStyle('minutes').fontFamily]).toEqual(['ui-rounded', 'ui-rounded']);
    expect(textStyle('body').fontFamily).toBeUndefined();
    expect(textStyle('body').fontVariant).toBeUndefined();
  });

  it('every variant maps to its own size, and only display figures cap dynamic type', () => {
    expect(TEXT_VARIANTS.map((variant) => textStyle(variant).fontSize)).toEqual(TEXT_VARIANTS.map((variant) => TYPE_RAMP[variant].fontSize));
    const capped = TEXT_VARIANTS.filter((variant) => TYPE_RAMP[variant].maxScale !== null);
    expect(capped).toEqual(['hero', 'minutes']);
  });
});
