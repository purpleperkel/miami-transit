import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkSources } from '../standards/check';
import type { RuleId, Violation } from '../standards/types';

// Fixtures are source TEXT checked in memory through the same code path as the repo scan.
// Rule words inside these strings are string literals, which the checker never reads as code.
const ROOT = '/virtual-repo';
const ALIASES = { '@/*': ['./src/*'] };
const IMPORT = "import { invariant } from '../lib/invariant';";
const ASSERT_N = ["  invariant(Number.isInteger(n), 'n is whole');", "  invariant(n >= 0, 'n is a count');"];

function check(files: Record<string, string>): Violation[] {
  const inputs = Object.entries(files).map(([path, text]) => ({ path, text }));
  assert.ok(inputs.length > 0, 'a check needs at least one fixture file');
  const violations = checkSources(inputs, { root: ROOT, paths: ALIASES });
  assert.ok(violations.every((v) => v.path in files), 'violations point at fixture files');
  return violations;
}

function rulesOf(violations: readonly Violation[]): RuleId[] {
  const rules = violations.map((v) => v.rule);
  assert.equal(rules.length, violations.length);
  assert.ok(rules.every((rule) => rule.length > 0), 'every violation carries a rule id');
  return rules;
}

/** A module whose one function is exactly `lines` long (signature and closing brace included). */
function functionOfLines(lines: number): string {
  assert.ok(lines >= 5, 'the fixture needs room for two invariants and a return');
  const filler = Array.from({ length: lines - 5 }, (_, i) => `  const step${i} = n + ${i};`);
  const body = ['export function long(n: number): number {', ...ASSERT_N, ...filler, '  return n;', '}'];
  assert.equal(body.length, lines);
  return [IMPORT, ...body].join('\n');
}

test('fn-length: flags a 61-line function', () => {
  const violations = check({ 'src/domain/long.ts': functionOfLines(61) });
  assert.deepEqual(rulesOf(violations), ['fn-length']);
  assert.match(violations[0]?.message ?? '', /`long` is 61 lines/);
});

test('fn-length: allows a function of exactly 60 lines', () => {
  assert.equal(functionOfLines(60).split('\n').length, 61, 'the import line plus 60 function lines');
  assert.deepEqual(check({ 'src/domain/long.ts': functionOfLines(60) }), []);
});

test('assertions: flags a named function with only one invariant()', () => {
  const half = [IMPORT, 'export function half(n: number): number {', "  invariant(n % 2 === 0, 'n is even');", '  return n / 2;', '}'];
  const violations = check({ 'src/domain/half.ts': half.join('\n') });
  assert.deepEqual(rulesOf(violations), ['assertions']);
  assert.match(violations[0]?.message ?? '', /`half` has 1 assertion call/);
});

