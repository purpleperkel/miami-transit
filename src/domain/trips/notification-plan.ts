import { invariant } from '../../lib/invariant';

/**
 * Plan M7.4 "Reminder plan (idempotent diff)": which "leave now" reminders should be pending, and
 * the smallest change that gets the phone's pending set there. Pure — the notification service
 * (M7.5, src/ui/trips/notifications.ts) applies the diff through expo-notifications, using each
 * reminder's `id` as the notification identifier.
 *
 *   candidates (saved trip × upcoming ride, with its leave-by)
 *     → planReminders: future, within REMINDER_HORIZON_S, one per id, soonest MAX_PENDING_REMINDERS
 *     → diffReminders(desired, pending): schedule what is new or changed, cancel what is gone or changed
 *
 * The plan is a function of its inputs only, so re-planning after the diff is applied asks for
 * nothing (plan R14: reminders are rescheduled each time the app opens, over a 7-day horizon).
 */

/** iOS keeps at most 64 pending local notifications per app; the plan leaves 4 spare. */
export const MAX_PENDING_REMINDERS = 60;
/** Reminders are planned at most this far ahead (plan R14: a 7-day horizon, refreshed on open). */
export const REMINDER_HORIZON_S = 7 * 24 * 60 * 60;

/** One ride of one saved trip that could earn a reminder. */
export type ReminderCandidate = {
  readonly tripId: string;
  readonly tripName: string;
  readonly departureEpoch: number;
  /** From src/domain/trips/leave-by.ts: departure − walk − buffer. */
  readonly leaveByEpoch: number;
};

export type Reminder = ReminderCandidate & {
  /** reminderId(tripId, departureEpoch): one reminder per trip per departure. */
  readonly id: string;
  /** When the notification fires: the leave-by, minus the lead. */
  readonly fireEpoch: number;
};

export type ReminderDiff = {
  /** Reminders to schedule (new, or changed since they were scheduled), in firing order. */
  readonly schedule: readonly Reminder[];
  /** Identifiers of pending reminders to cancel (gone from the plan, or changed), in id order. */
  readonly cancel: readonly string[];
};

/** Trip ids are saved-trip ids (src/data/saved-trips-repo.ts): no ':' — the id's separator. */
const TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The identifier of a trip's reminder for one departure. */
export function reminderId(tripId: string, departureEpoch: number): string {
  invariant(TRIP_ID.test(tripId), `"${tripId}" is a saved-trip id`);
  invariant(Number.isSafeInteger(departureEpoch), `a departure is a whole epoch second, got ${departureEpoch}`);
  return `leave:${tripId}:${departureEpoch}`;
}

/**
 * The reminders that should be pending at `now`: each candidate fires `leadS` before its leave-by;
 * only those firing after `now` and within REMINDER_HORIZON_S count; one per id (the earliest
 * firing); the soonest MAX_PENDING_REMINDERS, in firing order (ties by id).
 */
export function planReminders(now: number, candidates: readonly ReminderCandidate[], leadS = 0): Reminder[] {
  invariant(Number.isSafeInteger(now), `now is a whole epoch second, got ${now}`);
  invariant(Number.isSafeInteger(leadS) && leadS >= 0, `a reminder lead is whole, non-negative seconds, got ${leadS}`);
  const byId = new Map<string, Reminder>();
  for (const candidate of candidates) {
    const reminder = toReminder(candidate, leadS);
    const held = byId.get(reminder.id);
    const inHorizon = reminder.fireEpoch > now && reminder.fireEpoch <= now + REMINDER_HORIZON_S;
    if (inHorizon && (held === undefined || reminder.fireEpoch < held.fireEpoch)) {
      byId.set(reminder.id, reminder);
    }
  }
  const plan = [...byId.values()].sort(byFiring).slice(0, MAX_PENDING_REMINDERS);
  invariant(plan.length <= MAX_PENDING_REMINDERS, 'the plan never overfills the pending list');
  invariant(plan.every((r) => r.fireEpoch > now && r.fireEpoch <= now + REMINDER_HORIZON_S), 'every planned reminder fires within the horizon');
  return plan;
}

/**
 * What to change so the pending reminders become `desired`: schedule every desired reminder that is
 * not pending exactly as planned, and cancel every pending one that is not wanted exactly as is
 * (a changed reminder is cancelled and scheduled again under its id). Pending == desired → empty.
 */
export function diffReminders(desired: readonly Reminder[], pending: readonly Reminder[]): ReminderDiff {
  const wanted = uniqueById(desired, 'the desired reminders');
  const held = uniqueById(pending, 'the pending reminders');
  const schedule = desired.filter((r) => !sameReminder(r, held.get(r.id)));
  const cancel = pending
    .filter((r) => !sameReminder(r, wanted.get(r.id)))
    .map((r) => r.id)
    .sort();
  invariant(schedule.every((r) => wanted.has(r.id)), 'only desired reminders are scheduled');
  invariant(cancel.every((id) => held.has(id)), 'only pending reminders are cancelled');
  return { schedule, cancel };
}

function toReminder(candidate: ReminderCandidate, leadS: number): Reminder {
  invariant(Number.isSafeInteger(candidate.leaveByEpoch), 'a leave-by is a whole epoch second');
  invariant(candidate.leaveByEpoch <= candidate.departureEpoch, `trip ${candidate.tripId} leaves before its train does`);
  return {
    tripId: candidate.tripId,
    tripName: candidate.tripName,
    departureEpoch: candidate.departureEpoch,
    leaveByEpoch: candidate.leaveByEpoch,
    id: reminderId(candidate.tripId, candidate.departureEpoch),
    fireEpoch: candidate.leaveByEpoch - leadS,
  };
}

function byFiring(a: Reminder, b: Reminder): number {
  invariant(a.id.length > 0 && b.id.length > 0, 'reminders carry ids');
  invariant(a === b || a.id !== b.id, 'the plan holds one reminder per id');
  return a.fireEpoch - b.fireEpoch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function uniqueById(reminders: readonly Reminder[], what: string): Map<string, Reminder> {
  const byId = new Map(reminders.map((r) => [r.id, r] as const));
  invariant(byId.size === reminders.length, `${what} have no duplicate ids`);
  invariant(reminders.every((r) => r.id === reminderId(r.tripId, r.departureEpoch)), `${what} are keyed by trip and departure`);
  return byId;
}

/** True when `b` is the same reminder as `a`, field for field (undefined: no such reminder). */
function sameReminder(a: Reminder, b: Reminder | undefined): boolean {
  invariant(a.id.length > 0, 'a reminder has an id');
  invariant(b === undefined || b.id === a.id, 'only reminders under one id are compared');
  return (
    b !== undefined &&
    a.tripId === b.tripId &&
    a.tripName === b.tripName &&
    a.departureEpoch === b.departureEpoch &&
    a.leaveByEpoch === b.leaveByEpoch &&
    a.fireEpoch === b.fireEpoch
  );
}
