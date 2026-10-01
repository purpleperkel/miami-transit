import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { invariant } from '../../../src/lib/invariant';
import { err, ok, type Result } from '../../../src/lib/result';
import { bundleVerdict, type Verdict } from './report';
import { scanDir } from './scan';
import { PUBLIC_PREFIX, type Secret } from './secrets';

/**
 * `--self-test` (plan M4.10): proves the guard's detection end to end — scan AND report — on a key it
 * generates itself (random, in-process; no real key is read), planted in throwaway Hermes-shaped
 * bundles under the OS temp directory, which is removed afterwards.
 */

/** The first bytes of a Hermes bytecode file, then NULs — what a "skip binary files" scanner would skip. */
const HERMES_HEAD = Uint8Array.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0x00, 0x00]);
const BUNDLE_PATH = '_expo/static/js/ios/entry-selftest.hbc';

type Check = {
  readonly name: string;
  /** The planted bundle file's payload, or null for a bundle directory with no files. */
  readonly payload: Uint8Array | null;
  /** True when the guard's verdict is right for this plant. */
  readonly holds: (verdict: Verdict) => boolean;
};

/** Runs every check; the number that passed, or the first that failed. */
export function runSelfTest(): Result<number, string> {
  const fake = `selftest${randomBytes(16).toString('hex')}`;
  const secrets: Secret[] = [{ name: 'SELF_TEST_API_KEY', value: fake }];
  const checks = selfTestChecks(fake);
  const root = mkdtempSync(join(tmpdir(), 'embedded-keys-self-test-'));
  try {
    for (const check of checks) {
      const dir = join(root, check.name.replace(/\W+/g, '-'));
      plant(dir, check.payload);
      const verdict = bundleVerdict(dir, scanDir(dir, secrets), secrets);
      if (!check.holds(verdict) || verdict.lines.some((line) => line.includes(fake))) {
        return err(`check "${check.name}" did not hold: ${verdict.lines.join(' | ')}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  invariant(checks.length >= 5, 'the self-test covers every kind of plant');
  invariant(fake.length > 32, 'the fake key is key-shaped');
  return ok(checks.length);
}

function selfTestChecks(fake: string): Check[] {
  const publicName = `${PUBLIC_PREFIX}SELF_TEST_KEY`;
  const checks: Check[] = [
    { name: 'utf8 key value in bytecode', payload: hermes(Buffer.from(`k="${fake}";`, 'utf8')), holds: leakOf('SELF_TEST_API_KEY') },
    { name: 'utf16 key value in bytecode', payload: hermes(Buffer.from(`κ="${fake}"`, 'utf16le')), holds: leakOf('SELF_TEST_API_KEY') },
    { name: 'public key name in bytecode', payload: hermes(Buffer.from(`k=process.env.${publicName};`, 'utf8')), holds: leakOf(publicName) },
    { name: 'clean bundle', payload: hermes(Buffer.from('agency="miami";hdr="apikey";', 'utf8')), holds: (v) => !v.failed && v.lines.some((l) => /scanned 1 file in /.test(l)) },
    { name: 'empty bundle dir', payload: null, holds: (v) => v.failed && v.lines.some((line) => line.includes('no bundle files')) },
  ];
  invariant(checks.every((check) => check.name.length > 0), 'every check is named');
  invariant(!publicName.includes(fake), 'the public name carries no value');
  return checks;
}

/** A check that holds when the verdict fails and names `name` as a LEAK. */
function leakOf(name: string): (verdict: Verdict) => boolean {
  invariant(name.length > 0, 'a leak is named by its variable');
  invariant(!/\s/.test(name), 'a variable name has no whitespace');
  return (verdict) => verdict.failed && verdict.lines.some((line) => line.includes(`LEAK ${name}`));
}

function hermes(payload: Uint8Array): Uint8Array {
  invariant(payload.byteLength > 0, 'a plant has content');
  const bytes = Buffer.concat([HERMES_HEAD, payload, Uint8Array.from([0x00, 0x00])]);
  invariant(bytes.includes(0x00), 'the plant is binary (has NUL bytes)');
  return bytes;
}

/** A bundle directory: the payload at the real export's bytecode path, or no file at all. */
function plant(dir: string, payload: Uint8Array | null): void {
  mkdirSync(dir, { recursive: true });
  if (payload !== null) {
    mkdirSync(join(dir, dirname(BUNDLE_PATH)), { recursive: true });
    writeFileSync(join(dir, BUNDLE_PATH), payload);
  }
  invariant(dir.length > 0, 'a plant has a directory');
  invariant(payload === null || payload.byteLength > 0, 'a planted file has content');
}
