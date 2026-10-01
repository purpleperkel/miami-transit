import { invariant } from '../../lib/invariant';

/**
 * How often the map's vehicles move (plan §4 "Motion follows the track", M5.10): a frame tick every
 * 250 ms while the map is in front of the rider, a 5 s jump under Reduce Motion (§4 accessibility),
 * and no timer at all when nobody can see it — the app is not active, or the Map tab is not focused.
 * Inactive wins over Reduce Motion: a hidden map never ticks. Pure, so the rule is tested on its own.
 */

/** A frame every quarter second: smooth along the track, a few dozen markers per tick. */
export const FOCUSED_TICK_MS = 250;
/** Reduce Motion: the markers jump every 5 s instead of gliding. */
export const REDUCED_MOTION_TICK_MS = 5_000;
/** No timer: the map is not on screen. */
export const NO_TICK_MS = 0;

export type TickInputs = {
  /** React Native's AppState is 'active' (the app is in the foreground). */
  readonly appActive: boolean;
  /** The Map tab is the focused screen (no other tab, no sheet over it). */
  readonly mapFocused: boolean;
  /** iOS Reduce Motion is on. */
  readonly reduceMotion: boolean;
};

/** The frame tick period in ms, or 0 for no timer. */
export function tickPlan(inputs: TickInputs): number {
  invariant(
    typeof inputs.appActive === 'boolean' && typeof inputs.mapFocused === 'boolean' && typeof inputs.reduceMotion === 'boolean',
    'the tick plan reads three yes/no facts',
  );
  const visible = inputs.appActive && inputs.mapFocused;
  const ms = !visible ? NO_TICK_MS : inputs.reduceMotion ? REDUCED_MOTION_TICK_MS : FOCUSED_TICK_MS;
  invariant(ms === NO_TICK_MS || visible, 'only a visible map ticks');
  return ms;
}
