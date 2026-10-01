import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { bundleVerdict } from '../embedded-keys/report';
import { listFiles, scanBytes, scanDir } from '../embedded-keys/scan';
import { isSecretName, PUBLIC_PREFIX, resolveSecrets } from '../embedded-keys/secrets';
import { scanTree } from '../embedded-keys/tree';

/**
 * M4.10: the embedded-key guard — secret resolution, the byte scan, the report, `--tree` over a
 * throwaway git repo, and the CLI end to end. Every key here is a FAKE generated per run; every
 * public-prefixed name is assembled at runtime (this file is git-tracked, and `--tree` scans it).
 */

const REPO = process.cwd();
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const GUARD = join(REPO, 'scripts', 'check', 'embedded-keys.ts');
const FAKE = `testfake${randomBytes(16).toString('hex')}`;
const PUBLIC_KEY = `${PUBLIC_PREFIX}TEST_PLANT_KEY`;
const HERMES_HEAD = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0x00, 0x00]);
const WORK = mkdtempSync(join(tmpdir(), 'embedded-keys-test-'));
/** The environment minus every GIT_* variable, so an outer GIT_DIR / GIT_INDEX_FILE never points these git runs at the real repo. */
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
after(() => rmSync(WORK, { recursive: true, force: true }));

/** A Hermes-shaped bundle at the real export path under a fresh directory; returns the directory. */
function bundle(name: string, payload: string | Buffer): string {
  const dir = join(WORK, name);
  const file = join(dir, '_expo/static/js/ios/entry-test.hbc');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([HERMES_HEAD, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), Buffer.from([0, 0])]));
  assert.ok(dir.startsWith(WORK), 'plants stay in the throwaway directory');
  assert.equal(listFiles(dir).ok, true);
  return dir;
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = BASE_ENV): string {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  assert.equal(run.error, undefined);
  return run.stdout;
}

/** The guard CLI in `cwd` with `env` added; its exit code and everything it printed. */
function guard(cwd: string, args: readonly string[], env: Readonly<Record<string, string>>): { readonly code: number | null; readonly out: string } {
  const run = spawnSync(TSX, [GUARD, ...args], { cwd, env: { ...BASE_ENV, ...env }, encoding: 'utf8' });
  assert.equal(run.error, undefined, 'the guard runs');
  assert.ok(!/^\s+at /m.test(run.stdout + run.stderr), `no stack trace: ${run.stderr}`);
  return { code: run.status, out: run.stdout + run.stderr };
}

describe('embedded-keys: which values are secrets', () => {
  test('process.env wins over .env — even when empty; empty values are skipped', () => {
    const secrets = resolveSecrets({ TRANSITLAND_API_KEY: ' from-env ', SWIFTLY_API_KEY: '' }, { TRANSITLAND_API_KEY: 'from-dotenv', SWIFTLY_API_KEY: 'dotenv-only' });
    assert.deepEqual(secrets, [{ name: 'TRANSITLAND_API_KEY', value: 'from-env' }]);
    assert.deepEqual(resolveSecrets({}, { SWIFTLY_API_KEY: 'dotenv-only' }), [{ name: 'SWIFTLY_API_KEY', value: 'dotenv-only' }]);
  });

  test('SWIFTLY_AGENCY_KEY is not a secret; public-prefixed *KEY names from either source are', () => {
    const secrets = resolveSecrets({ SWIFTLY_AGENCY_KEY: 'miami', [PUBLIC_KEY]: 'pub-value' }, { [`${PUBLIC_PREFIX}OTHER_KEY_ID`]: 'pub2' });
    assert.deepEqual(secrets.map((s) => s.name), [`${PUBLIC_PREFIX}OTHER_KEY_ID`, PUBLIC_KEY]);
    assert.equal(isSecretName('SWIFTLY_AGENCY_KEY'), false);
    assert.equal(isSecretName(`${PUBLIC_PREFIX}USE_RN_FETCH`), false, 'a public name without KEY is not a key');
  });
});

