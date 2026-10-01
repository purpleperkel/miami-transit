import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { asFunction, violationAt } from './ast';
import type { ParsedSource, Violation } from './types';

/**
 * No silent catch: a `catch` block — or an inline `.catch(handler)` — must rethrow (`throw`) or
 * hand the failure on as a Result (`err(...)`). Anything else swallows the error.
 */
export function findSilentCatches(source: ParsedSource): Violation[] {
  invariant(source.nodes[0] === source.file, 'the node list starts at the source file');
  const violations: Violation[] = [];
  for (const node of source.nodes) {
    if (ts.isCatchClause(node) && !propagates(node.block)) {
      const message = 'catch block swallows the error — rethrow it or return err(...)';
      violations.push(violationAt(source, node, 'silent-catch', message));
    }
    const handler = ts.isCallExpression(node) ? promiseCatchHandler(node) : null;
    if (handler !== null && !propagates(handler.body)) {
      const message = '.catch() handler swallows the error — rethrow it or return err(...)';
      violations.push(violationAt(source, node, 'silent-catch', message));
    }
  }
  invariant(violations.every((v) => v.rule === 'silent-catch'), 'findSilentCatches only reports catches');
  return violations;
}

/** The inline function passed to `promise.catch(...)`, or null for any other call. */
function promiseCatchHandler(call: ts.CallExpression): ts.FunctionLikeDeclaration | null {
  invariant(call.pos <= call.end, 'a parsed call has a well-formed span');
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'catch') {
    return null;
  }
  const first = call.arguments[0];
  const handler = first === undefined ? null : asFunction(first);
  invariant(handler === null || handler.parent === call, 'the handler is an argument of this call');
  return handler;
}

/**
 * True when `body` (not counting nested functions, which run later or never) contains a `throw`
 * or an `err(...)` call. An expression body counts too: `.catch((e) => err(e))`.
 */
function propagates(body: ts.Node | undefined): boolean {
  invariant(body !== undefined, 'a catch block or handler always has a body');
  invariant(body.pos <= body.end, 'the body has a well-formed span');
  const stack: ts.Node[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    invariant(node !== undefined, 'a non-empty stack always pops a node');
    const errCall = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'err';
    if (ts.isThrowStatement(node) || errCall) {
      return true;
    }
    if (node !== body && asFunction(node) !== null) {
      continue;
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return false;
}
