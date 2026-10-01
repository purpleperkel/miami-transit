import type { LineId } from '../../domain/lines/line-catalog';
import { TRUNK_LINE_IDS } from '../../domain/live/types';
import { contrast, cvdDeltaE, isHexColor, type CvdType } from '../colorMath';
import { COLOR_SCHEMES, LINE_PALETTE, MAP_LAND, lineColors, type ColorScheme } from '../colors';

/**
 * M5.3 line palette, measured with the real colorMath: line on map land >= 3:1 (WCAG 1.4.11 non-text),
 * badge text >= 4.5:1 (WCAG 1.4.3), and CIE76 deltaE between lines a color-blind rider must tell
 * apart (Machado 2009, severity 1.0). Describe titles name no line, so each test's full name matches
 * exactly one acceptance case.
 */

const LINES: readonly { readonly label: string; readonly id: LineId }[] = [
  { label: 'Green', id: 'GREEN' },
  { label: 'Orange', id: 'ORANGE' },
  { label: 'Inner Loop', id: 'MM_INNER' },
  { label: 'Omni', id: 'MM_OMNI' },
  { label: 'Brickell', id: 'MM_BRICKELL' },
];

const LINE_CASES = COLOR_SCHEMES.flatMap((scheme) => LINES.map((line) => ({ ...line, scheme })));

/** Every (deficiency, scheme) pair for a list of deficiencies. */
function cvdCases(cvds: readonly CvdType[]): { cvd: CvdType; scheme: ColorScheme }[] {
  const cases = COLOR_SCHEMES.flatMap((scheme) => cvds.map((cvd) => ({ cvd, scheme })));
  expect(cases).toHaveLength(cvds.length * COLOR_SCHEMES.length);
  expect(new Set(cases.map((c) => `${c.cvd}/${c.scheme}`)).size).toBe(cases.length);
  return cases;
}

describe('line palette on map land', () => {
  it.each(LINE_CASES)('$label stroke or casing >= 3:1 on map land ($scheme)', ({ id, scheme }) => {
    const { stroke, casing } = lineColors(id, scheme);
    const best = Math.max(contrast(stroke, MAP_LAND[scheme]), contrast(casing, MAP_LAND[scheme]));
    expect(best).toBeGreaterThanOrEqual(3);
    expect(stroke).not.toBe(casing);
  });
});

describe('line palette badges', () => {
  it.each(LINE_CASES)('$label badge text >= 4.5:1 ($scheme)', ({ id, scheme }) => {
    const { stroke, badgeText } = lineColors(id, scheme);
    expect(contrast(badgeText, stroke)).toBeGreaterThanOrEqual(4.5);
    expect(isHexColor(badgeText)).toBe(true);
  });
});

describe('line palette under color-vision deficiency', () => {
  it.each(cvdCases(['deuteranopia', 'protanopia']))('Green/Orange deltaE >= 30 under $cvd ($scheme)', ({ cvd, scheme }) => {
    const [green, orange] = [lineColors('GREEN', scheme).stroke, lineColors('ORANGE', scheme).stroke];
    expect(cvdDeltaE(green, orange, cvd)).toBeGreaterThanOrEqual(30);
    expect(cvdDeltaE(orange, green, cvd)).toBeCloseTo(cvdDeltaE(green, orange, cvd), 9);
  });

  it.each(cvdCases(['protanopia', 'deuteranopia', 'tritanopia']))('Inner Loop/Omni deltaE >= 25 under $cvd ($scheme)', ({ cvd, scheme }) => {
    const [inner, omni] = [lineColors('MM_INNER', scheme).stroke, lineColors('MM_OMNI', scheme).stroke];
    expect(cvdDeltaE(inner, omni, cvd)).toBeGreaterThanOrEqual(25);
    expect(cvdDeltaE(omni, inner, cvd)).toBeCloseTo(cvdDeltaE(inner, omni, cvd), 9);
  });
});

describe('line palette integrity', () => {
  it('every live line id has hex colors in both schemes', () => {
    const entries = Object.entries(LINE_PALETTE).flatMap(([id, schemes]) => COLOR_SCHEMES.map((scheme) => ({ id, ...schemes[scheme] })));
    expect(entries).toHaveLength(7 * 2);
    expect(entries.filter((e) => ![e.stroke, e.casing, e.badgeText].every(isHexColor))).toEqual([]);
  });

  it('the strokes keep the plan table, except the measured dark orange fix', () => {
    const light = LINES.map(({ id }) => lineColors(id, 'light').stroke);
    const dark = LINES.map(({ id }) => lineColors(id, 'dark').stroke);
    expect(light).toEqual(['#0E9F6E', '#E8590C', '#0E95D0', '#2E3FB0', '#F2B705']);
    expect(dark).toEqual(['#35D49A', '#F9763C', '#5AD1FF', '#7C83FF', '#FFD24A']);
    expect(lineColors('MM_BRICKELL', 'light').casing).toBe('#8A6100');
  });

  it.each(TRUNK_LINE_IDS)('%s renders the neutral gray, legible on land and under its bullet letter', (id) => {
    const colors = COLOR_SCHEMES.map((scheme) => ({ scheme, ...lineColors(id, scheme) }));
    expect(colors.map((c) => c.stroke)).toEqual(['#6E6E73', '#AEAEB2']);
    expect(colors.filter((c) => contrast(c.stroke, MAP_LAND[c.scheme]) < 3 || contrast(c.badgeText, c.stroke) < 4.5)).toEqual([]);
  });
});
