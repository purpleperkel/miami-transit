import { InvariantError } from '../../../lib/invariant';
import { providerConfig } from '../constants';
import {
  backoffS,
  createScheduler,
  dueTasks,
  finishFloorWait,
  finishPoll,
  finishReusedPoll,
  interruptPoll,
  type PollOutcome,
  releasePoll,
  restartTask,
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

describe('poll scheduler (mfix10): a poll that counts for nothing', () => {
  it('releasePoll ends a poll with the task\'s failures and interval as they were: idle, due one interval later', () => {
    const failedTwice = poll(poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'failed', 0), 'vehicles', T0 + 30, 'failed', 0);
    const before = failedTwice.get('vehicles');
    expect([before?.failures, before?.intervalS]).toEqual([2, 30]);
    const released = releasePoll(startPoll(failedTwice, 'vehicles', T0 + 60), 'vehicles', T0 + 62);
    expect(released.get('vehicles')).toEqual({ ...before, inFlight: false, lastStartedAt: T0 + 60, dueAt: T0 + 92 });
    expect(finishPoll(startPoll(failedTwice, 'vehicles', T0 + 60), 'vehicles', 'failed', T0 + 62).get('vehicles')?.intervalS).toBe(60); // what counting it would have grown
  });

  it('releasePoll leaves a task dropped mid-poll dropped, and refuses a task that was not in flight', () => {
    const state = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0);
    const dropped = syncTasks(state, [], T0 + 1);
    expect(releasePoll(dropped, 'vehicles', T0 + 2)).toBe(dropped);
    expect(() => releasePoll(createScheduler([SWIFTLY], T0), 'vehicles', T0 + 2)).toThrow(InvariantError);
  });
});

describe('poll scheduler (mfix10): a task that starts over', () => {
  it('restartTask makes an idle task due now, as a new task would be: no failures, its interval its cadence, no previous start', () => {
    const failedTwice = poll(poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'failed', 0), 'vehicles', T0 + 30, 'failed', 0);
    expect(failedTwice.get('vehicles')).toMatchObject({ failures: 2, dueAt: T0 + 60, lastStartedAt: T0 + 30 });
    const restarted = restartTask(failedTwice, 'vehicles', T0 + 35);
    expect(restarted.get('vehicles')).toEqual({ id: 'vehicles', cadenceS: 30, dueAt: T0 + 35, inFlight: false, failures: 0, intervalS: 30, lastStartedAt: null });
    expect(failedTwice.get('vehicles')?.failures).toBe(2); // the state it was given is untouched
  });

  it('restartTask leaves a task in flight, or dropped, as it is, and refuses an instant before the task\'s last start', () => {
    const inFlight = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0 + 10);
    expect(restartTask(inFlight, 'vehicles', T0 + 11)).toBe(inFlight);
    const dropped = syncTasks(inFlight, [], T0 + 11);
    expect(restartTask(dropped, 'vehicles', T0 + 12)).toBe(dropped);
    const idle = finishPoll(inFlight, 'vehicles', 'ok', T0 + 11);
    expect(() => restartTask(idle, 'vehicles', T0 + 5)).toThrow(InvariantError);
  });
});

describe('poll scheduler (mfix10 fix round 4): a poll the provider\'s floor turned away', () => {
  it('finishReusedPoll makes the task due when the floor ends, as a success, and a resume lands there too', () => {
    const failedOnce = poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'failed', 0);
    const turnedAway = finishReusedPoll(startPoll(failedOnce, 'vehicles', T0 + 30), 'vehicles', T0 + 31, T0 + 50); // handed a download that started at T0 + 20
    expect(turnedAway.get('vehicles')).toEqual({ id: 'vehicles', cadenceS: 30, dueAt: T0 + 50, inFlight: false, failures: 0, intervalS: 30, lastStartedAt: T0 + 20 });
    expect(finishPoll(startPoll(failedOnce, 'vehicles', T0 + 30), 'vehicles', 'ok', T0 + 31).get('vehicles')?.dueAt).toBe(T0 + 61); // what a cadence after now would have been
    expect(resumeAll(turnedAway, T0 + 40).get('vehicles')?.dueAt).toBe(T0 + 50); // back from the background before the floor ends: due when it ends
  });

  it('finishReusedPoll leaves a task dropped mid-poll dropped, and refuses a floor that ends more than a cadence after now', () => {
    const inFlight = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0);
    const dropped = syncTasks(inFlight, [], T0 + 1);
    expect(finishReusedPoll(dropped, 'vehicles', T0 + 2, T0 + 20)).toBe(dropped);
    expect(() => finishReusedPoll(inFlight, 'vehicles', T0 + 2, T0 + 33)).toThrow(InvariantError);
  });
});

