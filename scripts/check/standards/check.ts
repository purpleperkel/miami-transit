import { posix } from 'node:path';

import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';
import { collectNodes, isTestPath } from './ast';
import { findSilentCatches } from './catches';
import { checkFunctions } from './functions';
import { findMarkers } from './markers';
import { findRecursion } from './recursion';
import { findSkippedTests } from './skips';
import type { CheckOptions, ParsedSource, SourceInput, Violation } from './types';

/**
 * Runs every standards rule over a set of sources and returns the violations sorted by path,
 * line, column and rule. Sources are text, not files, so the tests check in-memory fixtures with
 * exactly the code path the repo scan uses.
 */
export function checkSources(inputs: readonly SourceInput[], options: CheckOptions): Violation[] {
  invariant(posix.isAbsolute(options.root), 'the root is an absolute POSIX path');
  invariant(new Set(inputs.map((input) => input.path)).size === inputs.length, 'each path is checked once');
  if (inputs.length === 0) {
    return [];
  }
  const sources = inputs.map((input) => parseSource(input, options.root));
  const violations = [
    ...sources.flatMap((source) => checkFunctions(source)),
    ...sources.flatMap((source) => findMarkers(source)),
    ...sources.flatMap((source) => findSkippedTests(source)),
    ...sources.flatMap((source) => findSilentCatches(source)),
    ...findRecursion(sources, options),
  ];
  return violations.sort(compareViolations);
}

function parseSource(input: SourceInput, root: string): ParsedSource {
  invariant(input.path.length > 0 && !posix.isAbsolute(input.path), 'source paths are repo-relative');
  invariant(!input.path.includes('\\'), 'source paths use POSIX separators');
  const file = ts.createSourceFile(posix.join(root, input.path), input.text, ts.ScriptTarget.Latest, true);
  return { path: input.path, file, nodes: collectNodes(file), isTest: isTestPath(input.path) };
}

function compareViolations(a: Violation, b: Violation): number {
  invariant(a.line >= 1 && b.line >= 1, 'violation lines are 1-based');
  invariant(a.column >= 1 && b.column >= 1, 'violation columns are 1-based');
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule);
}