describe('embedded-keys: the byte scan', () => {
  const secrets = [{ name: 'TRANSITLAND_API_KEY', value: FAKE }];

  test('finds a value in bytecode as one-byte text and as UTF-16, and a public key name — and nothing in a clean bundle', () => {
    const plain = Buffer.concat([HERMES_HEAD, Buffer.from(`k="${FAKE}"`)]);
    const wide = Buffer.concat([HERMES_HEAD, Buffer.from(`κ="${FAKE}"`, 'utf16le')]);
    const named = Buffer.concat([HERMES_HEAD, Buffer.from(`process.env.${PUBLIC_KEY};`)]);
    assert.deepEqual(scanBytes(plain, 'a.hbc', secrets), [{ name: 'TRANSITLAND_API_KEY', file: 'a.hbc', how: 'value' }]);
    assert.deepEqual(scanBytes(wide, 'b.hbc', secrets), [{ name: 'TRANSITLAND_API_KEY', file: 'b.hbc', how: 'value' }]);
    assert.deepEqual(scanBytes(named, 'c.hbc', secrets), [{ name: PUBLIC_KEY, file: 'c.hbc', how: 'public-name' }]);
    assert.deepEqual(scanBytes(Buffer.concat([HERMES_HEAD, Buffer.from('agency="miami"')]), 'd.hbc', secrets), []);
  });

  test('every file is scanned, at any depth, whatever its extension; a missing dir, a file, or a link is an Err', () => {
    const dir = bundle('walk', 'clean');
    writeFileSync(join(dir, 'assets-blob'), Buffer.from([0xff, 0x00, ...Buffer.from(FAKE)]));
    const scanned = scanDir(dir, secrets);
    assert.deepEqual(scanned.ok && scanned.value, { files: 2, leaks: [{ name: 'TRANSITLAND_API_KEY', file: 'assets-blob', how: 'value' }] });
    symlinkSync(join(dir, 'assets-blob'), join(dir, 'link'));
    const linked = listFiles(dir);
    assert.ok(!linked.ok && /link is neither a file nor a directory/.test(linked.error), 'a link is refused, never followed or skipped');
    assert.equal(listFiles(join(WORK, 'absent')).ok, false);
    assert.equal(listFiles(join(dir, 'assets-blob')).ok, false);
  });

  test('the report names the variable and the file, never the value; an empty bundle is "no bundle files"', () => {
    const dir = bundle('report', `k="${FAKE}"`);
    const verdict = bundleVerdict(dir, scanDir(dir, secrets), secrets);
    assert.equal(verdict.failed, true);
    assert.ok(verdict.lines.some((line) => line.includes('LEAK TRANSITLAND_API_KEY') && line.includes('entry-test.hbc')));
    assert.ok(verdict.lines.every((line) => !line.includes(FAKE)));
    mkdirSync(join(WORK, 'empty'));
    assert.match(bundleVerdict('x', scanDir(join(WORK, 'empty'), secrets), secrets).lines.join('\n'), /no bundle files in x \(it is empty\)/);
  });
});

