import { InvariantError } from '../invariant';
import { err, isOk, ok, type Result } from '../result';

describe('Result', () => {
  it('ok(1) is Ok and carries its value', () => {
    const result = ok(1);
    expect(isOk(result)).toBe(true);
    expect(result.value).toBe(1);
  });

  it('err("e") is not Ok and carries its error', () => {
    const result = err('e');
    expect(isOk(result)).toBe(false);
    expect(result.error).toBe('e');
  });

  it('isOk narrows a Result to its Ok branch', () => {
    const parsed: Result<number, string> = Number.isFinite(Number('42')) ? ok(42) : err('not a number');
    expect(isOk(parsed)).toBe(true);
    if (isOk(parsed)) {
      expect(parsed.value + 1).toBe(43);
    }
  });

  it('builds immutable Results', () => {
    expect(Object.isFrozen(ok({ stop: 'Government Center' }))).toBe(true);
    expect(Object.isFrozen(err(new Error('timeout')))).toBe(true);
  });

  it('refuses an err() without an error, so a failure never goes silent', () => {
    expect(() => err(undefined)).toThrow(InvariantError);
    expect(() => err(null)).toThrow(InvariantError);
  });
});
