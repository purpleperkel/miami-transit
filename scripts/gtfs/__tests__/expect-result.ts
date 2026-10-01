import assert from 'node:assert/strict';

import type { Result } from '../../../src/lib/result';

/** Shared by the GTFS node:test suites: unwrap a Result, failing the test on the wrong branch. */

export function expectOk<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, `expected Ok, got Err: ${result.ok ? '' : JSON.stringify(result.error)}`);
  assert.equal(result.ok, true);
  return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
  assert.ok(!result.ok, 'expected Err, got Ok');
  assert.equal(result.ok, false);
  return result.error;
}