describe('embedded-keys: --tree reads the git index', () => {
  const repo = join(WORK, 'repo');
  mkdirSync(join(repo, 'scripts', 'check'), { recursive: true });
  git(repo, ['init', '--quiet']);
  writeFileSync(join(repo, 'package.json'), '{}\n');
  writeFileSync(join(repo, 'clean.ts'), 'export const agency = "miami";\n');
  git(repo, ['add', 'package.json', 'clean.ts']);
  const secrets = [{ name: 'TRANSITLAND_API_KEY', value: FAKE }];

  test('a tracked file with a key is a leak; an untracked one is not the tree\'s business', () => {
    writeFileSync(join(repo, 'untracked.ts'), `export const k = "${FAKE}";\n`);
    const before = scanTree(repo, secrets);
    assert.deepEqual(before.ok && before.value, { files: 2, leaks: [] });
    writeFileSync(join(repo, 'staged.ts'), `export const k = "${FAKE}";\n`);
    git(repo, ['add', 'staged.ts']);
    const after = scanTree(repo, secrets);
    assert.deepEqual(after.ok && after.value.leaks, [{ name: 'TRANSITLAND_API_KEY', file: 'staged.ts', how: 'value' }]);
    rmSync(join(repo, 'untracked.ts'));
  });

  test('a tracked file deleted from disk is read from the index (it is still in the next commit)', () => {
    writeFileSync(join(repo, 'deleted.ts'), `export const k = "${FAKE}";\n`);
    git(repo, ['add', 'deleted.ts']);
    unlinkSync(join(repo, 'deleted.ts'));
    const scanned = scanTree(repo, secrets);
    assert.equal(scanned.ok, true);
    assert.ok(scanned.ok && scanned.value.leaks.some((leak) => leak.file === 'deleted.ts'), 'the index copy of deleted.ts is scanned');
    git(repo, ['rm', '--cached', '--quiet', 'deleted.ts', 'staged.ts']);
  });

  test('the CLI honours GIT_INDEX_FILE: a plant staged only in a throwaway index is caught, named, never printed', () => {
    const index = join(WORK, 'throwaway-index');
    copyFileSync(join(repo, '.git', 'index'), index);
    writeFileSync(join(repo, 'captured.ts'), `export const k = "${FAKE}";\n`);
    git(repo, ['add', 'captured.ts'], { ...BASE_ENV, GIT_INDEX_FILE: index });
    const dir = bundle('tree-clean-bundle', 'agency="miami"');
    const caught = guard(repo, ['--tree', '--dir', dir], { TRANSITLAND_API_KEY: FAKE, SWIFTLY_API_KEY: '', GIT_INDEX_FILE: index });
    const realIndex = guard(repo, ['--tree', '--dir', dir], { TRANSITLAND_API_KEY: FAKE, SWIFTLY_API_KEY: '' });
    assert.equal(caught.code, 1, caught.out);
    assert.match(caught.out, /LEAK TRANSITLAND_API_KEY — its value is in captured\.ts/);
    assert.ok(!caught.out.includes(FAKE), 'the value is never printed');
    assert.equal(realIndex.code, 0, `the real index does not track captured.ts: ${realIndex.out}`);
  });
});

describe('embedded-keys: the CLI', () => {
  test('exit 1 naming the variable on a planted key, exit 0 with "scanned <N> files in <dir>" on a clean bundle, never the value', () => {
    const leak = guard(REPO, ['--dir', bundle('cli-leak', `k="${FAKE}"`)], { TRANSITLAND_API_KEY: FAKE, SWIFTLY_API_KEY: '' });
    const cleanDir = bundle('cli-clean', 'agency="miami";hdr="apikey";');
    const clean = guard(REPO, ['--dir', cleanDir], { TRANSITLAND_API_KEY: FAKE, SWIFTLY_API_KEY: '', SWIFTLY_AGENCY_KEY: 'miami' });
    assert.equal(leak.code, 1, leak.out);
    assert.match(leak.out, /LEAK TRANSITLAND_API_KEY/);
    assert.ok(!leak.out.includes(FAKE));
    assert.equal(clean.code, 0, clean.out);
    assert.ok(clean.out.includes(`scanned 1 file in ${cleanDir}`), clean.out);
  });

  test('a missing bundle dir fails with "no bundle files" (no stack trace); --self-test passes; a bad flag is exit 2', () => {
    const missing = guard(REPO, ['--dir', join(WORK, 'no-such-export')], { TRANSITLAND_API_KEY: FAKE });
    const self = guard(REPO, ['--self-test'], {});
    const bad = guard(REPO, ['--frobnicate'], {});
    assert.equal(missing.code, 1);
    assert.match(missing.out, /no bundle files in .*no-such-export \(it does not exist\)/);
    assert.equal(self.code, 0, self.out);
    assert.match(self.out, /self-test pass/);
    assert.equal(bad.code, 2);
  });
});
