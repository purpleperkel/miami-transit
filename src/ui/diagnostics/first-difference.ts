import { invariant } from '@/lib/invariant';

/** Enough for any decoded feed the probes compare; a cycle or a runaway walk fails loudly instead. */
const MAX_VISITED = 100_000;

type Pending = { readonly path: string; readonly actual: unknown; readonly expected: unknown };

/**
 * Compares two JSON-shaped values (objects, arrays, strings, numbers, booleans, null) and returns
 * the path of the first difference in document order — e.g. `$.entity[2].vehicle.position.speed:
 * got 6.5, want 6.7` — or null when they are equal. Iterative (an explicit stack, no recursion).
 */
export function firstDifference(actual: unknown, expected: unknown): string | null {
  const stack: Pending[] = [{ path: '$', actual, expected }];
  let visited = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    invariant(next !== undefined, 'a non-empty stack always pops an entry');
    visited += 1;
    invariant(visited <= MAX_VISITED, `the comparison is bounded (${MAX_VISITED} nodes)`);
    const difference = compareNode(next, stack);
    if (difference !== null) {
      return difference;
    }
  }
  return null;
}

/** Compares one node; pushes its children (first key on top) when both sides are containers. */
function compareNode(node: Pending, stack: Pending[]): string | null {
  const { path, actual, expected } = node;
  invariant(path.startsWith('$'), 'paths are rooted at $');
  if (Object.is(actual, expected) || actual === expected) {
    return null;
  }
  const containers = typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null;
  if (!containers || Array.isArray(actual) !== Array.isArray(expected)) {
    return `${path}: got ${String(JSON.stringify(actual))}, want ${String(JSON.stringify(expected))}`;
  }
  const got = actual as Readonly<Record<string, unknown>>;
  const want = expected as Readonly<Record<string, unknown>>;
  const missing = Object.keys(want).find((key) => !Object.hasOwn(got, key));
  if (missing !== undefined) {
    return `${childPath(path, missing, got)}: missing`;
  }
  const extra = Object.keys(got).find((key) => !Object.hasOwn(want, key));
  if (extra !== undefined) {
    return `${childPath(path, extra, got)}: not expected`;
  }
  const keys = Object.keys(want);
  invariant(keys.length === Object.keys(got).length, 'both sides have exactly the same keys');
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i] as string;
    stack.push({ path: childPath(path, key, got), actual: got[key], expected: want[key] });
  }
  return null;
}

function childPath(path: string, key: string, container: unknown): string {
  invariant(path.length > 0, 'a child path extends a parent path');
  invariant(key.length > 0, 'a child has a key or index');
  return Array.isArray(container) ? `${path}[${key}]` : `${path}.${key}`;
}
