import { InvariantError } from '../../../lib/invariant';
import { estimateWalk, PLANNING_WALK_MPS, WALK_DETOUR, walkSeconds } from '../walk-estimate';

describe('walk estimate (M7.1)', () => {
  it('1000 m -> 1000 s at 1 m/s of straight line (a 1.3x detour at 1.3 m/s)', () => {
    expect(WALK_DETOUR / PLANNING_WALK_MPS).toBe(1);
    expect(estimateWalk({ straightMeters: 1000 })).toEqual({ walkS: 1000, source: 'distance' });
  });

  it('override 7 min -> 420 s, whatever the distance says', () => {
    expect(estimateWalk({ straightMeters: 1000, overrideMin: 7 })).toEqual({ walkS: 420, source: 'override' });
    expect(estimateWalk({ straightMeters: null, overrideMin: 7 })).toEqual({ walkS: 420, source: 'override' });
  });

  it('a 0-minute override (the station is the start) is a real override, not "none"', () => {
    expect(estimateWalk({ straightMeters: 1000, overrideMin: 0 })).toEqual({ walkS: 0, source: 'override' });
    expect(estimateWalk({ straightMeters: 1000, overrideMin: null })).toEqual({ walkS: 1000, source: 'distance' });
  });

  it('no start and no override -> no estimate', () => {
    expect(estimateWalk({ straightMeters: null })).toBeNull();
    expect(estimateWalk({ straightMeters: null, overrideMin: null })).toBeNull();
  });

  it("a caller's own pace and detour replace the planning defaults, rounded to whole seconds", () => {
    expect(estimateWalk({ straightMeters: 400, paceMps: 1.35 })).toEqual({ walkS: 385, source: 'distance' });
    expect(walkSeconds(400, 1.35, 1.3)).toBe(385);
    expect(walkSeconds(400, 2, 1)).toBe(200);
  });

  it('an impossible distance, pace, detour or override is a caller error', () => {
    expect(() => estimateWalk({ straightMeters: -1 })).toThrow(InvariantError);
    expect(() => estimateWalk({ straightMeters: 100, overrideMin: 7.5 })).toThrow(/whole minutes/);
    expect(() => estimateWalk({ straightMeters: 100, overrideMin: 181 })).toThrow(/whole minutes/);
    expect(() => walkSeconds(100, 0, 1.3)).toThrow(/pace/);
    expect(() => walkSeconds(100, 1.3, 0.9)).toThrow(/detour/);
  });
});
