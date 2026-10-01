import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { invariant } from '../../src/lib/invariant';

/**
 * Write a file so that a reader never sees it half-written: the bytes go to `<path>.tmp` beside it
 * (same directory, so the same filesystem) and are then renamed into place — rename(2) replaces the
 * old file in one step. A leftover temp file from a crashed run is simply overwritten.
 */
export function writeFileAtomically(path: string, data: string | Uint8Array): void {
  invariant(isAbsolute(path), `an atomic write targets an absolute path, got "${path}"`);
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempPathOf(path);
  writeFileSync(temp, data);
  renameSync(temp, path);
  invariant(!existsSync(temp) && existsSync(path), `${path} was renamed into place`);
}

/** The temp file an atomic write of `path` goes through. */
export function tempPathOf(path: string): string {
  invariant(path.length > 0, 'a temp path is derived from a real path');
  const temp = `${path}.tmp`;
  invariant(dirname(temp) === dirname(path), 'the temp file sits beside its target');
  return temp;
}

/** Remove a temp file (and a SQLite rollback journal beside it) left by an interrupted run. */
export function removeTemp(path: string): void {
  invariant(path.endsWith('.tmp'), `only temp files are removed this way, not "${path}"`);
  rmSync(path, { force: true });
  rmSync(`${path}-journal`, { force: true });
  invariant(!existsSync(path), `${path} is gone`);
}
