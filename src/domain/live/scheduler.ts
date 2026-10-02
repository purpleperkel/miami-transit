import { invariant } from '../../lib/invariant';
import { BACKOFF_CAP_S, BACKOFF_FIRST_S } from './constants';

/**
 * Plan M4.5 / §4 Polling: when each live poll is due. Pure — the runtime's 1 s heartbeat (M4.9) asks
 * `dueTasks`, starts those polls, and reports each outcome; this module never touches a clock.
 *
 *  - A task polls at its provider's cadence (Swiftly 30 s, Transitland 60 s), measured from the end
 *    of the previous poll.
 *  - Polls of one task NEVER overlap: a task in flight is never due, and starting it again is a bug.
 *  - A failure backs off 15 → 30 → 60 → 120 s (×2 per failure, capped at 120 s) — `backoffS`.
 *  - A 429 (rate limited) doubles the task's current interval, within the same 120 s cap.
 *  - Arbiter ruling R-b (2026-10-01): a retry is NEVER sooner than the provider's cadence — the next
 *    delay after a failure is max(cadence, backoffS(failures)) — so Swiftly's binding "cache GTFS-rt
 *    for at least 30 s" and Transitland's monthly quota both hold. Swiftly retries at 30, 30, 60,
 *    120 s; Transitland at 60, 60, 60, 120 s.
 *  - After the app was in the background, every task is due on resume — but, in the same spirit as
 *    R-b, never sooner than one cadence after its previous poll started (a 10 s trip to another app
 *    does not buy Swiftly an early poll).
 *  - A poll that counts for nothing (mfix10: its provider was held back by the Wi-Fi gate when it
 *    ended, or its failure was reused from a download another poll started) is RELEASED, not
 *    finished: the task is idle again one interval on, its failures and interval as they were.
 */

export type PollOutcome = 'ok' | 'failed' | 'rate-limited';

export type PollTask = { readonly id: string; readonly cadenceS: number };

export type TaskState = {
  readonly id: string;
  readonly cadenceS: number;
  /** Epoch second the next poll is due. */
  readonly dueAt: number;
  readonly inFlight: boolean;
  /** Consecutive failed polls (a 429 counts as one); 0 after a success. */
  readonly failures: number;
  /** The wait that set `dueAt`: the cadence after a success, a backoff after a failure. */
  readonly intervalS: number;
  /** Epoch second the latest poll started, or null before the first. */
  readonly lastStartedAt: number | null;
};

/** Every task by id, in the order tasks were first added. */
export type SchedulerState = ReadonlyMap<string, TaskState>;

/** The raw failure backoff (s) after `failures` consecutive failures: 15, 30, 60, 120, 120, … */
export function backoffS(failures: number): number {
  invariant(Number.isSafeInteger(failures) && failures >= 1, `backoff follows at least one failure, got ${failures}`);
  const doublings = Math.min(failures - 1, Math.ceil(Math.log2(BACKOFF_CAP_S / BACKOFF_FIRST_S)));
  const delay = Math.min(BACKOFF_CAP_S, BACKOFF_FIRST_S * 2 ** doublings);
  invariant(delay >= BACKOFF_FIRST_S && delay <= BACKOFF_CAP_S, 'a backoff lies within 15..120 s');
  return delay;
}

/** The wait before a task's next poll after `outcome`, and its failure count then (R-b: never under the cadence). */
export function nextWait(task: TaskState, outcome: PollOutcome): { readonly delayS: number; readonly failures: number } {
  invariant(task.cadenceS > 0 && task.cadenceS <= BACKOFF_CAP_S, `task ${task.id} polls at a cadence within the cap`);
  const failures = outcome === 'ok' ? 0 : task.failures + 1;
  const delayS =
    outcome === 'ok'
      ? task.cadenceS
      : outcome === 'rate-limited'
        ? Math.min(BACKOFF_CAP_S, 2 * task.intervalS)
        : Math.max(task.cadenceS, backoffS(failures));
  invariant(delayS >= task.cadenceS && delayS <= BACKOFF_CAP_S, `task ${task.id} waits between its cadence and the cap, got ${delayS}`);
  return { delayS, failures };
}

