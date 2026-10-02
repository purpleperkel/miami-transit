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
 *  - A poll that counts for nothing (mfix10: its provider no longer stood keyed when it ended — held
 *    back by the Wi-Fi gate, or its key removed) is RELEASED, not finished: the task is idle again one
 *    interval on, its failures and interval as they were.
 *  - A task can START OVER (mfix10 fix round 3, R4: its provider's key changed, so its next poll is a
 *    new request that owes nothing to the old key's backoff or cadence): it is due at once, with no
 *    failures and no previous start, as a new task would be.
 *  - A poll the provider's FLOOR TURNED AWAY (mfix10 fix round 4, S2: the provider handed back a
 *    download another poll started, a success) is due again the moment that floor ends — no request
 *    could bring fresher data sooner, and waiting a cadence from now would leave the data a cadence
 *    staler than it has to be. A failure handed back that way is an ordinary failure here (R-b's backoff).
 *    A FLOOR-WAIT (fix round 6, U2: the floor turned the poll away with nothing to hand back, the
 *    download it would have shared having ended aborted) is due then too, but it is no success: the
 *    task's failures and interval stay as they were.
 *  - A poll INTERRUPTED by leaving the foreground (fix round 6, U1: the runtime aborted it) changes
 *    nothing: the task is idle again with its failures, interval and last start as they were (the
 *    interrupted poll's start), due as a resume makes it — so it is neither a failure nor a fresh start.
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
  /**
   * Epoch second the latest poll started, or null before the first — for a poll the provider's floor
   * turned away, when the download it was handed started (finishReusedPoll).
   */
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
 * Ends at `nowS` a poll the provider's floor turned away: it was handed the download another poll
 * started (a success), whose floor ends at `floorEndsAtS`. The task is due THEN — not a cadence after
 * now — with no failures, its interval its cadence; and its last start moves to the download's
 * (floorEndsAtS − cadence), so a resume's "never sooner than one cadence after the last start" also
 * lands on the floor's end. A task dropped meanwhile stays dropped.
 */
export function finishReusedPoll(state: SchedulerState, id: string, nowS: number, floorEndsAtS: number): SchedulerState {
  const next = turnAway(state, id, nowS, floorEndsAtS, 'ok');
  const task = next.get(id);
  invariant(task === undefined || (task.failures === 0 && task.intervalS === task.cadenceS), `task ${id} ends as after a success: no failures, its interval its cadence`);
  invariant(task === undefined || task.dueAt === floorEndsAtS, `task ${id} is due when the floor ends`);
  return next;
}

/**
 * Ends at `nowS` a poll the provider's floor turned away with NOTHING to hand back (mfix10 fix round
 * 6, U2, a floor-wait: the download it would have shared ended aborted), whose floor ends at
 * `floorEndsAtS`. No data and no failure: the task is due when the floor ends, with its failures and
 * interval as they were (no backoff grows from it); its last start moves to the download's, as for
 * finishReusedPoll, so a resume lands on the floor's end too. A task dropped meanwhile stays dropped.
 */
export function finishFloorWait(state: SchedulerState, id: string, nowS: number, floorEndsAtS: number): SchedulerState {
  const [before, next] = [state.get(id), turnAway(state, id, nowS, floorEndsAtS, 'floor-wait')];
  const task = next.get(id);
  invariant(task === undefined || (task.failures === before?.failures && task.intervalS === before.intervalS), `task ${id} keeps its failures and interval: a floor-wait is no failure and no success`);
  invariant(task === undefined || task.dueAt === floorEndsAtS, `task ${id} is due when the floor ends`);
  return next;
}

/** Ends a poll the provider's floor turned away: due when the floor ends, its last start the download's; a success also clears the failures. */
function turnAway(state: SchedulerState, id: string, nowS: number, floorEndsAtS: number, outcome: 'ok' | 'floor-wait'): SchedulerState {
  invariant(Number.isFinite(nowS) && Number.isFinite(floorEndsAtS), 'a turned-away poll ends at an instant, and its floor ends at one');
  const task = state.get(id);
  if (task === undefined) {
    return state; // the task was dropped (syncTasks) while its poll was in flight
  }
  invariant(task.inFlight && task.lastStartedAt !== null && nowS >= task.lastStartedAt, `task ${id} was in flight since before ${nowS}`);
  invariant(floorEndsAtS - task.cadenceS <= nowS, `task ${id} was handed a download that started before now (its floor ends at most one cadence on)`);
  const success = outcome === 'ok' ? { failures: 0, intervalS: task.cadenceS } : {};
  return new Map(state).set(id, { ...task, inFlight: false, ...success, dueAt: floorEndsAtS, lastStartedAt: floorEndsAtS - task.cadenceS });
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

/**
 * An idle task starts over at `nowS`, as a new task would (its provider's key changed): due now, no
 * failures, its interval its cadence, no previous start. A task in flight is left as it is (it starts
 * over when its poll ends), and a task dropped meanwhile stays dropped.
 */
export function restartTask(state: SchedulerState, id: string, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'a task starts over at an instant');
  const task = state.get(id);
  if (task === undefined || task.inFlight) {
    return state;
  }
  invariant(task.lastStartedAt === null || nowS >= task.lastStartedAt, `task ${id} starts over no earlier than its last poll started`);
  return new Map(state).set(id, { ...task, dueAt: nowS, failures: 0, intervalS: task.cadenceS, lastStartedAt: null });
}

/**
 * Ends at `nowS` a poll that leaving the foreground INTERRUPTED (mfix10 fix round 6, U1: the runtime
 * aborted it). It counts for nothing and changes nothing: the task is idle with its failures, interval
 * and last start (the interrupted poll's own) as they were, due as a resume makes it — one cadence
 * after that start, or now if later. So an interrupted retry keeps its backoff, and the request it
 * aborted is not repeated sooner than R-b allows. A task dropped meanwhile stays dropped.
 */
export function interruptPoll(state: SchedulerState, id: string, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'a poll ends at an instant');
  const task = state.get(id);
  if (task === undefined) {
    return state; // the task was dropped (syncTasks) while its poll was in flight
  }
  invariant(task.inFlight && task.lastStartedAt !== null && nowS >= task.lastStartedAt, `task ${id} was in flight since before ${nowS}`);
  const idle: TaskState = { ...task, inFlight: false };
  const interrupted: TaskState = { ...idle, dueAt: resumedDueAt(idle, nowS) };
  invariant(interrupted.failures === task.failures && interrupted.lastStartedAt === task.lastStartedAt, `task ${id} keeps its failures and its last start`);
  return new Map(state).set(id, interrupted);
}

/**
 * Back from the background at `nowS`: every idle task is due now, or one cadence after its last poll
 * started if that is later. A task still in flight is left as it is: the runtime aborts every poll in
 * flight as the app leaves the foreground (mfix10 fix round 5), so such a poll has not ended yet; when
 * it does, its task is due as a resume makes it (interruptPoll, fix round 6).
 */
export function resumeAll(state: SchedulerState, nowS: number): SchedulerState {
  invariant(Number.isFinite(nowS), 'the app resumes at an instant');
  const next = new Map<string, TaskState>();
  for (const [id, task] of state) {
    next.set(id, task.inFlight ? task : { ...task, dueAt: resumedDueAt(task, nowS) });
  }
  invariant(next.size === state.size, 'resuming keeps every task');
  return next;
}

/** When an idle task is due after a resume at `nowS`: now, or one cadence after its last poll started if that is later (R-b). */
function resumedDueAt(task: TaskState, nowS: number): number {
  invariant(!task.inFlight, `task ${task.id} is idle: a poll in flight is due again only when it ends`);
  const dueAt = task.lastStartedAt === null ? nowS : Math.max(nowS, task.lastStartedAt + task.cadenceS);
  invariant(dueAt >= nowS && (task.lastStartedAt === null || dueAt >= task.lastStartedAt + task.cadenceS), `task ${task.id} is due no sooner than now, nor than a cadence after its last start`);
  return dueAt;
}
