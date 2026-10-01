import { invariant } from '../../../src/lib/invariant';
import type { Result } from '../../../src/lib/result';
import type { Leak } from './scan';
import { PUBLIC_PREFIX, redact, type Secret } from './secrets';

/**
 * What the guard prints, and whether it fails (plan M4.10). A leak names its VARIABLE and its file —
 * never a value — and every line passes through redact() before it is returned, so even a file
 * path that happened to hold a key could not print one.
 *   - bundle: "scanned <N> files in <dir>" on success; "no bundle files in <dir>" (and a failure)
 *     when the directory is missing or empty — a guard that scanned nothing must not pass.
 *   - --tree: "scanned <N> tracked files (git ls-files)".
 */

export type ScanResult = Result<{ readonly files: number; readonly leaks: readonly Leak[] }, string>;
export type Verdict = { readonly lines: readonly string[]; readonly failed: boolean };

/** The verdict on the exported bundle in `dir`. */
export function bundleVerdict(dir: string, scan: ScanResult, secrets: readonly Secret[]): Verdict {
  invariant(dir.length > 0, 'the bundle directory is named');
  if (!scan.ok || scan.value.files === 0) {
    const why = scan.ok ? 'it is empty' : scan.error;
    const line = `embedded-keys: no bundle files in ${dir} (${why}) — export first: npx expo export --platform ios --output-dir ${dir}`;
    return { failed: true, lines: [redact(line, secrets)] };
  }
  const verdict = summarize(`${count(scan.value.files, 'file')} in ${dir}`, scan.value.leaks, secrets);
  invariant(verdict.failed === scan.value.leaks.length > 0, 'the bundle fails exactly when it leaks');
  return verdict;
}

/** The verdict on every git-tracked file (`--tree`). */
export function treeVerdict(scan: ScanResult, secrets: readonly Secret[]): Verdict {
  if (!scan.ok) {
    return { failed: true, lines: [redact(`embedded-keys: --tree could not read the tracked files: ${scan.error}`, secrets)] };
  }
  const verdict = summarize(`${count(scan.value.files, 'tracked file')} (git ls-files)`, scan.value.leaks, secrets);
  invariant(verdict.failed === scan.value.leaks.length > 0, 'the tree fails exactly when it leaks');
  invariant(verdict.lines.length === scan.value.leaks.length + 1, 'one line per leak, then the summary');
  return verdict;
}

function summarize(what: string, leaks: readonly Leak[], secrets: readonly Secret[]): Verdict {
  invariant(what.length > 0, 'a summary says what was scanned');
  const checked = `${count(secrets.length, 'key value')} and ${PUBLIC_PREFIX}*KEY names checked`;
  const summary =
    leaks.length === 0
      ? `embedded-keys: scanned ${what}: clean (${checked})`
      : `embedded-keys: scanned ${what}: ${count(leaks.length, 'LEAK')} (${checked}; values are never printed)`;
  const lines = [...leaks.map(describeLeak), summary].map((line) => redact(line, secrets));
  invariant(lines.every((line) => secrets.every((secret) => !line.includes(secret.value))), 'no line holds a key value');
  return { failed: leaks.length > 0, lines };
}

function describeLeak(leak: Leak): string {
  invariant(leak.name.length > 0 && leak.file.length > 0, 'a leak names its variable and its file');
  const line =
    leak.how === 'value'
      ? `embedded-keys: LEAK ${leak.name} — its value is in ${leak.file}`
      : `embedded-keys: LEAK ${leak.name} — a public env name (Expo inlines these into the bundle) is in ${leak.file}`;
  invariant(line.includes(leak.name), 'the line names the variable');
  return line;
}

/** "1 file", "3 files". */
function count(n: number, noun: string): string {
  invariant(Number.isSafeInteger(n) && n >= 0, 'a count is a whole number');
  invariant(noun.length > 0, 'a count has a noun');
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
