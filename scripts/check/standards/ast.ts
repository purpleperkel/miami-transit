import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import type { ParsedSource, RuleId, Violation } from './types';

/**
 * Shared AST helpers. Every walk here uses an explicit stack or a bounded parent-chain loop:
 * the checker bans recursion, so it cannot use a recursive visitor itself.
 */

const FUNCTION_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Every node under `root` (inclusive) in source pre-order, collected with an explicit stack. */
export function collectNodes(root: ts.Node): ts.Node[] {
  invariant(root.pos <= root.end, 'collectNodes needs a node with a well-formed span');
  const nodes: ts.Node[] = [];
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    invariant(node !== undefined, 'a non-empty stack always pops a node');
    nodes.push(node);
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      invariant(child !== undefined, 'child indices stay inside the child list');
      stack.push(child);
    }
  }
  invariant(nodes[0] === root, 'the walk starts at its root');
  return nodes;
}

/** A function-like node that has a body (declarations, expressions, arrows, methods, accessors). */
export function asFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  invariant(node.pos <= node.end, 'asFunction needs a node with a well-formed span');
  if (!FUNCTION_KINDS.has(node.kind)) {
    return null;
  }
  const fn = node as ts.FunctionLikeDeclaration;
  const result = fn.body === undefined ? null : fn;
  invariant(result === null || result.body !== undefined, 'a returned function always has a body');
  return result;
}

/** The nearest function-with-body strictly above `node`, or null at module level. */
export function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  invariant(!ts.isSourceFile(node), 'a source file has no enclosing function');
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const fn = asFunction(current);
    if (fn !== null) {
      invariant(fn.pos <= node.pos && node.end <= fn.end, 'an enclosing function contains the node');
      return fn;
    }
    current = current.parent;
  }
  return null;
}

/** 1-based line count from the function's first token to its last line, inclusive. */
export function lineSpan(fn: ts.Node, file: ts.SourceFile): number {
  invariant(fn.getSourceFile() === file, 'lineSpan measures a node inside the given file');
  const first = file.getLineAndCharacterOfPosition(fn.getStart(file)).line;
  const last = file.getLineAndCharacterOfPosition(fn.end).line;
  const span = last - first + 1;
  invariant(span >= 1, 'every function spans at least one line');
  return span;
}

/** Repo convention: files under `__tests__/` or named `*.test.*` / `*.spec.*` are tests. */
export function isTestPath(path: string): boolean {
  invariant(path.length > 0, 'isTestPath needs a path');
  invariant(!path.includes('\\'), 'paths are repo-relative POSIX paths');
  return TEST_PATH.test(path);
}

/** The identifier at the root of a callee chain (`describe.each(t)` → describe) and the members on the way. */
export function calleeChain(callee: ts.Expression): { root: string | null; members: string[] } {
  invariant(callee.pos <= callee.end, 'calleeChain needs a parsed expression');
  const members: string[] = [];
  let current: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      members.push(current.name.text);
    }
    current = current.expression;
  }
  const root = ts.isIdentifier(current) ? current.text : null;
  invariant(root === null || root.length > 0, 'an identifier root has a name');
  return { root, members: members.reverse() };
}

/** A violation anchored at a node's first token (or at a raw text position). */
export function violationAt(source: ParsedSource, at: ts.Node | number, rule: RuleId, message: string): Violation {
  const pos = typeof at === 'number' ? at : at.getStart(source.file);
  invariant(pos >= 0 && pos <= source.file.text.length, 'a violation points inside its file');
  invariant(message.length > 0, 'every violation explains itself');
  const { line, character } = source.file.getLineAndCharacterOfPosition(pos);
  return { path: source.path, line: line + 1, column: character + 1, rule, message };
}

/**
 * The name a function is declared or bound under, or null for an anonymous inline function.
 * Named: function declarations (an unnamed `export default function` is `default`), named function
 * expressions, methods, accessors, constructors, and arrows / function expressions that initialise a
 * variable, a class property or `export default`. Everything else — call arguments, JSX props,
 * object-literal values, returned closures — is an anonymous inline function.
 */
export function functionName(fn: ts.FunctionLikeDeclaration, file: ts.SourceFile): string | null {
  invariant(fn.body !== undefined, 'functionName classifies functions with bodies');
  const name = ownName(fn, file) ?? boundName(fn, file);
  invariant(name === null || name.length > 0, 'a function name is never empty');
  return name;
}

function ownName(fn: ts.FunctionLikeDeclaration, file: ts.SourceFile): string | null {
  invariant(fn.getSourceFile() === file, 'ownName reads a function inside the given file');
  invariant(fn.parent !== undefined, 'a parsed function has a parent');
  if (ts.isFunctionDeclaration(fn)) {
    return fn.name?.text ?? 'default';
  }
  if (ts.isFunctionExpression(fn)) {
    return fn.name?.text ?? null;
  }
  if (ts.isConstructorDeclaration(fn)) {
    return memberName(fn.parent, 'constructor');
  }
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    return memberName(fn.parent, fn.name.getText(file));
  }
  return null;
}

function boundName(fn: ts.FunctionLikeDeclaration, file: ts.SourceFile): string | null {
  const parent = fn.parent;
  invariant(parent !== undefined, 'a parsed function has a parent');
  invariant(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn), 'only expressions are bound to a name');
  if (ts.isVariableDeclaration(parent) && parent.initializer === fn) {
    return parent.name.getText(file);
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === fn) {
    return memberName(parent.parent, parent.name.getText(file));
  }
  if (ts.isExportAssignment(parent)) {
    return 'default';
  }
  return null;
}

/** `Owner.member` for class members, the bare member name for object-literal members. */
function memberName(owner: ts.Node, member: string): string {
  invariant(member.length > 0, 'a member has a name');
  const ownerName = (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) ? owner.name?.text : undefined;
  const name = ownerName === undefined ? member : `${ownerName}.${member}`;
  invariant(name.endsWith(member), 'the qualified name ends with the member name');
  return name;
}
