import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { bundleVerdict, treeVerdict, type Verdict } from './embedded-keys/report';
import { scanDir } from './embedded-keys/scan';
import { readDotEnv, resolveSecrets } from './embedded-keys/secrets';
import { runSelfTest } from './embedded-keys/self-test';
import { scanTree } from './embedded-keys/tree';

/**
 * The embedded-key guard (plan M4.10), run from the repo root by `npm run publish` between the export
 * and `eas update`, and by hand:
 *
 *   npx tsx scripts/check/embedded-keys.ts [--dir <bundle dir, default .cache/export>] [--tree] [--self-test]
 *
 * It fails (exit 1) when a realtime key VALUE (TRANSITLAND_API_KEY, SWIFTLY_API_KEY, any
 * public-prefixed *KEY — from process.env over .env) or a public-prefixed *KEY NAME appears in any
 * byte of any file of the exported bundle; with --tree, also in any git-tracked file. A bundle
 * directory that is missing or empty fails too: scanning nothing proves nothing. It names each leak
 * by variable and file and never prints a value. --self-test proves detection on a generated fake
 * key. Exit 2 = bad arguments.
 */

const DEFAULT_DIR = '.cache/export';
const USAGE = 'usage: npx tsx scripts/check/embedded-keys.ts [--dir <bundle dir, default .cache/export>] [--tree] [--self-test]';

type Options = { readonly dir: string; readonly tree: boolean; readonly selfTest: boolean };

function readOptions(argv: readonly string[]): Result<Options, string> {
  invariant(argv.every((arg) => typeof arg === 'string'), 'arguments are text');
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { dir: { type: 'string' }, tree: { type: 'boolean' }, 'self-test': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    });
    const options = { dir: values.dir ?? DEFAULT_DIR, tree: values.tree === true, selfTest: values['self-test'] === true };
    invariant(options.dir.length > 0, 'the bundle directory is named');
    return ok(options);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

function selfTest(): number {
  const result = runSelfTest();
  console.log(
    result.ok
      ? `embedded-keys: self-test pass (${result.value} checks on a fake key generated in-process; no real key was read)`
      : `embedded-keys: self-test FAILED — ${result.error}`,
  );
  invariant(result.ok || result.error.length > 0, 'a failed self-test says which check');
  invariant(!result.ok || result.value > 0, 'a passing self-test ran checks');
  return result.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const options = readOptions(argv);
  if (!options.ok) {
    console.log(`embedded-keys: ${options.error}\n${USAGE}`);
    return 2;
  }
  if (options.value.selfTest) {
    return selfTest();
  }
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, 'scripts', 'check')), 'run the guard from the repo root');
  const secrets = resolveSecrets(process.env, readDotEnv(root));
  const verdicts: Verdict[] = [bundleVerdict(options.value.dir, scanDir(options.value.dir, secrets), secrets)];
  if (options.value.tree) {
    verdicts.push(treeVerdict(scanTree(root, secrets), secrets));
  }
  for (const line of verdicts.flatMap((verdict) => verdict.lines)) {
    console.log(line);
  }
  const failed = verdicts.some((verdict) => verdict.failed);
  invariant(verdicts.length === (options.value.tree ? 2 : 1), 'the bundle is always judged, the tree only with --tree');
  console.log(failed ? 'embedded-keys: FAILED — do not publish (see above)' : 'embedded-keys: OK');
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
