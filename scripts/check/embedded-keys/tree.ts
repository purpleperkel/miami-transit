import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { invariant } from '../../../src/lib/invariant';
import { err, ok, type Result } from '../../../src/lib/result';
import { type Leak, scanBytes } from './scan';
import type { Secret } from './secrets';

/**
 * `--tree` (plan M4.10): scan every file git TRACKS — what a commit or a push would carry. The list
 * comes from `git ls-files`, which reads the INDEX (so it honours GIT_INDEX_FILE and sees a staged
 * file before it is committed), never HEAD. Each tracked path is read from the working tree; a
 * tracked file deleted from disk is read from the index instead (it is still in the next commit),
 * and a tracked symlink is scanned as the link text git stores.
 */

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

/** Every path in the git index, relative to `root`. */
export function trackedFiles(root: string): Result<string[], string> {
  invariant(root.length > 0, 'the repo root is named');
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: MAX_GIT_OUTPUT });
  if (run.error !== undefined || run.status !== 0) {
    return err(`git ls-files failed: ${run.error?.message ?? run.stderr.toString('utf8').trim()}`);
  }
  const files = run.stdout.toString('utf8').split('\0').filter((path) => path.length > 0);
  invariant(files.every((path) => !path.startsWith('/')), 'git lists repo-relative paths');
  return ok(files);
}

/** A tracked path's bytes: the working-tree file, the link text, or — when deleted from disk — the index copy. */
export function readTracked(root: string, path: string): Result<Uint8Array, string> {
  invariant(!path.startsWith('/'), 'a tracked path is repo-relative');
  const full = join(root, path);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat === undefined) {
    const blob = spawnSync('git', ['cat-file', 'blob', `:${path}`], { cwd: root, maxBuffer: MAX_GIT_OUTPUT });
    return blob.error === undefined && blob.status === 0 ? ok(blob.stdout) : err(`${path} is tracked but neither on disk nor readable from the index`);
  }
  if (stat.isSymbolicLink()) {
    return ok(Buffer.from(readlinkSync(full), 'utf8'));
  }
  invariant(stat.isFile() || stat.isDirectory(), `${path} is a file, a link, or a submodule directory`);
  return stat.isFile() ? ok(readFileSync(full)) : err(`${path} is a tracked directory (a submodule), which the guard cannot scan`);
}

/** Scans every tracked file: how many, and every leak (paths relative to the repo root). */
export function scanTree(root: string, secrets: readonly Secret[]): Result<{ readonly files: number; readonly leaks: Leak[] }, string> {
  const tracked = trackedFiles(root);
  if (!tracked.ok) {
    return tracked;
  }
  const leaks: Leak[] = [];
  for (const path of tracked.value) {
    const bytes = readTracked(root, path);
    if (!bytes.ok) {
      return bytes;
    }
    leaks.push(...scanBytes(bytes.value, path, secrets));
  }
  invariant(leaks.every((leak) => tracked.value.includes(leak.file)), 'leaks are in tracked files');
  invariant(tracked.value.length >= 0, 'a count of tracked files');
  return ok({ files: tracked.value.length, leaks });
}
