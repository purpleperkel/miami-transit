import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { violationAt } from './ast';
import type { ParsedSource, Violation } from './types';

/**
 * Work-left markers are read from COMMENTS only — real comment trivia found at token boundaries —
 * so the same word inside a string literal (a test fixture, an error message) is not a marker.
 */
const MARKER = /\b(TODO|FIXME)\b/;
/** JSX text is content, not trivia: scanning it for comments would misread `// ...` prose. */
const JSX_TEXT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces]);

export function findMarkers(source: ParsedSource): Violation[] {
  invariant(source.nodes[0] === source.file, 'the node list starts at the source file');
  const violations: Violation[] = [];
  for (const comment of collectComments(source.file)) {
    const text = source.file.text.slice(comment.pos, comment.end);
    const match = MARKER.exec(text);
    if (match !== null) {
      const message = `${match[0]} marker in a comment — finish the work or track it outside the code`;
      violations.push(violationAt(source, comment.pos + match.index, 'marker', message));
    }
  }
  invariant(violations.every((v) => v.rule === 'marker'), 'findMarkers only reports markers');
  return violations;
}

/**
 * Every comment in the file, in source order. Comments are trivia attached to the token after
 * them, so the walk visits every token (explicit stack over getChildren) and reads the leading and
 * same-line trailing comment ranges at the token's full start. JSDoc nodes are not descended
 * into (their text is a comment already read at the next token), and JSX text is not trivia.
 */
export function collectComments(file: ts.SourceFile): ts.CommentRange[] {
  invariant(file.statements !== undefined, 'collectComments needs a parsed source file');
  const byStart = new Map<number, ts.CommentRange>();
  const stack: ts.Node[] = [file];
  while (stack.length > 0) {
    const node = stack.pop();
    invariant(node !== undefined, 'a non-empty stack always pops a node');
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      continue;
    }
    const children = node.getChildren(file);
    if (children.length === 0 && !JSX_TEXT_KINDS.has(node.kind)) {
      addCommentRanges(file.text, node.pos, byStart);
    }
    for (const child of children) {
      stack.push(child);
    }
  }
  const comments = [...byStart.values()].sort((a, b) => a.pos - b.pos);
  invariant(comments.every((c) => c.end <= file.text.length), 'comment ranges stay inside the file');
  return comments;
}

function addCommentRanges(text: string, pos: number, byStart: Map<number, ts.CommentRange>): void {
  invariant(pos >= 0 && pos <= text.length, 'comment scanning starts inside the text');
  const before = byStart.size;
  for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) {
    byStart.set(range.pos, range);
  }
  for (const range of ts.getTrailingCommentRanges(text, pos) ?? []) {
    byStart.set(range.pos, range);
  }
  invariant(byStart.size >= before, 'comment collection only grows');
}
