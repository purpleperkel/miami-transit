import { InvariantError } from '../../../lib/invariant';
import { type ServiceDay, windowFrom } from '../../gtfs/service-day';
import { assembleRides, judgeRides, type RideCandidate } from '../rides';

const WED: ServiceDay = { date: 20260930, baseEpoch: 1_790_740_800 };
const AT_0800 = 28_800;

/** A candidate boarding trip `board` at 08:00 (position 1 of 4) on the Inner Loop. */
function candidate(board: number, overrides: Partial<RideCandidate> = {}): RideCandidate {
  expect(Number.isInteger(board)).toBe(true);
  const made: RideCandidate = {
    boardTripIdx: board,
    boardSeq: 1,
    boardLastSeq: 3,
    boardDepS: AT_0800,
    boardStopId: '833',
    lineId: 'MM_INNER',
    alightTripIdx: board,
    alightSeq: 2,
    alightArrS: AT_0800 + 60,
    alightStopId: '834',
    alightLineId: 'MM_INNER',
    viaBlockLink: false,
    ...overrides,
  };
  expect(made.boardSeq).toBeLessThan(made.boardLastSeq);
  return made;
}

/** The same boarding reaching B only on the vehicle's next trip. */
function hop(board: number, next: number, arrS: number): RideCandidate {
  expect(next).not.toBe(board);
  const made = candidate(board, { alightTripIdx: next, alightSeq: 2, alightArrS: arrS, alightStopId: '838', viaBlockLink: true });
  expect(made.viaBlockLink).toBe(true);
  return made;
}

describe('ride assembly (M3.4, pure)', () => {
  it('a boarding whose own trip reaches B rides direct, even when the block hop is listed too', () => {
    const rides = assembleRides(windowFrom(WED.baseEpoch + AT_0800, 600), [
      { day: WED, candidates: [hop(1, 2, AT_0800 + 300), candidate(1, { alightArrS: AT_0800 + 400 })] },
    ]);
    expect(rides).toHaveLength(1);
    expect(rides[0]).toMatchObject({ viaBlockLink: false, alightTripIdx: 1, arrEpoch: WED.baseEpoch + AT_0800 + 400 });
  });

  it('without a direct alighting, the ride takes the hop onto next_trip_idx', () => {
    const rides = assembleRides(windowFrom(WED.baseEpoch + AT_0800, 600), [{ day: WED, candidates: [hop(1, 2, AT_0800 + 330)] }]);
    expect(rides).toEqual([
      expect.objectContaining({ boardTripIdx: 1, alightTripIdx: 2, viaBlockLink: true, depEpoch: WED.baseEpoch + AT_0800 }),
    ]);
    expect(rides[0]!.arrEpoch - rides[0]!.depEpoch).toBe(330);
  });

  it('only boardings inside the window count, earliest departure first', () => {
    const later = candidate(7, { boardDepS: AT_0800 + 300, alightArrS: AT_0800 + 360 });
    const outside = candidate(8, { boardDepS: AT_0800 + 900, alightArrS: AT_0800 + 960 });
    const rides = assembleRides(windowFrom(WED.baseEpoch + AT_0800, 600), [{ day: WED, candidates: [outside, later, candidate(6)] }]);
    expect(rides.map((r) => r.boardTripIdx)).toEqual([6, 7]);
    expect(rides[1]).toMatchObject({ depEpoch: WED.baseEpoch + AT_0800 + 300, arrEpoch: WED.baseEpoch + AT_0800 + 360 });
  });

  it('no ride in the window -> needs-transfer; any ride -> rides', () => {
    expect(judgeRides([])).toEqual({ kind: 'needs-transfer' });
    const rides = assembleRides(windowFrom(WED.baseEpoch + AT_0800, 60), [{ day: WED, candidates: [candidate(1)] }]);
    expect(judgeRides(rides)).toEqual({ kind: 'rides', rides });
  });

  it('a candidate alighting upstream, or boarding at the last stop, breaks the contract', () => {
    const window = windowFrom(WED.baseEpoch + AT_0800, 600);
    expect(() => assembleRides(window, [{ day: WED, candidates: [{ ...candidate(1), alightSeq: 0 }] }])).toThrow(InvariantError);
    expect(() => assembleRides(window, [{ day: WED, candidates: [{ ...candidate(1), boardSeq: 3 }] }])).toThrow(InvariantError);
  });
});
