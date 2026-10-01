import { invariant } from '../lib/invariant';

/**
 * Color math for the line palette (plan §4 "UX system", M5.2–M5.3): WCAG contrast, and the
 * color-blind distance the palette is tested on. Pure (no react, react-native or expo imports), so
 * jest, the Mac scripts and a bare `node --import tsx` all load the same implementation.
 *
 * Colors are '#RRGGBB' strings in sRGB.
 * - contrast(): WCAG 2.x relative luminance and contrast ratio
 *   (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance, #dfn-contrast-ratio).
 * - cvdDeltaE(): simulate a dichromat with Machado, Oliveira & Fernandes (2009) at severity 1.0 on
 *   LINEAR sRGB, then measure CIE76 ΔE*ab in CIELAB (D65). The matrices are the paper's
 *   supplementary values (inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation), checked 2026-10-01
 *   against colorspacious's cvd.py (severity 100), which packages the same table.
 */

/** Linear-light sRGB channels, each 0–1. */
export type LinearRgb = readonly [number, number, number];
/** A CIELAB color (D65 white): L* 0–100, a* and b* signed. */
export type Lab = { readonly l: number; readonly a: number; readonly b: number };

export const CVD_TYPES = ['protanopia', 'deuteranopia', 'tritanopia'] as const;
export type CvdType = (typeof CVD_TYPES)[number];

type Matrix3 = readonly [LinearRgb, LinearRgb, LinearRgb];

/** Machado et al. 2009, severity 1.0 (full dichromacy), applied to linear sRGB. */
const MACHADO_2009: Readonly<Record<CvdType, Matrix3>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** Linear sRGB → CIE XYZ (D65), IEC 61966-2-1. */
const SRGB_TO_XYZ: Matrix3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

/**
 * The D65 reference white in XYZ: SRGB_TO_XYZ applied to linear white, i.e. its row sums
 * (≈ 0.95047, 1, 1.08883). Derived rather than typed in, so sRGB white is exactly L* 100, a* = b* = 0.
 */
const D65_WHITE: LinearRgb = multiply(SRGB_TO_XYZ, [1, 1, 1]);

/** CIELAB's companding threshold δ = 6/29: below δ³ the cube root is replaced by a line. */
const LAB_DELTA = 6 / 29;

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** True for a '#RRGGBB' string. */
export function isHexColor(value: string): boolean {
  invariant(typeof value === 'string', 'a color is a string');
  const valid = HEX_COLOR.test(value);
  invariant(!valid || value.length === 7, "a '#RRGGBB' color is 7 characters");
  return valid;
}

/** One gamma-encoded sRGB channel (0–1) → linear light, per IEC 61966-2-1 (the WCAG 2.x formula). */
export function srgbToLinear(channel: number): number {
  invariant(channel >= 0 && channel <= 1, `an sRGB channel is in 0–1, got ${channel}`);
  const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  invariant(linear >= 0 && linear <= 1, 'linear light stays in 0–1');
  return linear;
}

/** '#RRGGBB' → linear-light sRGB channels, each 0–1. */
export function hexToLinear(hex: string): LinearRgb {
  invariant(isHexColor(hex), `expected a '#RRGGBB' color, got "${hex}"`);
  const [r, g, b] = [1, 3, 5].map((offset) => srgbToLinear(parseInt(hex.slice(offset, offset + 2), 16) / 255));
  invariant(r !== undefined && g !== undefined && b !== undefined, 'a hex color has three channels');
  return [r, g, b];
}

/** WCAG 2.x relative luminance of a '#RRGGBB' color: 0 for black, 1 for white. */
export function relativeLuminance(hex: string): number {
  invariant(isHexColor(hex), `expected a '#RRGGBB' color, got "${hex}"`);
  const [r, g, b] = hexToLinear(hex);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  invariant(luminance >= 0 && luminance <= 1 + 1e-12, 'relative luminance is in 0–1');
  return luminance;
}

/** WCAG 2.x contrast ratio of two '#RRGGBB' colors, 1–21, the same in either order. */
export function contrast(a: string, b: string): number {
  invariant(isHexColor(a) && isHexColor(b), `contrast needs two '#RRGGBB' colors, got "${a}" and "${b}"`);
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  invariant(ratio >= 1 && ratio <= 21 + 1e-9, `a contrast ratio is in 1–21, got ${ratio}`);
  return ratio;
}

