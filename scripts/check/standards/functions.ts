import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { asFunction, calleeChain, enclosingFunction, functionName, lineSpan, violationAt } from './ast';
import type { ParsedSource, Violation } from './types';

/** Functions ≤ 60 lines — one page, one purpose (counted like eslint max-lines-per-function). */
export const MAX_FUNCTION_LINES = 60;
/** Every named function states ≥ 2 contracts (pre/postconditions, invariants). */
export const MIN_ASSERTIONS = 2;
/** Anonymous inline callbacks this short are exempt from the assertion count. */
export const INLINE_CALLBACK_EXEMPT_LINES = 5;

/**
 * The assertion primitive is the base case of the assertion rule: `invariant` cannot assert with
 * itself without recursing. Exactly this function — matched by file AND name — is exempt.
 */
const ASSERTION_PRIMITIVES: readonly { path: string; name: string }[] = [
  { path: 'src/lib/invariant.ts', name: 'invariant' },
];

/** Test callbacks grouped under these are containers; their tests are checked one by one. */
const GROUP_APIS: ReadonlySet<string> = new Set(['describe', 'suite']);

/** fn-length and assertions for every function in one file. */
export function checkFunctions(source: ParsedSource): Violation[] {
  invariant(source.nodes[0] === source.file, 'the node list starts at the source file');
  const assertionCounts = countAssertions(source);
  const violations: Violation[] = [];
  for (const node of source.nodes) {
    const fn = asFunction(node);
    if (fn === null) {
      continue;
    }
    const name = functionName(fn, source.file);
    const label = name ?? 'anonymous function';
    const span = lineSpan(fn, source.file);
    if (span > MAX_FUNCTION_LINES) {
      const message = `\`${label}\` is ${span} lines; functions are limited to ${MAX_FUNCTION_LINES}`;
      violations.push(violationAt(source, fn, 'fn-length', message));
    }
    const count = assertionCounts.get(fn) ?? 0;
    if (count < MIN_ASSERTIONS && needsAssertions(source, fn, name, span)) {
      violations.push(violationAt(source, fn, 'assertions', assertionMessage(source, label, count)));
    }
  }
  invariant(violations.every((v) => v.path === source.path), 'violations belong to the checked file');
  return violations;
}

/** Assertion calls per function, attributed to the nearest enclosing function only. */
function countAssertions(source: ParsedSource): Map<ts.Node, number> {
  invariant(source.nodes.length > 0, 'countAssertions needs a collected node list');
  const counts = new Map<ts.Node, number>();
  for (const node of source.nodes) {
    if (!ts.isCallExpression(node) || !isAssertionCall(node, source.isTest)) {
      continue;
    }
    const owner = enclosingFunction(node);
    if (owner !== null) {
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }
  invariant([...counts.values()].every((n) => n > 0), 'only functions with assertions are counted');
  return counts;
}

/** `invariant(...)` everywhere; in test files also `expect(...)`, `assert(...)` and `assert.x(...)`. */
function isAssertionCall(call: ts.CallExpression, isTest: boolean): boolean {
  invariant(call.arguments !== undefined, 'a call expression has an argument list');
  const { root, members } = calleeChain(call.expression);
  invariant(root === null || root.length > 0, 'a callee root is null or a name');
  if (ts.isIdentifier(call.expression) && call.expression.text === 'invariant') {
    return true;
  }
  if (!isTest) {
    return false;
  }
  const directExpect = ts.isIdentifier(call.expression) && call.expression.text === 'expect';
  const nodeAssert = root === 'assert' && members.length <= 1 && !ts.isCallExpression(call.expression);
  return directExpect || nodeAssert;
}

function needsAssertions(source: ParsedSource, fn: ts.FunctionLikeDeclaration, name: string | null, span: number): boolean {
  invariant(span >= 1, 'a function spans at least one line');
  invariant(fn.getSourceFile() === source.file, 'the function belongs to the checked file');
  if (name !== null) {
    return !ASSERTION_PRIMITIVES.some((p) => p.path === source.path && p.name === name);
  }
  if (source.isTest && isGroupCallback(fn)) {
    return false;
  }
  return span > INLINE_CALLBACK_EXEMPT_LINES;
}

/** The callback handed to `describe(...)` / `suite(...)` (including `describe.each(...)(...)`). */
function isGroupCallback(fn: ts.FunctionLikeDeclaration): boolean {
  const parent = fn.parent;
  invariant(parent !== undefined, 'a parsed function has a parent');
  if (!ts.isCallExpression(parent) || !parent.arguments.some((arg) => arg === fn)) {
    return false;
  }
  const { root } = calleeChain(parent.expression);
  invariant(root === null || root.length > 0, 'a callee root is null or a name');
  return root !== null && GROUP_APIS.has(root);
}

function assertionMessage(source: ParsedSource, label: string, count: number): string {
  invariant(count >= 0 && count < MIN_ASSERTIONS, 'a message is only built for a short count');
  invariant(label.length > 0, 'the message names the function');
  const accepted = source.isTest ? 'invariant()/expect()/assert()' : 'invariant()';
  return `\`${label}\` has ${count} assertion call(s); needs >= ${MIN_ASSERTIONS} ${accepted} (pre/postconditions)`;
}
