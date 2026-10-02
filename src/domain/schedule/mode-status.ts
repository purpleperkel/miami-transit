import { invariant } from '../../lib/invariant';
import type { ServiceDay } from '../gtfs/service-day';
import type { Mode } from '../network/stations';

/**
 * mfix4: is each mode running at an instant, by the bundled timetable? Jamie, 2026-10-01 23:03: "Not
 * seeing any metro move cars" — the Mover's last trips had ended at 22:12 and the map showed an empty
 * loop with no word of why. Pure: ScheduleRepo.modeStatusAt reads the rows (SQL), this module decides.
 *
 *   running       a trip of the mode is in progress (start <= t <= end — a previous service day's
 *                 24:xx trips included), or one starts within STARTING_SOON_S;
 *   closed        none is, and the mode's next trip starts later this service day or on a later one:
 *                 `nextStart` is that trip's start, as an epoch AND as service-day seconds, so the
 *                 phone prints the time from the number (format.ts) and does no time-zone math;
 *   no-timetable  no trip of the mode from t to the end of the bundled calendar. A data gap, never a
 *                 closed line: the rail timetable ends 2026-11-22 while the Mover's runs to 12-31.
 */

/** A first trip starting within this long counts as running: the line is about to open, not closed. */
export const STARTING_SOON_S = 600;

/** Every mode, in the order the app lists them (rail first). */
export const MODES: readonly Mode[] = Object.freeze(['rail', 'mover']);

/** One trip of a mode, in its service day's seconds. */
export type ModeTrip = { readonly mode: Mode; readonly startS: number; readonly endS: number };

/** A trip start of a mode on a service day (the day's base epoch + startS is the instant). */
export type ModeStart = { readonly mode: Mode; readonly serviceDate: number; readonly baseEpoch: number; readonly startS: number };

/** When a closed mode next runs: its next trip's start. */
export type NextStart = {
  readonly epoch: number;
  /** YYYYMMDD of the service day the trip belongs to. */
  readonly serviceDate: number;
  /** The trip's start in that day's seconds (`trip.start_s`), for formatClockFromServiceSec. */
  readonly serviceSec: number;
};

export type ModeStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'closed'; readonly nextStart: NextStart }
  | { readonly kind: 'no-timetable' };

export type ModeStatuses = Readonly<Record<Mode, ModeStatus>>;

/** One service day running during [t, t + STARTING_SOON_S], as the repo reads it. */
export type ModeServiceDay = {
  readonly day: ServiceDay;
  /** Its trips that may run during the window (a superset is fine: the decision re-checks every one). */
  readonly trips: readonly ModeTrip[];
  /** Each mode's first trip on this day starting after t (none for a mode with no later trip that day). */
  readonly startsAfter: readonly ModeStart[];
};

/** Each mode's FIRST trip start on every service day of the calendar, in date order (read once per DB). */
export type ModeCalendar = Readonly<Record<Mode, readonly ModeStart[]>>;

export type ModeTimetable = {
  /** The service days running during [t, t + STARTING_SOON_S], in date order (never empty). */
  readonly days: readonly ModeServiceDay[];
  readonly calendar: ModeCalendar;
};

const RUNNING: ModeStatus = Object.freeze({ kind: 'running' });
const NO_TIMETABLE: ModeStatus = Object.freeze({ kind: 'no-timetable' });

/** Rail's and the Mover's status at `epoch`. */
export function modeStatuses(epoch: number, timetable: ModeTimetable): ModeStatuses {
  invariant(Number.isSafeInteger(epoch), `a mode status is judged at a whole epoch second, got ${epoch}`);
  invariant(timetable.days.length > 0, 'the instant lies inside the calendar: some service day runs then');
  const statuses: ModeStatuses = { rail: modeStatus('rail', epoch, timetable), mover: modeStatus('mover', epoch, timetable) };
  invariant(MODES.every((mode) => statuses[mode] !== undefined), 'every mode has a status');
  return statuses;
}

/** One mode's status at `epoch`: running (or starting soon), closed until its next trip, or past its timetable. */
export function modeStatus(mode: Mode, epoch: number, timetable: ModeTimetable): ModeStatus {
  invariant(MODES.includes(mode), `${mode} is a mode`);
  invariant(timetable.days.every(({ day }, i) => i === 0 || timetable.days[i - 1]!.day.date < day.date), 'the running days come in date order');
  if (runsDuring(mode, epoch, timetable.days)) {
    return RUNNING;
  }
  const next = nextStartAfter(mode, epoch, timetable);
  if (next === null) {
    return NO_TIMETABLE;
  }
  invariant(next.epoch > epoch + STARTING_SOON_S, 'a mode whose next trip starts soon counts as running, not closed');
  return { kind: 'closed', nextStart: next };
}

/** A trip of `mode` on a running day is in progress at `epoch`, or starts within STARTING_SOON_S of it. */
function runsDuring(mode: Mode, epoch: number, days: readonly ModeServiceDay[]): boolean {
  invariant(Number.isSafeInteger(epoch), 'running is judged at a whole second');
  invariant(days.every(({ trips }) => trips.every((trip) => trip.startS <= trip.endS)), 'every trip ends after it starts');
  return days.some(({ day, trips }) =>
    trips.some((trip) => trip.mode === mode && day.baseEpoch + trip.startS <= epoch + STARTING_SOON_S && day.baseEpoch + trip.endS >= epoch),
  );
}

/**
 * The earliest trip of `mode` starting after `epoch`: later on a running day, else on a later service
 * day of the calendar. The calendar is walked in date order (a bounded loop over its days) and stops
 * once a day begins after the best start found — a later day's trips all start after its base.
 */
function nextStartAfter(mode: Mode, epoch: number, timetable: ModeTimetable): NextStart | null {
  const lastRunningDate = timetable.days[timetable.days.length - 1]!.day.date;
  let best: ModeStart | null = null;
  for (const { startsAfter } of timetable.days) {
    for (const start of startsAfter) {
      best = start.mode === mode ? earlier(best, start) : best;
    }
  }
  for (const start of timetable.calendar[mode]) {
    if (best !== null && start.baseEpoch > best.baseEpoch + best.startS) {
      break;
    }
    best = start.serviceDate > lastRunningDate ? earlier(best, start) : best;
  }
  invariant(best === null || best.mode === mode, 'the next start is a trip of this mode');
  invariant(best === null || best.baseEpoch + best.startS > epoch, 'the next start lies after the instant');
  return best === null ? null : { epoch: best.baseEpoch + best.startS, serviceDate: best.serviceDate, serviceSec: best.startS };
}

/** The earlier of two starts (the first on a tie); null counts as never. */
function earlier(a: ModeStart | null, b: ModeStart): ModeStart {
  invariant(Number.isSafeInteger(b.baseEpoch + b.startS), 'a start is a whole epoch second');
  invariant(a === null || a.mode === b.mode, 'starts of one mode are compared');
  return a === null || b.baseEpoch + b.startS < a.baseEpoch + a.startS ? b : a;
}
