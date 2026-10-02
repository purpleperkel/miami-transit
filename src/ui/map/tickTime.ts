import { invariant } from '@/lib/invariant';

/**
 * The map's frame-tick time (plan M5.13 phone check: "Diagnostics tick time < 4 ms"). Every frame tick
 * of useVehicleFrames measures its draw — the frame computation itself, not React's commit — with
 * performance.now() and records the duration here; the Diagnostics screen reads it back.
 *
 * One recorder for the app (there is one map). It runs at the frame rate (4 Hz focused), so a
 * recording only overwrites three numbers: no allocation per frame. Reading takes a snapshot.
 * While Diagnostics is open the Map tab is out of sight and its timer is stopped (tickPlan gives 0),
 * so what Diagnostics shows is what was recorded while the map was on screen.
 */

/** What the recorder holds: the latest tick, the slowest one, and how many were recorded. */
export type TickTimeReadout = {
  /** The latest frame tick's draw, in ms. */
  readonly lastMs: number;
  /** The slowest frame tick's draw since launch, in ms. */
  readonly maxMs: number;
  /** Frame ticks recorded since launch. */
  readonly count: number;
};

const recorder = { lastMs: 0, maxMs: 0, count: 0 };

/** Records one frame tick whose draw took `durationMs` (a performance.now() difference). */
export function recordTickTime(durationMs: number): void {
  invariant(Number.isFinite(durationMs) && durationMs >= 0, 'a frame tick lasts a finite, non-negative number of ms');
  recorder.lastMs = durationMs;
  recorder.maxMs = durationMs > recorder.maxMs ? durationMs : recorder.maxMs;
  recorder.count += 1;
  invariant(recorder.maxMs >= recorder.lastMs && recorder.count > 0, 'the slowest tick is never faster than the latest');
}

/** A snapshot of the recorder, or null before the map has drawn its first frame. */
export function tickTimeReadout(): TickTimeReadout | null {
  invariant(Number.isSafeInteger(recorder.count) && recorder.count >= 0, 'ticks are counted in whole numbers');
  const readout = recorder.count === 0 ? null : { lastMs: recorder.lastMs, maxMs: recorder.maxMs, count: recorder.count };
  invariant(readout === null || readout.maxMs >= readout.lastMs, 'the slowest tick is never faster than the latest');
  return readout;
}
