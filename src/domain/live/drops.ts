import { invariant } from '../../lib/invariant';
import type { DropReason } from './types';

/** A mapper's running tally of what it left out, by reason (becomes MappedFeed.dropped). */
export type Drops = Partial<Record<DropReason, number>>;

/** Count `n` items left out for `reason`. */
export function countDrop(dropped: Drops, reason: DropReason, n = 1): void {
  invariant(Number.isSafeInteger(n) && n >= 1, `a drop counts whole items, got ${n}`);
  const before = dropped[reason] ?? 0;
  dropped[reason] = before + n;
  invariant(dropped[reason] === before + n, 'the drop was counted');
}
