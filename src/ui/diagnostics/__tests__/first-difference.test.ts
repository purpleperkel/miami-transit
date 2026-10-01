import { InvariantError } from '../../../lib/invariant';
import { firstDifference } from '../first-difference';

describe('firstDifference', () => {
  it('returns null for deep-equal JSON values', () => {
    const feed = { header: { version: '2.0', timestamp: 1790872200 }, entity: [{ id: 'a', speed: null }] };
    expect(firstDifference(feed, structuredClone(feed))).toBeNull();
    expect(firstDifference([1, 'two', true, null], [1, 'two', true, null])).toBeNull();
  });

  it('names the path of a differing leaf, with both values', () => {
    const actual = { entity: [{ vehicle: { position: { speed: 6.5 } } }] };
    const expected = { entity: [{ vehicle: { position: { speed: 6.7 } } }] };
    expect(firstDifference(actual, expected)).toBe('$.entity[0].vehicle.position.speed: got 6.5, want 6.7');
    expect(firstDifference('Gov’t Center', 'Govt Center')).toBe('$: got "Gov’t Center", want "Govt Center"');
  });

  it('reports the FIRST difference in document order', () => {
    const actual = { a: 1, b: { c: 'x' }, d: 9 };
    const expected = { a: 1, b: { c: 'y' }, d: 10 };
    expect(firstDifference(actual, expected)).toBe('$.b.c: got "x", want "y"');
    expect(firstDifference([0, 1, 2], [0, 5, 6])).toBe('$[1]: got 1, want 5');
  });

  it('reports missing and unexpected keys, and array length changes', () => {
    expect(firstDifference({ id: 'a' }, { id: 'a', label: 'b' })).toBe('$.label: missing');
    expect(firstDifference({ id: 'a', extra: 1 }, { id: 'a' })).toBe('$.extra: not expected');
    expect(firstDifference([1, 2], [1, 2, 3])).toBe('$[2]: missing');
  });

  it('tells null from an object, an array from an object, and 0 from null', () => {
    expect(firstDifference({ trip: null }, { trip: {} })).toBe('$.trip: got null, want {}');
    expect(firstDifference([], {})).toBe('$: got [], want {}');
    expect(firstDifference({ bearing: 0 }, { bearing: null })).toBe('$.bearing: got 0, want null');
  });

  it('fails loudly on a cyclic value instead of looping forever', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.self = a;
    b.self = b;
    expect(() => firstDifference(a, b)).toThrow(InvariantError);
    expect(() => firstDifference(a, b)).toThrow(/bounded/);
  });
});
