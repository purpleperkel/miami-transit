import { invariant } from '../../lib/invariant';
import { INLINE_MAX_CHARS } from '../hurry/copy';

/**
 * What the Now bar — the tab bar's bottom accessory (ruling R2) — says, in each placement iOS gives it:
 * `regular` (the full-width bar above the tabs: one or two lines) and `inline` (beside the minimized tab bar,
 * ruling R1: ONE line of at most INLINE_MAX_CHARS characters). VoiceOver always gets a full label. The words
 * themselves come from now-strip.ts; this module holds their shape and the regular bar's measured budget.
 */

export type AccessoryPlacement = 'regular' | 'inline';

export type NowText = {
  /**
   * What the bar shows, one line each (one host Text per line): inline exactly one; regular one or two, the
   * first naming what the bar is about (a saved trip's destination) when there is a second.
   */
  readonly lines: readonly string[];
  /** The whole thing as VoiceOver reads it, ending in what a tap does. */
  readonly label: string;
};

/**
 * mfix8 (Jamie, 2026-10-02: "sometimes bottom bar has too much txt and I can't even tell what station it thinks
 * I want"): the most characters any line of the REGULAR bar may hold. MEASURED on his phone: 40 characters
 * showed at 15 pt before the ellipsis; 38 keeps a two-character margin under that (the card's recommended value).
 */
export const REGULAR_LINE_MAX_CHARS = 38;

/** At most this many lines above the tab bar: what it is about, then what to do. */
export const REGULAR_MAX_LINES = 2;

/** True when `said` fits its placement: one short line inline; one or two lines within the budget above the tab bar. */
export function fitsPlacement(said: NowText, placement: AccessoryPlacement): boolean {
  invariant(placement === 'regular' || placement === 'inline', `the bar has a known placement, got ${placement}`);
  invariant(said.label.trim().length > 0, 'the bar always says something to VoiceOver');
  const [max, maxLines] = placement === 'inline' ? [INLINE_MAX_CHARS, 1] : [REGULAR_LINE_MAX_CHARS, REGULAR_MAX_LINES];
  return said.lines.length >= 1 && said.lines.length <= maxLines && said.lines.every((line) => line.trim().length > 0 && [...line].length <= max);
}
