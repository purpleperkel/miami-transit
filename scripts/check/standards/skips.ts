import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { calleeChain, violationAt } from './ast';
import type { ParsedSource, Violation } from './types';

/**
 * Skipped tests are read from CALL EXPRESSIONS in test files — `it.skip(...)`, `xit(...)`,
 * `test(name, { skip: true }, fn)` — never from text, so a fixture string that merely spells
 * `it.skip(` is not a skipped test.
 */
const TEST_APIS: ReadonlySet<string> = new Set(['it', 'test', 'describe', 'suite']);
/** `.only` and `.failing` hide or invert results exactly like a skip does. */
const SKIP_MEMBERS: ReadonlySet<string> = new Set(['skip', 'todo', 'only', 'failing']);
const SKIP_ALIASES: ReadonlySet<string> = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);
const SKIP_OPTIONS: ReadonlySet<string> = new Set(['skip', 'todo', 'only']);

export function findSkippedTests(source: ParsedSource): Violation[] {
  invariant(source.nodes[0] === source.file, 'the node list starts at the source file');
  if (!source.isTest) {
    return [];
  }
  const violations: Violation[] = [];
  for (const node of source.nodes) {
    if (!ts.isCallExpression(node)) {
      continue;
    }
    const how = skipForm(node);
    if (how !== null) {
      const message = `skipped test (${how}) — fix the test or delete it; skipped tests are forbidden`;
      violations.push(violationAt(source, node, 'skipped-test', message));
    }
  }
  invariant(violations.every((v) => v.rule === 'skipped-test'), 'findSkippedTests only reports skips');
  return violations;
}

/** How a call skips tests (`it.skip`, `xit`, `{ skip }`), or null when it does not. */
function skipForm(call: ts.CallExpression): string | null {
  invariant(call.pos <= call.end, 'a parsed call has a well-formed span');
  const { root, members } = calleeChain(call.expression);
  invariant(root === null || root.length > 0, 'a callee root is null or a name');
  if (ts.isIdentifier(call.expression) && SKIP_ALIASES.has(call.expression.text)) {
    return `${call.expression.text}(...)`;
  }
  if (root === null || !TEST_APIS.has(root)) {
    return null;
  }
  const member = members.find((m) => SKIP_MEMBERS.has(m));
  if (member !== undefined) {
    return `${root}.${member}`;
  }
  const option = skipOption(call, root);
  return option === null ? null : `${root}(..., { ${option} })`;
}

/** A node:test options object passing `skip` / `todo` / `only` (anything but a literal `false`). */
function skipOption(call: ts.CallExpression, api: string): string | null {
  invariant(TEST_APIS.has(api), 'options are only read from test-API calls');
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) {
      continue;
    }
    for (const prop of arg.properties) {
      const name = prop.name !== undefined && ts.isIdentifier(prop.name) ? prop.name.text : null;
      const disabled = ts.isPropertyAssignment(prop) && prop.initializer.kind === ts.SyntaxKind.FalseKeyword;
      if (name !== null && SKIP_OPTIONS.has(name) && !disabled) {
        invariant(arg.properties.includes(prop), 'the option comes from this argument');
        return name;
      }
    }
  }
  return null;
}
