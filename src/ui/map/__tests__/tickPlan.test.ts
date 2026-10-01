import { FOCUSED_TICK_MS, NO_TICK_MS, REDUCED_MOTION_TICK_MS, tickPlan } from '../tickPlan';

/** M5.10: the frame tick period — 250 ms focused, 5000 ms under Reduce Motion, no timer when out of sight. */

describe('tickPlan (M5.10)', () => {
  it('focused -> 250 ms', () => {
    expect(FOCUSED_TICK_MS).toBe(250);
    expect(tickPlan({ appActive: true, mapFocused: true, reduceMotion: false })).toBe(250);
  });

  it('reduce motion -> 5000 ms', () => {
    expect(REDUCED_MOTION_TICK_MS).toBe(5000);
    expect(tickPlan({ appActive: true, mapFocused: true, reduceMotion: true })).toBe(5000);
  });

  it('inactive -> 0 ms', () => {
    expect(NO_TICK_MS).toBe(0);
    // Inactive = the app is not active OR the map is not focused, and it wins over Reduce Motion.
    for (const reduceMotion of [false, true]) {
      expect(tickPlan({ appActive: false, mapFocused: true, reduceMotion })).toBe(0);
      expect(tickPlan({ appActive: true, mapFocused: false, reduceMotion })).toBe(0);
      expect(tickPlan({ appActive: false, mapFocused: false, reduceMotion })).toBe(0);
    }
  });
});