/** The dot product of one matrix row and a 3-vector. */
function dot(row: LinearRgb, v: LinearRgb): number {
  invariant(row.length === 3 && v.length === 3, 'a dot product of two 3-vectors');
  const sum = row[0] * v[0] + row[1] * v[1] + row[2] * v[2];
  invariant(Number.isFinite(sum), 'a dot product of finite vectors is finite');
  return sum;
}

/** A 3×3 matrix times a 3-vector. */
function multiply(matrix: Matrix3, v: LinearRgb): LinearRgb {
  invariant(matrix.length === 3, 'a 3×3 matrix has three rows');
  const out: LinearRgb = [dot(matrix[0], v), dot(matrix[1], v), dot(matrix[2], v)];
  invariant(out.length === 3, 'a matrix product is a 3-vector');
  return out;
}

/** A finite channel clipped into the displayable 0–1 range. */
function clipChannel(c: number): number {
  invariant(Number.isFinite(c), `a channel to clip is finite, got ${c}`);
  const clipped = Math.min(1, Math.max(0, c));
  invariant(clipped >= 0 && clipped <= 1, 'a clipped channel is in 0–1');
  return clipped;
}

/**
 * How a dichromat sees a '#RRGGBB' color: Machado 2009 severity 1.0 on linear sRGB, clipped to the
 * displayable 0–1 range (the simulated color is what a display can show).
 */
export function simulateCvd(hex: string, cvd: CvdType): LinearRgb {
  invariant(isHexColor(hex), `expected a '#RRGGBB' color, got "${hex}"`);
  invariant(CVD_TYPES.includes(cvd), `"${cvd}" is a simulated color-vision deficiency`);
  const [r, g, b] = multiply(MACHADO_2009[cvd], hexToLinear(hex));
  return [clipChannel(r), clipChannel(g), clipChannel(b)];
}

/** CIELAB's f(t): the cube root above δ³, the linear segment below it (CIE 15:2004). */
function labCompand(t: number): number {
  invariant(Number.isFinite(t) && t >= 0, `CIELAB companding takes a non-negative ratio, got ${t}`);
  const f = t > LAB_DELTA ** 3 ? Math.cbrt(t) : t / (3 * LAB_DELTA ** 2) + 4 / 29;
  invariant(f >= 4 / 29 - 1e-12, 'f(t) is at least 4/29');
  return f;
}

/** Linear sRGB → CIELAB (D65 white), the space CIE76 ΔE*ab is measured in. */
export function linearToLab(rgb: LinearRgb): Lab {
  invariant(rgb.every((c) => c >= 0 && c <= 1), 'CIELAB conversion takes linear sRGB in 0–1');
  const [x, y, z] = multiply(SRGB_TO_XYZ, rgb);
  const [fx, fy, fz] = [labCompand(x / D65_WHITE[0]), labCompand(y / D65_WHITE[1]), labCompand(z / D65_WHITE[2])];
  const lab: Lab = { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  invariant(lab.l >= -1e-9 && lab.l <= 100 + 1e-9, `CIELAB L* is in 0–100, got ${lab.l}`);
  return lab;
}

/** CIE76 ΔE*ab: the Euclidean distance between two CIELAB colors. */
export function deltaE76(x: Lab, y: Lab): number {
  invariant([x.l, x.a, x.b, y.l, y.a, y.b].every(Number.isFinite), 'ΔE needs two finite CIELAB colors');
  const distance = Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b);
  invariant(distance >= 0, 'a distance is never negative');
  return distance;
}

/** CIE76 ΔE*ab between two '#RRGGBB' colors as a dichromat of the given type sees them. */
export function cvdDeltaE(a: string, b: string, cvd: CvdType): number {
  invariant(isHexColor(a) && isHexColor(b), `cvdDeltaE needs two '#RRGGBB' colors, got "${a}" and "${b}"`);
  invariant(CVD_TYPES.includes(cvd), `"${cvd}" is a simulated color-vision deficiency`);
  return deltaE76(linearToLab(simulateCvd(a, cvd)), linearToLab(simulateCvd(b, cvd)));
}
