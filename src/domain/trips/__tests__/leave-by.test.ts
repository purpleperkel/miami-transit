import { InvariantError } from '../../../lib/invariant';
import { LEAVE_GRACE_S, leaveByEpoch, nextLeave } from '../leave-by';

/** Two rides 10 minutes apart; with walk 300 and buffer 120 their leave-bys are 580 and 1180. */
const RIDES = [
  { depEpoch: 1000, label: 'first' },
  { depEpoch: 1600, label: 'second' },
] as const;
const WALK_S = 300;
const BUFFER_S = 120;

describe('leave-by (M7.1)', () => {
  it('departure 1000, walk 300, buffer 120 -> leaveBy 580', () => {
    expect(leaveByEpoch(1000, 300, 120)).toBe(580);
    expect(nextLeave(RIDES, 0, WALK_S, BUFFER_S)).toEqual({ ride: RIDES[0], leaveByEpoch: 580 });
  });

  it('past the 30 s grace -> next ride (leaveBy + 31)', () => {
    expect(LEAVE_GRACE_S).toBe(30);
    expect(nextLeave(RIDES, 580 + 31, WALK_S, BUFFER_S)).toEqual({ ride: RIDES[1], leaveByEpoch: 1180 });
  });

  it('within the 30 s grace -> the same ride (leaveBy + 30)', () => {
    expect(nextLeave(RIDES, 580 + 30, WALK_S, BUFFER_S)).toEqual({ ride: RIDES[0], leaveByEpoch: 580 });
    expect(nextLeave(RIDES, 580, WALK_S, BUFFER_S)?.ride.label).toBe('first');
  });

  it('every ride past its grace -> no ride to count down to', () => {
    expect(nextLeave(RIDES, 1180 + LEAVE_GRACE_S + 1, WALK_S, BUFFER_S)).toBeNull();
    expect(nextLeave([], 0, WALK_S, BUFFER_S)).toBeNull();
  });

  it('rides out of departure order, or a negative walk, are caller errors', () => {
    expect(() => nextLeave([RIDES[1], RIDES[0]], 0, WALK_S, BUFFER_S)).toThrow(/departure order/);
    expect(() => leaveByEpoch(1000, -1, 120)).toThrow(InvariantError);
  });
});
