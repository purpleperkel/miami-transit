import { invariant } from '../../../src/lib/invariant';

/**
 * A seeded pseudo-random sequence (mulberry32) for the synthetic live fixtures: the same seed gives
 * the same numbers on every machine and every run, so the generator never needs Math.random and its
 * output is byte-for-byte reproducible.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    invariant(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, `a seed is a 32-bit unsigned integer, got ${seed}`);
    this.state = seed >>> 0;
    invariant(this.state === seed, 'the seed is kept exactly');
  }

  /** The next value in [0, 1). */
  next(): number {
    invariant(Number.isInteger(this.state) && this.state >= 0, 'the state is a 32-bit unsigned integer');
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    invariant(value >= 0 && value < 1, 'a uniform value lies in [0, 1)');
    return value;
  }

  /** A whole number in [lo, hi]. */
  int(lo: number, hi: number): number {
    invariant(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo <= hi, `[${lo}, ${hi}] is a range of whole numbers`);
    const value = lo + Math.floor(this.next() * (hi - lo + 1));
    invariant(value >= lo && value <= hi, 'the draw lies in the range');
    return value;
  }

  /** A number in [lo, hi). */
  between(lo: number, hi: number): number {
    invariant(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi, `[${lo}, ${hi}) is a range`);
    const value = lo + this.next() * (hi - lo);
    invariant(value >= lo && value <= hi, 'the draw lies in the range');
    return value;
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    invariant(p >= 0 && p <= 1, `a probability lies in [0, 1], got ${p}`);
    const hit = this.next() < p;
    invariant(typeof hit === 'boolean', 'a chance is a yes or a no');
    return hit;
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    invariant(items.length > 0, 'pick needs a non-empty list');
    const item = items[this.int(0, items.length - 1)];
    invariant(item !== undefined, 'the picked index is inside the list');
    return item;
  }

  /** A shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    invariant(out.length === items.length, 'a shuffle keeps every element');
    invariant(out.every((item) => items.includes(item)), 'a shuffle adds nothing');
    return out;
  }
}