describe('poll scheduler (mfix10 fix round 6): a poll interrupted by leaving the foreground', () => {
  it('interruptPoll keeps the task\'s failures, interval and last start, and makes it due a cadence after that start, or now if later', () => {
    const failedFourTimes = [0, 60, 120, 180].reduce((state, atS) => poll(state, 'vehicles', T0 + atS, 'failed', 0), createScheduler([TRANSITLAND], T0));
    const before = failedFourTimes.get('vehicles');
    expect([before?.failures, before?.intervalS, before?.dueAt]).toEqual([4, 120, T0 + 300]); // R-b: Transitland's 4th failure backs off 120 s
    const inFlight = startPoll(failedFourTimes, 'vehicles', T0 + 300);
    const interrupted = interruptPoll(inFlight, 'vehicles', T0 + 305);
    expect(interrupted.get('vehicles')).toEqual({ ...before, inFlight: false, lastStartedAt: T0 + 300, dueAt: T0 + 360 });
    expect(interruptPoll(inFlight, 'vehicles', T0 + 400).get('vehicles')?.dueAt).toBe(T0 + 400); // it ended after a cadence had passed: due now
    expect(finishPoll(startPoll(interrupted, 'vehicles', T0 + 360), 'vehicles', 'failed', T0 + 361).get('vehicles')?.intervalS).toBe(120); // the next failure backs off from the 4 kept (a fresh start would wait 60 s)
  });

  it('interruptPoll leaves a task dropped mid-poll dropped, and refuses a task that was not in flight', () => {
    const state = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0);
    const dropped = syncTasks(state, [], T0 + 1);
    expect(interruptPoll(dropped, 'vehicles', T0 + 2)).toBe(dropped);
    expect(() => interruptPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0 + 2)).toThrow(InvariantError);
  });
});

describe('poll scheduler (mfix10 fix round 6): a floor-wait', () => {
  it('finishFloorWait makes the task due when the floor ends, its failures and interval kept, and a resume lands there too', () => {
    const failedTwice = poll(poll(createScheduler([SWIFTLY], T0), 'vehicles', T0, 'failed', 0), 'vehicles', T0 + 30, 'failed', 0);
    const waited = finishFloorWait(startPoll(failedTwice, 'vehicles', T0 + 60), 'vehicles', T0 + 60, T0 + 70); // turned away inside the floor of an aborted download that started at T0 + 40
    expect(waited.get('vehicles')).toEqual({ id: 'vehicles', cadenceS: 30, dueAt: T0 + 70, inFlight: false, failures: 2, intervalS: 30, lastStartedAt: T0 + 40 });
    expect(resumeAll(waited, T0 + 65).get('vehicles')?.dueAt).toBe(T0 + 70); // back from the background before the floor ends: due when it ends
    expect(finishPoll(startPoll(waited, 'vehicles', T0 + 70), 'vehicles', 'failed', T0 + 70).get('vehicles')?.intervalS).toBe(60); // a 3rd failure: R-b's 60 s, the floor-wait counted as nothing
  });

  it('finishFloorWait leaves a task dropped mid-poll dropped, and refuses a floor that ends more than a cadence after now', () => {
    const inFlight = startPoll(createScheduler([SWIFTLY], T0), 'vehicles', T0);
    const dropped = syncTasks(inFlight, [], T0 + 1);
    expect(finishFloorWait(dropped, 'vehicles', T0 + 2, T0 + 20)).toBe(dropped);
    expect(() => finishFloorWait(inFlight, 'vehicles', T0 + 2, T0 + 33)).toThrow(InvariantError);
  });
});
