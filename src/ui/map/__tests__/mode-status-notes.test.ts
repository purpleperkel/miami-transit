import type { ModeStatusOutcome } from '@/data/schedule-repo';
import { providerConfig } from '@/domain/live/constants';
import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import type { NextStart } from '@/domain/schedule/mode-status';
import { InvariantError } from '@/lib/invariant';

import { closedText, hasLiveVehicle, modeStatusNotes } from '../use-mode-status';

/**
 * mfix4, the chip's words (pure): which closed modes get a line, how a live vehicle hides one — only a
 * vehicle the map still draws — and how the opening time reads. The rendered map cases are
 * ModeStatusChip.test.tsx.
 */

/** Thu 2026-10-01 23:03 New York, and Friday's service day (base = New York midnight, EDT). */
const THU_2303 = 1_790_910_180;
const FRI = { date: 20261002, baseEpoch: 1_790_913_600 };
const MOVER_OPENS: NextStart = { epoch: FRI.baseEpoch + 19_800, serviceDate: FRI.date, serviceSec: 19_800 };
const RAIL_OPENS: NextStart = { epoch: FRI.baseEpoch + 18_000, serviceDate: FRI.date, serviceSec: 18_000 };
const BOTH_CLOSED: ModeStatusOutcome = { kind: 'mode-status', rail: { kind: 'closed', nextStart: RAIL_OPENS }, mover: { kind: 'closed', nextStart: MOVER_OPENS } };

/** A Transitland batch fetched at `fetchedAt` holding one vehicle of `mode` fixed at `timestamp`. */
function batchOf(mode: 'rail' | 'mover', timestamp: number, fetchedAt: number): LiveBatch<LiveVehicle> {
  const vehicle: LiveVehicle = {
    vehicleId: `${mode}-1`,
    label: null,
    tripId: null,
    routeId: mode === 'rail' ? '31009' : '14457',
    mode,
    lineId: mode === 'rail' ? 'RAIL_TRUNK' : 'MM_INNER',
    lineSource: 'route',
    directionId: null,
    position: { latitude: 25.7743, longitude: -80.1937 },
    bearing: null,
    speedMps: null,
    stopId: null,
    stopStatus: null,
    timestamp,
  };
  expect(vehicle.timestamp).toBeLessThanOrEqual(fetchedAt);
  expect(vehicle.mode).toBe(mode);
  return { items: [vehicle], feedTimestamp: fetchedAt, dropped: {}, provider: 'transitland', fetchedAt, bytes: 100 };
}

describe('which closed modes the chip names (mfix4)', () => {
  it('every closed mode gets one line, rail first', () => {
    const notes = modeStatusNotes(BOTH_CLOSED, null, THU_2303);
    expect(notes).toEqual([
      { mode: 'rail', text: 'Metrorail closed · opens 5:00 AM' },
      { mode: 'mover', text: 'Metromover closed · opens 5:30 AM' },
    ]);
    expect(new Set(notes.map((note) => note.mode)).size).toBe(notes.length);
  });

  it('running and no-timetable modes and the calendar gap get no line', () => {
    const outcome: ModeStatusOutcome = { kind: 'mode-status', rail: { kind: 'no-timetable' }, mover: { kind: 'running' } };
    expect(modeStatusNotes(outcome, null, THU_2303)).toEqual([]);
    expect(modeStatusNotes({ kind: 'expired', lastDate: 20261231 }, null, THU_2303)).toEqual([]);
    expect(modeStatusNotes(null, null, THU_2303)).toEqual([]);
  });

  it('a live vehicle of the closed mode hides its line and only its line', () => {
    const live = batchOf('mover', THU_2303 - 20, THU_2303 - 10);
    expect(hasLiveVehicle(live, 'mover', THU_2303)).toBe(true);
    expect(hasLiveVehicle(live, 'rail', THU_2303)).toBe(false);
    expect(modeStatusNotes(BOTH_CLOSED, live, THU_2303).map((note) => note.mode)).toEqual(['rail']);
  });

  it('a vehicle the map has dropped as too old does not hide the line', () => {
    // The last batch before the phone went offline, older than Transitland's drop limit.
    const maxAgeS = providerConfig('transitland').maxAgeS;
    const old = batchOf('mover', THU_2303 - maxAgeS - 60, THU_2303 - maxAgeS - 30);
    expect(hasLiveVehicle(old, 'mover', THU_2303)).toBe(false);
    expect(modeStatusNotes(BOTH_CLOSED, old, THU_2303).map((note) => note.mode)).toEqual(['rail', 'mover']);
  });
});

describe('how the opening time reads (mfix4)', () => {
  it('an opening within a day reads as its clock time alone', () => {
    expect(closedText('mover', MOVER_OPENS, THU_2303)).toBe('Metromover closed · opens 5:30 AM');
    expect(closedText('mover', MOVER_OPENS, MOVER_OPENS.epoch - 86_399)).toBe('Metromover closed · opens 5:30 AM');
  });

  it('an opening a day or more away also names its day', () => {
    // Friday 2026-10-02 at 5:30, seen from Wednesday evening; a 24:30 start of Friday's service day is Saturday's.
    expect(closedText('mover', MOVER_OPENS, MOVER_OPENS.epoch - 86_400)).toBe('Metromover closed · opens Fri 5:30 AM');
    const lateStart: NextStart = { epoch: FRI.baseEpoch + 88_200, serviceDate: FRI.date, serviceSec: 88_200 };
    expect(closedText('rail', lateStart, THU_2303 - 86_400)).toBe('Metrorail closed · opens Sat 12:30 AM');
  });

  it('a mode never opens in the past', () => {
    expect(() => closedText('rail', RAIL_OPENS, RAIL_OPENS.epoch)).toThrow(InvariantError);
    expect(() => modeStatusNotes(BOTH_CLOSED, null, THU_2303 + 0.5)).toThrow(InvariantError);
  });
});
