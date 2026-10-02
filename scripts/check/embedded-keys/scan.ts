import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { invariant } from '../../../src/lib/invariant';
import { err, ok, type Result } from '../../../src/lib/result';
import { PUBLIC_KEY_TOKEN, PUBLIC_NAME_MAX, PUBLIC_PREFIX, type Secret } from './secrets';

/**
 * The byte scan (plan M4.10). The exported bundle is Hermes BYTECODE
 * (_expo/static/js/ios/entry-*.hbc), not JavaScript, so EVERY file under the bundle directory is
 * read as raw bytes — no extension filter, no "skip binary files". Hermes stores an all-ASCII string
 * as plain bytes and any other string as UTF-16, so each secret value is searched for in both
 * encodings, and public key names in a one-byte and both UTF-16 alignments of the text.
 *
 * Hermes also packs its string table without separators, so a public-prefixed string runs straight
 * into its neighbours: the 2026-10-02 export glued Expo's own `<prefix>USE_RN_FETCH` to ~300 characters
 * of following uppercase strings, one of which contained KEY. A public key NAME therefore counts only
 * as a standalone, env-var-sized token (secrets.ts PUBLIC_KEY_TOKEN); the cost is that a key name
 * glued between identifier characters is not reported as a name. The VALUE scan has no such rule: a
 * secret value is a leak wherever its bytes are, and a defined public variable is inlined as its value.
 */

/** One leak: which variable, where, and how it showed up. */
export type Leak = { readonly name: string; readonly file: string; readonly how: 'value' | 'public-name' };

/** Every leak in one file's bytes. */
export function scanBytes(bytes: Uint8Array, file: string, secrets: readonly Secret[]): Leak[] {
  invariant(file.length > 0, 'a scanned file has a name');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leaks: Leak[] = secrets
    .filter((secret) => buffer.includes(Buffer.from(secret.value, 'utf8')) || buffer.includes(Buffer.from(secret.value, 'utf16le')))
    .map((secret) => ({ name: secret.name, file, how: 'value' as const }));
  for (const name of publicKeyNames(buffer)) {
    leaks.push({ name, file, how: 'public-name' });
  }
  invariant(leaks.every((leak) => leak.file === file), 'every leak is in the scanned file');
  return leaks;
}

/** The public key names in `buffer`, read as one-byte text and as UTF-16 at both alignments; sorted, once each. */
function publicKeyNames(buffer: Buffer): string[] {
  invariant(Buffer.isBuffer(buffer), 'names are read from bytes');
  const views = [buffer.toString('latin1'), buffer.toString('utf16le'), buffer.subarray(1).toString('utf16le')];
  const names = new Set(views.flatMap((text) => text.match(PUBLIC_KEY_TOKEN) ?? []));
  const maxLength = PUBLIC_PREFIX.length + PUBLIC_NAME_MAX;
  invariant([...names].every((name) => name.includes('KEY') && name.length <= maxLength), 'every reported public name is an env-var-sized KEY name');
  return [...names].sort();
}

/**
 * Every file under `dir`, as paths relative to it (sorted), walked with an explicit stack. A missing
 * path, a non-directory, or anything that is neither a file nor a directory (a link, a socket) is an
 * Err: the guard never follows a link and never silently skips an entry.
 */
export function listFiles(dir: string): Result<string[], string> {
  invariant(dir.length > 0, 'a directory is named');
  const top = lstatSync(dir, { throwIfNoEntry: false });
  if (top === undefined || !top.isDirectory()) {
    return err(top === undefined ? 'it does not exist' : 'it is not a directory');
  }
  const files: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const relative = pending.pop() ?? '';
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        return err(`${path} is neither a file nor a directory (the guard does not follow links)`);
      }
    }
  }
  invariant(files.every((path) => !path.startsWith('/')), 'listed paths are relative');
  return ok(files.sort());
}

/** Scans every file under `dir`: how many files, and every leak (file paths relative to `dir`). */
export function scanDir(dir: string, secrets: readonly Secret[]): Result<{ readonly files: number; readonly leaks: Leak[] }, string> {
  const listed = listFiles(dir);
  if (!listed.ok) {
    return listed;
  }
  const leaks = listed.value.flatMap((file) => scanBytes(readFileSync(join(dir, file)), file, secrets));
  invariant(leaks.every((leak) => listed.value.includes(leak.file)), 'leaks are in scanned files');
  invariant(listed.value.length >= 0, 'a count of files');
  return ok({ files: listed.value.length, leaks });
}