test('assertions: exempts inline callbacks of 5 lines or fewer, not longer ones', () => {
  const source = [
    IMPORT,
    'export function total(n: number): number {',
    ...ASSERT_N,
    '  const short = [n].map((x) => x * 2);',
    '  [n].forEach((x) => {',
    '    const doubled = x * 2;',
    '    const tripled = x * 3;',
    '    const sum = doubled + tripled;',
    '    console.log(sum);',
    '  });',
    '  return short.length;',
    '}',
  ];
  const violations = check({ 'src/domain/total.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['assertions']);
  assert.match(violations[0]?.message ?? '', /`anonymous function` has 0 assertion call/);
});

test('assertions: counts expect() and assert() only inside test files', () => {
  const spec = [
    "describe('half', () => {",
    "  it('halves an even count', () => {",
    '    const n = 4;',
    '    const half = n / 2;',
    '    expect(half).toBe(2);',
    '    assert.equal(half * 2, n);',
    '  });',
    '});',
  ].join('\n');
  assert.deepEqual(check({ 'src/domain/__tests__/half.test.ts': spec }), []);
  assert.deepEqual(rulesOf(check({ 'src/domain/half-spec-helper.ts': spec })), ['assertions', 'assertions']);
});

test('marker: flags a TODO left in a comment', () => {
  const source = [IMPORT, '// TODO: handle the Mover loop', 'export const LOOP = 1;'];
  const violations = check({ 'src/domain/loop.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['marker']);
  assert.equal(violations[0]?.line, 2);
});

test('marker: reads comments only, never string literals', () => {
  const source = ["export const NOTE = 'TODO is only a word in this string';", '/* FIXME: a block comment counts */'];
  const violations = check({ 'src/domain/note.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['marker']);
  assert.match(violations[0]?.message ?? '', /FIXME/);
});

test('skipped-test: flags it.skip in a test file', () => {
  const spec = ["it.skip('arrives on time', () => {", '  expect(1).toBe(1);', '});'];
  const violations = check({ 'src/domain/__tests__/arrivals.test.ts': spec.join('\n') });
  assert.deepEqual(rulesOf(violations), ['skipped-test']);
  assert.match(violations[0]?.message ?? '', /it\.skip/);
});

test('skipped-test: flags xit, describe.only and a node:test skip option', () => {
  const spec = [
    "xit('a', () => expect(1).toBe(1));",
    "describe.only('b', () => expect(1).toBe(1));",
    "test('c', { skip: 'flaky' }, () => assert.ok(true));",
    "test('d', { skip: false }, () => assert.ok(true));",
  ];
  const violations = check({ 'scripts/x/__tests__/forms.test.ts': spec.join('\n') });
  assert.deepEqual(rulesOf(violations), ['skipped-test', 'skipped-test', 'skipped-test']);
  assert.deepEqual(violations.map((v) => v.line), [1, 2, 3]);
});

test('skipped-test: ignores skip-named calls outside test files', () => {
  const source = ['declare const reader: { skip(bytes: number): void };', 'reader.skip(4);', "it.skip('not a test file', () => 1);"];
  const violations = check({ 'src/domain/wire-reader.ts': source.join('\n') });
  assert.deepEqual(violations, []);
  assert.equal(violations.length, 0);
});

test('recursion: flags a function that calls itself', () => {
  const source = [IMPORT, 'export function depth(n: number): number {', ...ASSERT_N, '  return n === 0 ? 0 : depth(n - 1);', '}'];
  const violations = check({ 'src/domain/depth.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['recursion']);
  assert.match(violations[0]?.message ?? '', /`depth` calls itself/);
});

test('recursion: flags an a <-> b cycle across two files', () => {
  const a = [IMPORT, "import { b } from './b';", 'export function a(n: number): number {', ...ASSERT_N, '  return n === 0 ? 0 : b(n - 1);', '}'];
  const b = [IMPORT, "import { a } from './a';", 'export function b(n: number): number {', ...ASSERT_N, '  return n === 0 ? 0 : a(n - 1);', '}'];
  const violations = check({ 'src/domain/a.ts': a.join('\n'), 'src/domain/b.ts': b.join('\n') });
  assert.deepEqual(violations.map((v) => `${v.path} ${v.rule}`), ['src/domain/a.ts recursion', 'src/domain/b.ts recursion']);
  assert.match(violations[0]?.message ?? '', /a \(src\/domain\/a\.ts:3\) -> b \(src\/domain\/b\.ts:3\)/);
});

test('recursion: follows @/ aliases and calls made from inline callbacks', () => {
  const walk = [IMPORT, "import { visit } from '@/domain/visit';", 'export function walk(n: number): void {', ...ASSERT_N, '  [n].forEach((x) => visit(x));', '}'];
  const visit = [IMPORT, "import { walk } from '@/domain/walk';", 'export function visit(n: number): void {', ...ASSERT_N, '  walk(n - 1);', '}'];
  const violations = check({ 'src/domain/walk.ts': walk.join('\n'), 'src/domain/visit.ts': visit.join('\n') });
  assert.deepEqual(violations.map((v) => `${v.path} ${v.rule}`), ['src/domain/visit.ts recursion', 'src/domain/walk.ts recursion']);
  assert.match(violations[0]?.message ?? '', /call cycle/);
});

test('silent-catch: flags a catch block that swallows the error', () => {
  const source = [IMPORT, 'export function parse(n: number): unknown {', ...ASSERT_N, '  try {', '    return JSON.parse(String(n));', '  } catch {', '    return null;', '  }', '}'];
  const violations = check({ 'src/domain/parse.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['silent-catch']);
  assert.equal(violations[0]?.line, 7);
});

test('silent-catch: accepts rethrow and err(...), flags a swallowing .catch() handler', () => {
  const source = [
    IMPORT,
    "import { err, ok, type Result } from '../lib/result';",
    'export async function load(n: number): Promise<Result<unknown, string>> {',
    ...ASSERT_N,
    '  try {',
    '    await fetch(String(n));',
    '  } catch (error) {',
    "    throw new Error('load failed', { cause: error });",
    '  }',
    '  await fetch(String(n)).catch(() => undefined);',
    '  return fetch(String(n)).then((r) => ok(r)).catch((e: unknown) => err(String(e)));',
    '}',
  ];
  const violations = check({ 'src/live/load.ts': source.join('\n') });
  assert.deepEqual(rulesOf(violations), ['silent-catch']);
  assert.match(violations[0]?.message ?? '', /\.catch\(\) handler/);
});

test('clean: a compliant module gives 0 violations', () => {
  const source = [
    IMPORT,
    "import { err, ok, type Result } from '../lib/result';",
    '',
    '/** 1 + 2 + … + n, by a bounded loop. */',
    'export function triangle(n: number): Result<number, string> {',
    "  invariant(Number.isInteger(n), 'n is whole');",
    '  if (n < 0) {',
    "    return err('n must be >= 0');",
    '  }',
    '  let total = 0;',
    '  for (let i = 1; i <= n; i += 1) {',
    '    total += i;',
    '  }',
    "  invariant(total === (n * (n + 1)) / 2, 'the loop matches the closed form');",
    '  return ok(total);',
    '}',
    'export const DOUBLED = [1, 2, 3].map((x) => x * 2);',
  ].join('\n');
  assert.deepEqual(check({ 'src/domain/triangle.ts': source }), []);
  assert.deepEqual(check({ 'src/domain/__tests__/triangle.test.ts': source }), []);
});
