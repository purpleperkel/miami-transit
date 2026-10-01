import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import ts from 'typescript';

import { invariant } from '../../../src/lib/invariant';

/** Generated or native output at the repo root — never hand-written TypeScript. */
const SKIPPED_ROOT_DIRS: ReadonlySet<string> = new Set(['dist', 'ios', 'android', 'evidence', 'coverage', 'web-build']);
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/**
 * Every TypeScript source in the repo as sorted repo-relative POSIX paths. The directory walk uses
 * an explicit stack; it skips node_modules, dot-directories (.git, .cache, .expo, .claude worktrees)
 * and the generated root directories, and does not follow symlinks.
 */
export function listSourceFiles(root: string): string[] {
  invariant(posix.isAbsolute(root), 'the repo root is an absolute path');
  const found: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const dir = pending.pop();
    invariant(dir !== undefined, 'a non-empty stack always pops a directory');
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory() && !isSkippedDir(entry.name, dir === '')) {
        pending.push(path);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  }
  found.sort();
  invariant(found.every((path) => !path.startsWith('/')), 'listed paths are repo-relative');
  return found;
}

function isSkippedDir(name: string, atRoot: boolean): boolean {
  invariant(name.length > 0, 'a directory entry has a name');
  invariant(!name.includes('/'), 'a directory entry is a single path segment');
  return name.startsWith('.') || name === 'node_modules' || (atRoot && SKIPPED_ROOT_DIRS.has(name));
}

/** The `compilerOptions.paths` aliases of the root tsconfig.json (e.g. `@/*` → `./src/*`). */
export function readPathAliases(root: string): ts.MapLike<string[]> {
  invariant(posix.isAbsolute(root), 'the repo root is an absolute path');
  const configPath = join(root, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  invariant(error === undefined, `${configPath} must parse: ${String(error?.messageText ?? '')}`);
  const raw = (config as { compilerOptions?: { paths?: unknown } } | undefined)?.compilerOptions?.paths ?? {};
  invariant(typeof raw === 'object' && raw !== null, 'tsconfig paths is an object of alias → targets');
  return raw as ts.MapLike<string[]>;
}
