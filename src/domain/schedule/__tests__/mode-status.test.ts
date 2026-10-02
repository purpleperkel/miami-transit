import { InvariantError } from '../../../lib/invariant';
import type { ServiceDay } from '../../gtfs/service-day';
import type { Mode } from '../../network/stations';
import {
  type ModeCalendar,
  type ModeServiceDay,
  type ModeStart,
  modeStatus,
  modeStatuses,
  type ModeTimetable,
  type ModeTrip,
  STARTING_SOON_S,
} from '../mode-status';

/**
 * mfix4, the pure decision: running (in progress, or starting soon), closed until the next trip, or
 * past the bundled timetable. Synthetic service days; the real-DB cases are
 * scripts/gtfs/__tests__/mode-status-real.test.ts.
 */

/** Thu 2026-10-01: its service-day seconds count from New York midnight (EDT). */
const THU: ServiceDay = { date: 20261001, baseEpoch: 1_790_827_200 };
const FRI: ServiceDay = { date: 20261002, baseEpoch: THU.baseEpoch + 86_400 };
const SAT: ServiceDay = { date: 20261003, baseEpoch: FRI.baseEpoch + 86_400 };
const RAIL_FIRST_S = 5 * 3600;
const MOVER_FIRST_S = 5 * 3600 + 1800;

function trip(mode: Mode, startS: number, endS: number): ModeTrip {
  expect(startS).toBeLessThanOrEqual(endS);
  expect(['rail', 'mover']).toContain(mode);
  return { mode, startS, endS };
}

function start(mode: Mode, day: ServiceDay, startS: number): ModeStart {
  expect(Number.isInteger(startS)).toBe(true);
  expect(day.date).toBeGreaterThan(20_000_000);
  return { mode, serviceDate: day.date, baseEpoch: day.baseEpoch, startS };
}

/** Every day runs rail from RAIL_FIRST_S and the Mover from MOVER_FIRST_S, unless `days` says otherwise. */
function calendarOf(rail: readonly ServiceDay[], mover: readonly ServiceDay[]): ModeCalendar {
  const calendar = { rail: rail.map((day) => start('rail', day, RAIL_FIRST_S)), mover: mover.map((day) => start('mover', day, MOVER_FIRST_S)) };
  expect(calendar.rail).toHaveLength(rail.length);
  expect(calendar.mover).toHaveLength(mover.length);
  return calendar;
}

function timetable(days: readonly ModeServiceDay[], calendar: ModeCalendar = calendarOf([THU, FRI, SAT], [THU, FRI, SAT])): ModeTimetable {
  expect(days.length).toBeGreaterThan(0);
  expect(calendar.rail.length + calendar.mover.length).toBeGreaterThan(0);
  return { days, calendar };
}

/** Thu at hh:mm (service-day seconds from THU's base). */
function thuAt(hours: number, minutes: number): number {
  expect(hours).toBeGreaterThanOrEqual(0);
  expect(minutes).toBeLessThan(60);
  return THU.baseEpoch + hours * 3600 + minutes * 60;
}

describe('a mode is running (mfix4, pure)', () => {
  it('a trip in progress means its mode is running', () => {
    const noon = thuAt(12, 0);
    const day = { day: THU, trips: [trip('rail', 42_000, 45_000), trip('mover', 43_000, 43_500)], startsAfter: [] };
    expect(modeStatuses(noon, timetable([day]))).toEqual({ rail: { kind: 'running' }, mover: { kind: 'running' } });
  });

  it('a previous service day 24:xx trip keeps its mode running past midnight', () => {
    const fri0030 = FRI.baseEpoch + 1800;
    const thursday = { day: THU, trips: [trip('rail', 85_800, 90_240)], startsAfter: [] };
    const friday = { day: FRI, trips: [], startsAfter: [start('rail', FRI, RAIL_FIRST_S), start('mover', FRI, MOVER_FIRST_S)] };
    const statuses = modeStatuses(fri0030, timetable([thursday, friday]));
    expect(statuses.rail).toEqual({ kind: 'running' });
    expect(statuses.mover).toEqual({ kind: 'closed', nextStart: { epoch: FRI.baseEpoch + MOVER_FIRST_S, serviceDate: FRI.date, serviceSec: MOVER_FIRST_S } });
  });

  it('the starting soon window is at least 5 and under 15 minutes', () => {
    expect(STARTING_SOON_S).toBeGreaterThanOrEqual(5 * 60);
    expect(STARTING_SOON_S).toBeLessThan(15 * 60);
  });

  it('a first trip inside the starting soon window counts as running, one second later it is closed', () => {
    const first = FRI.baseEpoch + MOVER_FIRST_S;
    const soon = { day: FRI, trips: [trip('mover', MOVER_FIRST_S, MOVER_FIRST_S + 900)], startsAfter: [start('mover', FRI, MOVER_FIRST_S)] };
    expect(modeStatus('mover', first - STARTING_SOON_S, timetable([soon]))).toEqual({ kind: 'running' });
    const notYet = { day: FRI, trips: [], startsAfter: [start('mover', FRI, MOVER_FIRST_S)] };
    expect(modeStatus('mover', first - STARTING_SOON_S - 1, timetable([notYet]))).toEqual({
      kind: 'closed',
      nextStart: { epoch: first, serviceDate: FRI.date, serviceSec: MOVER_FIRST_S },
    });
  });
});