/** A scheduler whose every task is due at `nowS` (the first poll happens right away). */
export function createScheduler(tasks: readonly PollTask[], nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'a scheduler starts at an instant');
  const state = syncTasks(new Map(), tasks, nowS);
  invariant(state.size === tasks.length, 'every task is scheduled once');
  return state;
}

/**
 * The scheduler for a new task list (e.g. the stations on screen changed): kept tasks keep their
 * state (and take a changed cadence from their next poll on), new tasks are due at `nowS`, and
 * dropped tasks are forgotten — a poll still in flight for one is ignored when it ends.
 */
export function syncTasks(state: SchedulerState, tasks: readonly PollTask[], nowS: number): SchedulerState {
  invariant(new Set(tasks.map((t) => t.id)).size === tasks.length, 'task ids are unique');
  invariant(tasks.every((t) => t.cadenceS > 0 && t.cadenceS <= BACKOFF_CAP_S), 'every cadence lies within the backoff cap');
  const next = new Map<string, TaskState>();
  for (const { id, cadenceS } of tasks) {
    const kept = state.get(id);
    next.set(id, kept === undefined ? { id, cadenceS, dueAt: nowS, inFlight: false, failures: 0, intervalS: cadenceS, lastStartedAt: null } : { ...kept, cadenceS });
  }
  return next;
}

/** The ids of tasks due at `nowS`: idle, with dueAt ≤ now — earliest due first, then by id. */
export function dueTasks(state: SchedulerState, nowS: number): string[] {
  invariant(Number.isFinite(nowS), 'due-ness is asked at an instant');
  const due = [...state.values()].filter((task) => !task.inFlight && task.dueAt <= nowS);
  due.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  invariant(due.every((task) => !task.inFlight), 'a task in flight is never due (polls never overlap)');
  return due.map((task) => task.id);
}

/** Marks a due task's poll as started at `nowS`. Starting a task in flight, or before it is due, is a bug. */
export function startPoll(state: SchedulerState, id: string, nowS: number): SchedulerState {
  const task = state.get(id);
  invariant(task !== undefined, `task ${id} is scheduled`);
  invariant(!task.inFlight && task.dueAt <= nowS, `task ${id} is idle and due (polls never overlap, never come early)`);
  return new Map(state).set(id, { ...task, inFlight: true, lastStartedAt: nowS });
}

/** Records how a poll ended at `nowS` and schedules the task's next one. A task dropped meanwhile stays dropped. */
export function finishPoll(state: SchedulerState, id: string, outcome: PollOutcome, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'a poll ends at an instant');
  const task = state.get(id);
  if (task === undefined) {
    return state; // the task was dropped (syncTasks) while its poll was in flight
  }
  invariant(task.inFlight && task.lastStartedAt !== null && nowS >= task.lastStartedAt, `task ${id} was in flight since before ${nowS}`);
  const { delayS, failures } = nextWait(task, outcome);
  return new Map(state).set(id, { ...task, inFlight: false, failures, intervalS: delayS, dueAt: nowS + delayS });
}

/**
 * Ends a poll at `nowS` that counts for nothing: the task is idle again, due one interval later, with
 * its failure count and interval as they were (no backoff grows from it). A task dropped meanwhile
 * stays dropped.
 */
export function releasePoll(state: SchedulerState, id: string, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'a poll ends at an instant');
  const task = state.get(id);
  if (task === undefined) {
    return state; // the task was dropped (syncTasks) while its poll was in flight
  }
  invariant(task.inFlight && task.lastStartedAt !== null && nowS >= task.lastStartedAt, `task ${id} was in flight since before ${nowS}`);
  return new Map(state).set(id, { ...task, inFlight: false, dueAt: nowS + task.intervalS });
}

/** Back from the background at `nowS`: every idle task is due now, or one cadence after its last poll started if that is later. */
export function resumeAll(state: SchedulerState, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'the app resumes at an instant');
  const next = new Map<string, TaskState>();
  for (const [id, task] of state) {
    const floor = task.lastStartedAt === null ? nowS : Math.max(nowS, task.lastStartedAt + task.cadenceS);
    next.set(id, task.inFlight ? task : { ...task, dueAt: floor });
  }
  invariant(next.size === state.size, 'resuming keeps every task');
  return next;
}
