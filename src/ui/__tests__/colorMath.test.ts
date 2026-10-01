import { InvariantError } from '../../lib/invariant';
import { CVD_TYPES, contrast, cvdDeltaE, hexToLinear, linearToLab, relativeLuminance, simulateCvd } from '../colorMath';

/** M5.2 colorMath: WCAG contrast, and the CVD distance the palette is tested on. */

describe('colorMath', () => {
  it('contrast(black, white) = 21', () => {
    expect(Math.abs(contrast('#000000', '#FFFFFF') - 21)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(contrast('#FFFFFF', '#000000') - 21)).toBeLessThanOrEqual(0.01);
  });

  it('contrast(x, x) = 1', () => {
    const samples = ['#000000', '#FFFFFF', '#767676', '#0E9F6E', '#8A6100', '#1D2F43'];
    expect(samples.map((x) => contrast(x, x))).toEqual(samples.map(() => 1));
    expect(contrast('#0e9f6e', '#0E9F6E')).toBe(1);
  });

  it('#767676 on white is the 4.54:1 wcag aa boundary gray', () => {
    expect(Math.abs(contrast('#767676', '#FFFFFF') - 4.54)).toBeLessThanOrEqual(0.01);
    expect(contrast('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });

  it('relative luminance runs from 0 for black to 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 12);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158605, 6);
  });

  it('malformed colors are refused, not guessed', () => {
    expect(() => contrast('#FFF', '#000000')).toThrow(InvariantError);
    expect(() => contrast('#000000', 'white')).toThrow(InvariantError);
    expect(() => cvdDeltaE('#000000', '#GGGGGG', 'protanopia')).toThrow(InvariantError);
  });
});

describe('colorMath: cielab and cvd simulation', () => {
  it('white is l* 100 and black is l* 0, both without hue', () => {
    const white = linearToLab(hexToLinear('#FFFFFF'));
    const black = linearToLab(hexToLinear('#000000'));
    expect([white.l, white.a, white.b]).toEqual([100, 0, 0]);
    expect([black.l, black.a, black.b]).toEqual([0, 0, 0]);
  });

  it.each(CVD_TYPES)('a gray stays gray under simulated %s', (cvd) => {
    const [r, g, b] = simulateCvd('#808080', cvd);
    const [r0] = hexToLinear('#808080');
    expect(Math.max(Math.abs(r - r0), Math.abs(g - r0), Math.abs(b - r0))).toBeLessThan(1e-4);
    expect(cvdDeltaE('#808080', '#808080', cvd)).toBe(0);
  });

  it('cvd deltaE reproduces the independent measures of the plan pairs', () => {
    // The card's note measured these with its own implementation: the plan's dark Green/Orange pair
    // gives 27.9 under protanopia, and dark Orange #FF6E3A would give 31.4.
    expect(cvdDeltaE('#35D49A', '#FF7A45', 'protanopia')).toBeCloseTo(27.9, 1);
    expect(cvdDeltaE('#35D49A', '#FF6E3A', 'protanopia')).toBeCloseTo(31.4, 1);
    expect(cvdDeltaE('#35D49A', '#FF7A45', 'deuteranopia')).toBeGreaterThan(cvdDeltaE('#35D49A', '#FF7A45', 'protanopia'));
  });
});
