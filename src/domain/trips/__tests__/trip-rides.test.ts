import type { Ride } from '../../schedule/rides';
import { dropBeatenRides } from '../trip-rides';

const T0 = 1_790_769_660;
const MIN = 60;

/** A ride departing `depMin` minutes after T0 and taking `rideMin` minutes; `hop` = via the block link. */
function ride(depMin: number, rideMin: number, lineId: string, hop: boolean): Ride {
  expect(rideMin).toBeGreaterThan(0);
  const made: Ride = {
    serviceDate: 20260930,
    boardTripIdx: depMin * 10 + lineId.length,
    alightTripIdx: depMin * 10 + lineId.length + (hop ? 1 : 0),
    viaBlockLink: hop,
    lineId,
    alightLineId: lineId,
    boardStopId: '833',
    alightStopId: '838',
    depEpoch: T0 + depMin * MIN,
    arrEpoch: T0 + (depMin + rideMin) * MIN,
  };
  expect(made.arrEpoch).toBeGreaterThan(made.depEpoch);
  return made;
}

describe('trip ride filter (pure)', () => {
  it('a loop-around leaving with a faster direct ride is dropped', () => {
    const direct = ride(0, 4, 'MM_BRICKELL', false);
    const loop = ride(0, 17, 'MM_OMNI', true);
    expect(dropBeatenRides([direct, loop])).toEqual([direct]);
    expect(dropBeatenRides([loop, direct])).toEqual([direct]);
  });

  it('a direct ride departing later but arriving earlier also beats it', () => {
    const loop = ride(0, 17, 'MM_OMNI', true);
    const later = ride(5, 4, 'MM_BRICKELL', false);
    expect(dropBeatenRides([loop, later])).toEqual([later]);
    expect(dropBeatenRides([loop, ride(5, 13, 'MM_BRICKELL', false)])).toHaveLength(2);
  });

  it('a direct ride that departed earlier never beats a later ride', () => {
    const early = ride(0, 4, 'MM_BRICKELL', false);
    const hop = ride(1, 5.5, 'MM_INNER', true);
    expect(dropBeatenRides([early, hop])).toEqual([early, hop]);
    expect(dropBeatenRides([hop])).toEqual([hop]);
  });

  it('only a direct ride beats: a faster block-link ride leaves a slower one alone', () => {
    const slowHop = ride(0, 17, 'MM_OMNI', true);
    const fastHop = ride(0, 5.5, 'MM_INNER', true);
    expect(dropBeatenRides([slowHop, fastHop])).toEqual([slowHop, fastHop]);
    expect(dropBeatenRides([])).toEqual([]);
  });

  it('a slow direct ride is beaten like any other, and equal arrivals both stay', () => {
    const slow = ride(0, 20, 'ORANGE', false);
    const fast = ride(2, 4, 'GREEN', false);
    const tie = ride(2, 4, 'GREENX', false);
    expect(dropBeatenRides([slow, fast])).toEqual([fast]);
    expect(dropBeatenRides([fast, tie])).toEqual([fast, tie]);
  });

  it('rides out of departure order are a caller error', () => {
    expect(() => dropBeatenRides([ride(5, 4, 'A', false), ride(0, 4, 'B', false)])).toThrow(/departure order/);
    expect(dropBeatenRides([ride(0, 4, 'A', false), ride(5, 4, 'B', false)])).toHaveLength(2);
  });
});
