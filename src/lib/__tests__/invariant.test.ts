import { invariant, InvariantError } from '../invariant';

describe('invariant', () => {
  it('throws an InvariantError when the condition is false', () => {
    expect(() => invariant(false)).toThrow(InvariantError);
    expect(() => invariant(false)).toThrow('Invariant violated');
  });

  it('carries the caller message', () => {
    expect(() => invariant(0, 'stop count must be positive')).toThrow(InvariantError);
    expect(() => invariant(0, 'stop count must be positive')).toThrow('stop count must be positive');
  });

  it('is an Error subclass named InvariantError', () => {
    const error = new InvariantError('broken contract');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvariantError');
  });

  it('returns quietly for every truthy condition', () => {
    expect(() => invariant(true)).not.toThrow();
    expect(() => invariant(1, 'one is truthy')).not.toThrow();
    expect(() => invariant('x', 'a non-empty string is truthy')).not.toThrow();
  });

  it('narrows the asserted type for the code after it', () => {
    const value: string | null = ['metrorail'].find((name) => name.length > 0) ?? null;
    invariant(value !== null, 'the fixture list has a non-empty name');
    expect(value.toUpperCase()).toBe('METRORAIL');
    expect(value).toHaveLength(9);
  });
});
