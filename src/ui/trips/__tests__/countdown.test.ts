import { InvariantError } from '@/lib/invariant';

import { countdown, countdownState } from '../countdown';

const LEAVE_BY = 1_790_770_000;
const MIN = 60;

/** The countdown when `leftS` seconds remain until the leave-by. */
function withLeft(leftS: number): ReturnType<typeof countdown> {
  const shown = countdown(LEAVE_BY, LEAVE_BY - leftS);
  expect(shown.leftS).toBe(leftS);
  expect(shown.state).toBe(countdownState(leftS));
  return shown;
}

describe('countdown states (M7.2)', () => {
  it('61 min -> clock time', () => {
    expect(withLeft(61 * MIN).state).toBe('clock');
    expect(withLeft(60 * MIN + 1).state).toBe('clock');
  });

  it('30 min -> normal', () => {
    expect(withLeft(30 * MIN)).toEqual({ state: 'normal', leftS: 30 * MIN, minutesLeft: 30 });
    expect(withLeft(60 * MIN).state).toBe('normal');
  });

  it('4 min -> soon', () => {
    expect(withLeft(4 * MIN)).toEqual({ state: 'soon', leftS: 4 * MIN, minutesLeft: 4 });
    expect(withLeft(5 * MIN).state).toBe('soon');
  });

  it('30 s -> now', () => {
    expect(withLeft(30)).toEqual({ state: 'now', leftS: 30, minutesLeft: 0 });
    expect(withLeft(0).state).toBe('now');
  });

  it('-10 s -> missed', () => {
    expect(withLeft(-10)).toEqual({ state: 'missed', leftS: -10, minutesLeft: 0 });
    expect(withLeft(-1).state).toBe('missed');
  });
});

describe('countdown band edges (M7.2)', () => {
  it('each band starts one second past the tighter one, and minutes round up', () => {
    expect([MIN + 1, 5 * MIN + 1].map((s) => withLeft(s).state)).toEqual(['soon', 'normal']);
    expect(withLeft(3 * MIN + 1).minutesLeft).toBe(4);
    expect(withLeft(MIN + 1).minutesLeft).toBe(2);
  });

  it('a fractional instant is a caller error', () => {
    expect(() => countdown(LEAVE_BY, LEAVE_BY + 0.5)).toThrow(InvariantError);
    expect(() => countdownState(1.5)).toThrow(/whole seconds/);
  });
});
