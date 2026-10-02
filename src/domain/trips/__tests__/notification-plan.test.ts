import {
  diffReminders,
  MAX_PENDING_REMINDERS,
  planReminders,
  type Reminder,
  type ReminderCandidate,
  type ReminderDiff,
  REMINDER_HORIZON_S,
  reminderId,
} from '../notification-plan';

/** Wed 2026-09-30 00:00 EDT. */
const NOW = 1_790_740_800;
const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;
const TRIPS = [
  { tripId: 'work', tripName: 'Work' },
  { tripId: 'gym', tripName: 'Gym' },
  { tripId: 'home-2', tripName: 'Home' },
] as const;

/**
 * 8 days × 3 trips × 4 departures (07, 08, 17, 18 h, a minute apart per trip), leaving 10 min before
 * each: 84 candidates inside the 7-day horizon (> 60), 12 beyond it, plus one already past and five
 * repeats of earlier candidates.
 */
function fixture(): ReminderCandidate[] {
  const candidates: ReminderCandidate[] = [];
  for (let day = 0; day < 8; day += 1) {
    for (const [t, trip] of TRIPS.entries()) {
      for (const hour of [7, 8, 17, 18]) {
        const departureEpoch = NOW + day * DAY + hour * HOUR + t * 60;
        candidates.push({ ...trip, departureEpoch, leaveByEpoch: departureEpoch - 600 });
      }
    }
  }
  candidates.push({ ...TRIPS[0], departureEpoch: NOW + 300, leaveByEpoch: NOW - 300 });
  candidates.push(...candidates.slice(0, 5));
  expect(candidates.filter((c) => c.leaveByEpoch > NOW && c.leaveByEpoch <= NOW + REMINDER_HORIZON_S).length).toBeGreaterThan(60);
  expect(candidates.length).toBe(8 * 3 * 4 + 1 + 5);
  return candidates;
}

/** What the notification service leaves pending after applying `diff` to `pending`. */
function applied(pending: readonly Reminder[], diff: ReminderDiff): Reminder[] {
  const cancelled = new Set(diff.cancel);
  const next = [...pending.filter((r) => !cancelled.has(r.id)), ...diff.schedule];
  expect(new Set(next.map((r) => r.id)).size).toBe(next.length);
  expect(next.length).toBeLessThanOrEqual(pending.length + diff.schedule.length);
  return next;
}

describe('reminder plan (M7.4)', () => {
  it('at most 60 pending: of 84 candidates in the horizon, the 60 that fire soonest', () => {
    const plan = planReminders(NOW, fixture());
    expect(MAX_PENDING_REMINDERS).toBe(60);
    expect(plan).toHaveLength(60);
    expect(plan.every((r, i) => i === 0 || plan[i - 1]!.fireEpoch <= r.fireEpoch)).toBe(true);
    expect(plan[plan.length - 1]!.fireEpoch).toBeLessThanOrEqual(NOW + 5 * DAY + 18 * HOUR);
  });

  it('every reminder within 7 days, and none already in the past', () => {
    const plan = planReminders(NOW, fixture());
    expect(plan.every((r) => r.fireEpoch > NOW && r.fireEpoch <= NOW + 7 * DAY)).toBe(true);
    expect(planReminders(NOW + 6 * DAY, fixture()).every((r) => r.fireEpoch <= NOW + 13 * DAY)).toBe(true);
    expect(planReminders(NOW + 6 * DAY, fixture()).some((r) => r.fireEpoch > NOW + 7 * DAY)).toBe(true);
  });

  it('no duplicate ids, though five of the soonest candidates repeat', () => {
    const candidates = fixture();
    const candidateIds = candidates.map((c) => reminderId(c.tripId, c.departureEpoch));
    expect(new Set(candidateIds).size).toBe(candidateIds.length - 5);
    const plan = planReminders(NOW, candidates);
    expect(new Set(plan.map((r) => r.id)).size).toBe(plan.length);
    expect(plan.every((r) => r.id === reminderId(r.tripId, r.departureEpoch))).toBe(true);
  });

  it('re-applying the plan -> empty diff', () => {
    const plan = planReminders(NOW, fixture());
    const first = diffReminders(plan, []);
    expect(first.schedule).toHaveLength(60);
    expect(first.cancel).toEqual([]);
    const pending = applied([], first);
    expect(diffReminders(planReminders(NOW, fixture()), pending)).toEqual({ schedule: [], cancel: [] });
  });
});

describe('reminder plan changes (M7.4)', () => {
  it('a later plan cancels the reminders that fired or fell out and schedules the newly due ones', () => {
    const pending = applied([], diffReminders(planReminders(NOW, fixture()), []));
    const later = planReminders(NOW + DAY, fixture());
    const diff = diffReminders(later, pending);
    expect(diff.cancel.length).toBeGreaterThan(0);
    expect(diff.schedule.length).toBe(diff.cancel.length);
    expect(applied(pending, diff).map((r) => r.id).sort()).toEqual(later.map((r) => r.id).sort());
  });

  it('a renamed trip or a moved leave-by is cancelled and scheduled again under the same id', () => {
    const plan = planReminders(NOW, fixture());
    const changed = plan.map((r, i) => (i === 0 ? { ...r, tripName: 'Office' } : i === 1 ? { ...r, fireEpoch: r.fireEpoch - 60 } : r));
    const diff = diffReminders(changed, plan);
    expect(diff.cancel).toEqual([plan[0]!.id, plan[1]!.id].sort());
    expect(diff.schedule.map((r) => r.id)).toEqual([plan[0]!.id, plan[1]!.id]);
  });

  it('a lead fires each reminder that much before its leave-by', () => {
    const [noLead] = planReminders(NOW, fixture());
    const [fiveMin] = planReminders(NOW, fixture(), 300);
    expect(noLead!.fireEpoch).toBe(noLead!.leaveByEpoch);
    expect(fiveMin!.fireEpoch).toBe(fiveMin!.leaveByEpoch - 300);
  });

  it('pending reminders with a repeated id are refused, not silently merged', () => {
    const plan = planReminders(NOW, fixture());
    expect(() => diffReminders(plan, [plan[0]!, plan[0]!])).toThrow(/duplicate ids/);
    expect(() => reminderId('has:colon', NOW)).toThrow(/saved-trip id/);
  });
});
