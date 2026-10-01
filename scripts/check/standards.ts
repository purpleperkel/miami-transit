import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { invariant } from '../../src/lib/invariant';
import { checkSources } from './standards/check';
import { listSourceFiles, readPathAliases } from './standards/repo';
import type { Violation } from './standards/types';

/**
 * Jamie's standards checker (plan §4), run from the repo root by `npm run standards`:
 *   fn-length     functions over 60 lines
 *   assertions    named functions (and inline callbacks over 5 lines) with < 2 invariant() calls
 *   marker        work-left markers in comments
 *   skipped-test  it.skip / xit / .only / { skip } in tests
 *   recursion     call-graph cycles, across files
 *   silent-catch  catch blocks / .catch() handlers that neither rethrow nor return err(...)
 * Prints `path:line:column  rule  message` per violation; exits 0 only when the repo is clean.
 */
function main(): number {
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, 'src')), 'run the checker from the repo root');
  const files = listSourceFiles(root);
  invariant(files.length > 0, 'the repo has TypeScript sources to check');
  const inputs = files.map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
  const violations = checkSources(inputs, { root, paths: readPathAliases(root) });
  for (const violation of violations) {
    console.log(formatViolation(violation));
  }
  const dirtyFiles = new Set(violations.map((v) => v.path)).size;
  console.log(
    violations.length === 0
      ? `standards: clean (${files.length} files checked)`
      : `standards: ${violations.length} violation(s) in ${dirtyFiles} file(s) (${files.length} files checked)`,
  );
  return violations.length === 0 ? 0 : 1;
}

function formatViolation(violation: Violation): string {
  invariant(violation.path.length > 0, 'a violation names its file');
  invariant(violation.message.length > 0, 'a violation explains itself');
  return `${violation.path}:${violation.line}:${violation.column}  ${violation.rule}  ${violation.message}`;
}

process.exitCode = main();
