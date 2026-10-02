import { useMemo } from 'react';

import { useScheduleDb } from '@/data/schedule-db-provider';
import type { ModeStatusOutcome } from '@/data/schedule-repo';
import { isDroppedSighting, sightingOf } from '@/domain/live/staleness';
import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import type { Mode } from '@/domain/network/stations';
import { MODES, type NextStart } from '@/domain/schedule/mode-status';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';

import { MODE_NAMES } from '../a11y';
import { useNowS } from '../clock';
import { formatClockFromServiceSec } from '../format';

/**
 * What the map's mode-status chip says (mfix4): one line per mode that is CLOSED by the timetable
 * (ScheduleRepo.modeStatusAt) AND has no live vehicle on the map — "Metromover closed · opens 5:30 AM".
 * Jamie at 23:03 saw an empty Mover loop with no word of why; the empty map was the truth, unexplained.
 *
 * Nothing is said while a mode runs (or starts within the starting-soon window), while the live feed
 * still shows one of its vehicles, when its bundled timetable has run out ('no-timetable': the status
 * pill owns schedule expiry), or while the schedule DB is not open or the calendar has no service day.
 *
 * REALTIME COST RULE: no live request of its own. The status is the bundled timetable plus the vehicles
 * the live runtime already polls (useLive().state, read only). It is re-judged every
 * MODE_STATUS_PERIOD_MS on the screen clock, so the line appears when the last trip ends, no remount.
 */

/** How often the status is re-judged while the map is mounted (at least once a minute). */
export const MODE_STATUS_PERIOD_MS = 30_000;

const DAY_S = 86_400;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** One line of the chip: a closed mode, and when it opens. */
export type ModeStatusNote = { readonly mode: Mode; readonly text: string };

/** The chip's lines now, from the open schedule DB, the live vehicles and the screen clock. */
export function useModeStatusNotes(): readonly ModeStatusNote[] {
  const schedule = useScheduleDb();
  const repo = schedule.kind === 'ready' ? schedule.repo : null;
  const vehicles = useLive().state?.vehicles ?? null;
  const nowS = useNowS(MODE_STATUS_PERIOD_MS);
  const outcome = useMemo(() => (repo === null ? null : repo.modeStatusAt(nowS)), [repo, nowS]);
  const notes = useMemo(() => modeStatusNotes(outcome, vehicles, nowS), [outcome, vehicles, nowS]);
  invariant(repo !== null || notes.length === 0, 'nothing is said before the schedule DB is open');
  invariant(notes.length <= MODES.length, 'at most one line per mode');
  return notes;
}

/** The lines for an outcome judged at `nowS`: each closed mode without a live vehicle on the map, rail first. */
export function modeStatusNotes(outcome: ModeStatusOutcome | null, vehicles: LiveBatch<LiveVehicle> | null, nowS: number): ModeStatusNote[] {
  invariant(Number.isSafeInteger(nowS), `a status is judged at a whole epoch second, got ${nowS}`);
  if (outcome === null || outcome.kind !== 'mode-status') {
    return [];
  }
  const notes = MODES.flatMap((mode): ModeStatusNote[] => {
    const status = outcome[mode];
    return status.kind === 'closed' && !hasLiveVehicle(vehicles, mode, nowS) ? [{ mode, text: closedText(mode, status.nextStart, nowS) }] : [];
  });
  invariant(notes.every((note) => outcome[note.mode].kind === 'closed'), 'only a closed mode gets a line');
  return notes;
}

/**
 * The live batch holds a vehicle of `mode` the map still draws at `nowS`: one not dropped by the
 * staleness rule (staleness.ts — its feed or its fix past the provider's max age). An hours-old batch
 * kept while offline therefore never hides a closed line.
 */
export function hasLiveVehicle(batch: LiveBatch<LiveVehicle> | null, mode: Mode, nowS: number): boolean {
  invariant(MODES.includes(mode), `${mode} is a mode`);
  invariant(Number.isFinite(nowS), 'liveness is judged at an instant');
  if (batch === null) {
    return false;
  }
  return batch.items.some((vehicle) => vehicle.mode === mode && !isDroppedSighting(sightingOf(batch.provider, batch, vehicle.timestamp, nowS)));
}

/**
 * "Metromover closed · opens 5:30 AM": the clock time printed from the next trip's service-day seconds
 * (format.ts, no time-zone math). An opening a day or more away also names its day ("opens Sat 5:30 AM"),
 * so a bare clock time is never read as the wrong day's.
 */
export function closedText(mode: Mode, nextStart: NextStart, nowS: number): string {
  invariant(nextStart.epoch > nowS, 'a closed mode opens later');
  const clock = formatClockFromServiceSec(nextStart.serviceSec);
  const when = nextStart.epoch - nowS < DAY_S ? clock : `${weekdayOf(nextStart)} ${clock}`;
  const text = `${MODE_NAMES[mode]} closed · opens ${when}`;
  invariant(text.endsWith(clock), 'the line ends with the opening time');
  return text;
}

/** The weekday the next trip starts on: its service date, plus a day for a start past 24:00. Calendar arithmetic only. */
function weekdayOf(nextStart: NextStart): string {
  const year = Math.floor(nextStart.serviceDate / 10_000);
  const month = Math.floor(nextStart.serviceDate / 100) % 100;
  invariant(month >= 1 && month <= 12, `${nextStart.serviceDate} is a YYYYMMDD date`);
  const dayOfMonth = (nextStart.serviceDate % 100) + Math.floor(nextStart.serviceSec / DAY_S);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay()];
  invariant(weekday !== undefined, 'every civil date falls on a weekday');
  return weekday;
}
