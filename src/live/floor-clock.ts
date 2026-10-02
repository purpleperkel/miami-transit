import { invariant } from '../lib/invariant';

/**
 * mfix10 fix round 4 (S1): the clock Swiftly's 30 s floor runs on (providers/swiftly.ts) — AWAKE
 * MONOTONIC milliseconds plus the SLEEP inside every spell the app spends out of the foreground,
 * measured on the wall clock.
 *
 * Why: on iOS, React Native 0.86's performance.now() reads mach_absolute_time
 * (ReactCommon/react/timing/primitives.h), which does not advance while the phone sleeps. A floor
 * started just before a lock would still be running after the unlock, in awake time, and the first
 * Swiftly poll on unlock would be handed the download from before the lock. The phone is always out of
 * the foreground while it is locked, so the runtime marks every departure (`background()`, when the
 * app goes inactive or to the background) and every return (`foreground()`, on resume).
 *
 * On a return, the part of the spell away that the awake clock MISSED — the wall span minus the awake
 * span, never less than zero — is added to an offset, and `now()` reads the awake clock plus that
 * offset. Time the phone stayed awake while the app was away (another app open) is on the awake clock
 * already, so it is not counted twice: a 20 s trip to another app does not end a floor 20 s early.
 * A wall-clock jump matters only when it happens while the app is away (a jump forward ends the floor
 * that much sooner; a jump back adds nothing): accepted (arbiter, fix round 4).
 */
export class FloorClock {
  /** The sleep counted so far, in ms: only ever grows. */
  private sleptMs = 0;
  /** Where both clocks stood when the app left the foreground, while it is away; null in the foreground. */
  private left: { readonly wallMs: number; readonly awakeMs: number } | null = null;

  constructor(
    private readonly awakeMs: () => number,
    private readonly wallMs: () => number,
  ) {
    invariant(typeof awakeMs === 'function', 'the floor clock reads an awake clock (performance.now() on the phone)');
    invariant(typeof wallMs === 'function', 'the floor clock measures the spells away on the wall clock');
  }

  /** Whether the app is away from the foreground: between background() and the next foreground(). */
  get away(): boolean {
    const left = this.left;
    invariant(this.sleptMs >= 0, 'the counted sleep is never negative');
    invariant(left === null || (Number.isFinite(left.wallMs) && Number.isFinite(left.awakeMs)), 'a departure is marked at finite instants');
    return left !== null;
  }

  /** The floor clock's instant, in ms: the awake clock plus every sleep counted so far. */
  now(): number {
    const now = this.awakeMs() + this.sleptMs;
    invariant(Number.isFinite(now), 'the floor clock reads a finite instant');
    invariant(this.sleptMs >= 0, 'the counted sleep is never negative');
    return now;
  }

  /** The app left the foreground: both clocks are marked. Leaving again while away keeps the first mark. */
  background(): void {
    if (this.left === null) {
      this.left = Object.freeze({ wallMs: this.wallMs(), awakeMs: this.awakeMs() });
    }
    invariant(Number.isFinite(this.left.wallMs) && Number.isFinite(this.left.awakeMs), 'both clocks read finite instants at the departure');
    invariant(this.away, 'the app is away until it returns');
  }

  /** The app is back: the sleep inside the spell away (wall span minus awake span, never negative) is counted. A return with no departure counts nothing. */
  foreground(): void {
    const left = this.left;
    const before = this.sleptMs;
    if (left !== null) {
      const wallSpanMs = this.wallMs() - left.wallMs;
      const awakeSpanMs = this.awakeMs() - left.awakeMs;
      this.sleptMs += Math.max(0, wallSpanMs - awakeSpanMs);
      this.left = null;
    }
    invariant(this.sleptMs >= before, 'counted sleep only grows: a wall clock set back while away adds nothing');
    invariant(!this.away, 'the app is in the foreground');
  }
}
