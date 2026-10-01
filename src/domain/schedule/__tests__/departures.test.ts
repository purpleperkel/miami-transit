import { InvariantError } from '../../../lib/invariant';
import { type ServiceDay, windowFrom } from '../../gtfs/service-day';
import { assembleDepartures, isDeparture, type StopVisit } from '../departures';

const FRI: ServiceDay = { date: 20261002, baseEpoch: 1_790_913_600 };
const SAT: ServiceDay = { date: 20261003, baseEpoch: FRI.baseEpoch + 86_400 };

/** A stop visit at Government Center: position `seq` of a 22-stop Green Line trip unless overridden. */
function visit(tripIdx: number, depS: number, overrides: Partial<StopVisit> = {}): StopVisit {
  expect(Number.isInteger(tripIdx) && Number.isInteger(depS)).toBe(true);
  const made: StopVisit = {
    tripIdx,
    tripId: `t${tripIdx}`,
    seq: 13,
    lastSeq: 21,
    depS,
    stopId: '9512',
    lineId: 'GREEN',
    directionId: 0,
    destStationKey: 'rail:dadeland-south',
    destName: 'Dadeland South',
    note: null,
    ...overrides,
  };
  expect(made.seq).toBeLessThanOrEqual(made.lastSeq);
  return made;
}

describe('departure assembly (M3.3, pure)', () => {
  it('a trip ending at the station is an arrival, never a departure', () => {
    expect(isDeparture(visit(1, 30_000))).toBe(true);
    expect(isDeparture(visit(2, 30_000, { seq: 21 }))).toBe(false);
    expect(() => isDeparture({ ...visit(3, 30_000), seq: 22 })).toThrow(InvariantError);
  });

  it('a 24:xx trip of the previous service day departs at its own base + dep_s, interleaved with today’s', () => {
    const window = windowFrom(SAT.baseEpoch, 3600);
    const departures = assembleDepartures(window, [
      { day: FRI, visits: [visit(10, 87_240), visit(11, 86_400 + 4000)] },
      { day: SAT, visits: [visit(20, 1200)] },
    ]);
    expect(departures.map((d) => [d.serviceDate, d.tripIdx, d.epoch])).toEqual([
      [FRI.date, 10, FRI.baseEpoch + 87_240],
      [SAT.date, 20, SAT.baseEpoch + 1200],
    ]);
    expect(departures.every((d) => d.epoch >= window.fromEpoch && d.epoch <= window.toEpoch)).toBe(true);
  });

  it('the window is inclusive at both ends, and terminating visits are dropped', () => {
    const window = windowFrom(FRI.baseEpoch + 28_800, 1800);
    const departures = assembleDepartures(window, [
      { day: FRI, visits: [visit(1, 28_799), visit(2, 28_800), visit(3, 30_600), visit(4, 30_601), visit(5, 29_000, { seq: 21 })] },
    ]);
    expect(departures.map((d) => d.tripIdx)).toEqual([2, 3]);
    expect(departures[0]).not.toHaveProperty('seq');
  });

  it('service days must come in date order', () => {
    expect(() => assembleDepartures(windowFrom(SAT.baseEpoch, 60), [{ day: SAT, visits: [] }, { day: FRI, visits: [] }])).toThrow(InvariantError);
    expect(assembleDepartures(windowFrom(SAT.baseEpoch, 60), [])).toEqual([]);
  });
});