describe('a closed mode opens at its next trip (mfix4, pure)', () => {
  it('a gap in service opens at the next trip later the same service day', () => {
    const day = { day: THU, trips: [trip('mover', 43_000, 43_500)], startsAfter: [start('rail', THU, 50_000), start('mover', THU, 43_300)] };
    const statuses = modeStatuses(thuAt(12, 0), timetable([day]));
    expect(statuses.rail).toEqual({ kind: 'closed', nextStart: { epoch: THU.baseEpoch + 50_000, serviceDate: THU.date, serviceSec: 50_000 } });
    expect(statuses.mover).toEqual({ kind: 'running' });
  });

  it('after the last trip of the day the mode opens at its first trip on the next service day', () => {
    // Thursday's own calendar entry (its 5:30 first trip) is past: only a LATER service day can open the Mover.
    const day = { day: THU, trips: [trip('rail', 81_000, 84_840)], startsAfter: [start('rail', THU, 83_640)] };
    const status = modeStatus('mover', thuAt(23, 3), timetable([day]));
    expect(status).toEqual({ kind: 'closed', nextStart: { epoch: FRI.baseEpoch + MOVER_FIRST_S, serviceDate: FRI.date, serviceSec: MOVER_FIRST_S } });
    expect(modeStatus('rail', thuAt(23, 3), timetable([day]))).toEqual({ kind: 'running' });
  });

  it('the earliest start wins between a late 24:xx trip and the next day first trip', () => {
    // Thursday's next rail trip leaves at 24:10 (Fri 00:10), but Friday's own first leaves at 00:05.
    const day = { day: THU, trips: [], startsAfter: [start('rail', THU, 87_000)] };
    const calendar = { rail: [start('rail', THU, RAIL_FIRST_S), start('rail', FRI, 300), start('rail', SAT, RAIL_FIRST_S)], mover: [] };
    const status = modeStatus('rail', thuAt(23, 30), timetable([day], calendar));
    expect(status).toEqual({ kind: 'closed', nextStart: { epoch: FRI.baseEpoch + 300, serviceDate: FRI.date, serviceSec: 300 } });
    expect(modeStatus('mover', thuAt(23, 30), timetable([day], calendar))).toEqual({ kind: 'no-timetable' });
  });

  it('a mode with no trip left in the calendar has no timetable rather than closed', () => {
    const day = { day: SAT, trips: [trip('mover', 40_000, 41_000)], startsAfter: [start('mover', SAT, 41_500)] };
    const statuses = modeStatuses(SAT.baseEpoch + 40_500, timetable([day], calendarOf([THU], [THU, FRI, SAT])));
    expect(statuses).toEqual({ rail: { kind: 'no-timetable' }, mover: { kind: 'running' } });
  });

  it('a mode status needs a whole second inside the calendar', () => {
    const day = { day: THU, trips: [], startsAfter: [] };
    expect(() => modeStatuses(thuAt(12, 0) + 0.5, timetable([day]))).toThrow(InvariantError);
    expect(() => modeStatuses(thuAt(12, 0), { days: [], calendar: calendarOf([THU], [THU]) })).toThrow(InvariantError);
  });
});
