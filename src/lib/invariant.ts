/**
 * The assertion primitive behind Jamie's "≥ 2 assertions per function" rule.
 *
 * `invariant(condition, message)` states a precondition, postcondition or invariant. When the
 * condition is falsy it throws an `InvariantError`; TypeScript narrows on the `asserts` signature,
 * so a passed invariant also refines types for the code after it.
 *
 * This module is pure (no react / expo imports) so the app, `src/domain` and the Mac-side scripts
 * share one implementation. `invariant` itself is the base case of the rule it serves: it cannot
 * assert with itself without recursing, so the standards checker exempts exactly this function
 * (see ASSERTION_PRIMITIVES in scripts/check/rules/functions.ts).
 */

/** Thrown when an invariant does not hold: a broken contract, never an expected outcome. */
export class InvariantError extends Error {
  override readonly name = 'InvariantError';
}

const DEFAULT_MESSAGE = 'Invariant violated';

export function invariant(condition: unknown, message: string = DEFAULT_MESSAGE): asserts condition {
  if (!condition) {
    throw new InvariantError(message);
  }
}
