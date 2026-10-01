import { InvariantError } from '../../../lib/invariant';
import { providerConfig } from '../constants';
import {
  backoffS,
  createScheduler,
  dueTasks,
  finishPoll,
  type PollOutcome,
  resumeAll,
  type SchedulerState,
  startPoll,
  syncTasks,
} from '../scheduler';

/** M4.5: the poll scheduler, driven by hand-advanced epoch seconds (no clock, no timers). */

const T0 = 1_790_872_200;
const SWIFTLY = { id: 'vehicles', cadenceS: providerConfig('swiftly').cadenceS };
const TRANSITLAND = { id: 'vehicles', cadenceS: providerConfig('transitland').cadenceS };

/** One poll of `id` that starts at `at`, takes `tookS`, and ends with `outcome`. */
function poll(state: SchedulerState, id: string, at: number, outcome: PollOutcome, tookS = 1): SchedulerState {
  expect(dueTasks(state, at)).toContain(id);
  const ended = finishPoll(startPoll(state, id, at), id, outcome, at + tookS);
  expect(ended.get(id)?.inFlight).toBe(false);
  return ended;
}

/** The waits (s) after each outcome in turn, polling each time the task falls due. */
function waits(task: { id: string; cadenceS: number }, outcomes: readonly PollOutcome[]): number[] {
  let state = createScheduler([task], T0);
  let now = T0;
  const seen: number[] = [];
  for (const outcome of outcomes) {
    state = poll(state, task.id, now, outcome, 0);
    const dueAt = state.get(task.id)?.dueAt ?? Number.NaN;
    seen.push(dueAt - now);
    now = dueAt;
  }
  expect(seen).toHaveLength(outcomes.length);
  expect(seen.every((w) => Number.isFinite(w))).toBe(true);
  return seen;
}

describe('poll scheduler (M4.5): overlap', () => {
  it('never overlaps: a poll in flight is not due again however late it runs, and cannot be started twice', () => {
    const started = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0);
    for (const later of [T0 + 30, T0 + 60, T0 + 600]) {
      expect(dueTasks(started, later)).toEqual([]);
    }
    expect(() => startPoll(started, 'vehicles', T0 + 600)).toThrow(InvariantError);
    const finished = finishPoll(started, 'vehicles', 'ok', T0 + 65);
    expect(dueTasks(finished, T0 + 94)).toEqual([]);
    expect(dueTasks(finished, T0 + 95)).toEqual(['vehicles']);
  });

  it('never overlaps: a poll is never started early, and tasks run independently of each other', () => {
    const state = createScheduler([SWIFTLY, { id: 'predictions:rail:government-ctr', cadenceS: 60 }], T0);
    const vehiclesInFlight = startPoll(state, 'vehicles', T0);
    expect(dueTasks(vehiclesInFlight, T0)).toEqual(['predictions:rail:government-ctr']);
    const afterOk = finishPoll(vehiclesInFlight, 'vehicles', 'ok', T0 + 1);
    expect(() => startPoll(afterOk, 'vehicles', T0 + 30)).toThrow(InvariantError);
  });
});

describe('poll scheduler (M4.5): backoff', () => {
  it('backoff 15->30->60->120 s, and stays capped at 120', () => {
    expect([1, 2, 3, 4].map((failures) => backoffS(failures))).toEqual([15, 30, 60, 120]);
    expect([5, 6, 10, 1_000, Number.MAX_SAFE_INTEGER].map((failures) => backoffS(failures))).toEqual([120, 120, 120, 120, 120]);
    expect(() => backoffS(0)).toThrow(InvariantError);
  });

  it('retries never faster than the provider cadence: Swiftly 30,30,60,120 s; Transitland 60,60,60,120 s', () => {
    const fourFailures: PollOutcome[] = ['failed', 'failed', 'failed', 'failed'];
    expect(waits(SWIFTLY, fourFailures)).toEqual([30, 30, 60, 120]);
    expect(waits(TRANSITLAND, fourFailures)).toEqual([60, 60, 60, 120]);
    expect(waits(SWIFTLY, [...fourFailures, 'failed', 'failed', 'ok'])).toEqual([30, 30, 60, 120, 120, 120, 30]);
  });

  it('a success resets the backoff to the cadence; the cadence counts from the end of the poll', () => {
    expect(waits(SWIFTLY, ['ok', 'ok', 'failed', 'ok', 'failed'])).toEqual([30, 30, 30, 30, 30]);
    const slow = poll(createScheduler([TRANSITLAND], T0), 'vehicles', T0, 'ok', 7);
    expect(slow.get('vehicles')?.dueAt).toBe(T0 + 7 + 60);
  });

  it('429 doubles the interval (within the 120 s cap); a success restores the cadence', () => {
    expect(waits(SWIFTLY, ['rate-limited', 'rate-limited', 'rate-limited', 'ok'])).toEqual([60, 120, 120, 30]);
    expect(waits(TRANSITLAND, ['rate-limited', 'rate-limited'])).toEqual([120, 120]);
    expect(waits(SWIFTLY, ['failed', 'failed', 'failed', 'rate-limited'])).toEqual([30, 30, 60, 120]);
  });
});

describe('poll scheduler (M4.5): background and task changes', () => {
  it('due on resume: after the background, every idle task is due at once; a poll in flight stays in flight', () => {
    let state = createScheduler([SWIFTLY, { id: 'predictions:mover:government-center', cadenceS: 60 }, { id: 'predictions:rail:brickell', cadenceS: 60 }], T0);
    state = poll(state, 'vehicles', T0, 'failed');
    state = poll(state, 'predictions:mover:government-center', T0, 'ok');
    state = startPoll(state, 'predictions:rail:brickell', T0);
    const resumed = resumeAll(state, T0 + 600);
    expect(dueTasks(state, T0 + 20)).toEqual([]);
    expect(dueTasks(resumed, T0 + 600)).toEqual(['predictions:mover:government-center', 'vehicles']);
    expect(resumed.get('predictions:rail:brickell')?.inFlight).toBe(true);
  });

  it('due on resume, but never sooner than one cadence after the previous poll started (Swiftly\'s 30 s rule)', () => {
    const polled = poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'rate-limited');
    const quickReturn = resumeAll(polled, T0 + 10);
    expect(dueTasks(quickReturn, T0 + 10)).toEqual([]);
    expect(quickReturn.get('vehicles')?.dueAt).toBe(T0 + 30);
    expect(dueTasks(resumeAll(createScheduler([SWIFTLY], T0), T0 + 5), T0 + 5)).toEqual(['vehicles']);
  });

  it('syncTasks keeps known tasks, adds new ones due now, and forgets dropped ones (even mid-poll)', () => {
    const state = startPoll(poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'ok'), 'vehicles', T0 + 31);
    const synced = syncTasks(state, [{ id: 'predictions:rail:brickell', cadenceS: 60 }], T0 + 40);
    expect([...synced.keys()]).toEqual(['predictions:rail:brickell']);
    expect(dueTasks(synced, T0 + 40)).toEqual(['predictions:rail:brickell']);
    expect(finishPoll(synced, 'vehicles', 'ok', T0 + 41)).toBe(synced);
    expect(syncTasks(state, [SWIFTLY], T0 + 40).get('vehicles')).toEqual(state.get('vehicles'));
    expect(syncTasks(state, [{ id: 'vehicles', cadenceS: 60 }], T0 + 40).get('vehicles')).toMatchObject({ cadenceS: 60, inFlight: true });
  });
});
