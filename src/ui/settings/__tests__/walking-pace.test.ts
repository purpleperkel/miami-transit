import {
  checkWalkingPace,
  DEFAULT_JOG_MPS,
  DEFAULT_WALK_MPS,
  DEFAULT_WALKING_PACE,
  type PaceStore,
  readWalkingPace,
  saveWalkingPace,
  WALKING_PACE_ITEM,
} from '../walking-pace';
import type { KvStoreFake } from './native-fakes';

// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('./native-fakes').kvStoreModule());

/**
 * M8b.1 / M7c: the walk and jog paces hurry-or-chill weighs, kept in expo-sqlite/kv-store (mocked
 * here as the native module it is) under one key, read synchronously.
 */

const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');

beforeEach(() => kv.map.clear());

describe('walking pace (M8b.1): kv-store, defaults, refusals', () => {
  it('walking pace saves through the kv store and reads back', () => {
    expect(readWalkingPace()).toEqual({ walkMps: 1.35, jogMps: 2.7 });
    expect(saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 })).toEqual({ ok: true, value: { walkMps: 1.5, jogMps: 3.1 } });
    expect([...kv.map]).toEqual([[WALKING_PACE_ITEM, '{"walkMps":1.5,"jogMps":3.1}']]);
    expect(readWalkingPace()).toEqual({ walkMps: 1.5, jogMps: 3.1 });
  });

  it('the defaults are the plan\'s 1.35 m/s walk and 2.7 m/s jog', () => {
    expect([DEFAULT_WALK_MPS, DEFAULT_JOG_MPS]).toEqual([1.35, 2.7]);
    expect(DEFAULT_WALKING_PACE).toEqual({ walkMps: 1.35, jogMps: 2.7 });
  });

  it('a jog no faster than the walk is refused and nothing is stored', () => {
    expect(saveWalkingPace({ walkMps: 1.5, jogMps: 3.1 }).ok).toBe(true);
    const before = [...kv.map];
    expect(saveWalkingPace({ walkMps: 2, jogMps: 1.8 })).toEqual({ ok: false, error: { kind: 'invalid-pace', message: 'the jog must be faster than the walk' } });
    expect(saveWalkingPace({ walkMps: 2, jogMps: 2 }).ok).toBe(false);
    expect([...kv.map]).toEqual(before);
  });

  it('a pace outside 0.3–8 m/s, or not a number, is refused', () => {
    const outOfRange = { ok: false, error: { kind: 'invalid-pace', message: 'paces are between 0.3 and 8 m/s' } };
    expect(checkWalkingPace({ walkMps: 0.1, jogMps: 2.7 })).toEqual(outOfRange);
    expect(checkWalkingPace({ walkMps: 1.35, jogMps: 12 })).toEqual(outOfRange);
    expect(checkWalkingPace({ walkMps: Number.NaN, jogMps: 2.7 })).toEqual(outOfRange);
    expect(kv.map.size).toBe(0);
  });

  it('a stored value it cannot read gives the defaults (only a future format could write one)', () => {
    kv.map.set(WALKING_PACE_ITEM, '{"walkMps":"fast","jogMps":3}');
    expect(readWalkingPace()).toEqual(DEFAULT_WALKING_PACE);
    kv.map.set(WALKING_PACE_ITEM, '{"walkMps":3,"jogMps":2}');
    expect(readWalkingPace()).toEqual(DEFAULT_WALKING_PACE);
  });

  it('a kv store that fails to write gives a storage error, never a throw', () => {
    const broken: PaceStore = { getItemSync: () => null, setItemSync: () => { throw new Error('disk full'); } };
    expect(saveWalkingPace({ walkMps: 1.4, jogMps: 3 }, broken)).toEqual({ ok: false, error: { kind: 'storage', message: 'could not save the paces: disk full' } });
    expect(readWalkingPace(broken)).toEqual(DEFAULT_WALKING_PACE);
  });
});
