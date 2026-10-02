import * as Notifications from 'expo-notifications';

import { diffReminders, type Reminder, reminderId, type ReminderDiff } from '@/domain/trips/notification-plan';
import { invariant, InvariantError } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';

import { copy } from '../copy';

/**
 * Plan M7.5: the notification service — applies M7.4's reminder plan (src/domain/trips/notification-plan.ts)
 * to the phone's pending local notifications through expo-notifications (local notifications work in Expo
 * Go, verified at M1.19). Each reminder is scheduled under its plan id as the notification `identifier`
 * (one per trip per departure), with a DATE trigger at its firing instant and the reminder itself in
 * `content.data`, so the next sync reads the pending set back as reminders and diffs against it:
 *
 *   pending (getAllScheduledNotificationsAsync, ours only: "leave:" ids)
 *     → diffReminders(desired, pending) → cancel the removed / changed ids, schedule the added / changed ones
 *
 * A pending "leave:" notification this build cannot read back (an older format) is cancelled, never kept
 * blind. Every failure of the native calls comes back as an Err with its message — nothing is dropped.
 */

/** The part of expo-notifications the service uses (tests hand in the labelled jest mock of the module). */
export type NotificationsApi = Pick<
  typeof Notifications,
  'getAllScheduledNotificationsAsync' | 'scheduleNotificationAsync' | 'cancelScheduledNotificationAsync'
>;

/** What one sync did: the plan's diff, plus any unreadable pending reminders it cancelled. */
export type AppliedReminders = ReminderDiff & { readonly unreadable: readonly string[] };

const REMINDER_ID = /^leave:/;
const DATA_KIND = 'leave-reminder';

/** Brings the pending reminders to `desired`: cancels what is gone or changed, schedules what is new or changed. */
export async function applyReminderPlan(desired: readonly Reminder[], api: NotificationsApi = Notifications): Promise<Result<AppliedReminders, string>> {
  invariant(desired.every((r) => REMINDER_ID.test(r.id)), 'every planned reminder carries a leave: id');
  invariant(typeof api.scheduleNotificationAsync === 'function', 'the service schedules through expo-notifications');
  try {
    const { readable, unreadable } = pendingReminders(await api.getAllScheduledNotificationsAsync());
    const diff = diffReminders(desired, readable);
    for (const id of [...diff.cancel, ...unreadable]) {
      await api.cancelScheduledNotificationAsync(id);
    }
    for (const reminder of diff.schedule) {
      const scheduled = await api.scheduleNotificationAsync(reminderRequest(reminder));
      invariant(scheduled === reminder.id, `expo-notifications scheduled ${reminder.id} under its own id, got ${scheduled}`);
    }
    return ok({ ...diff, unreadable });
  } catch (error) {
    if (error instanceof InvariantError) {
      throw error;
    }
    return err(`reminders could not be updated: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Our pending reminders, read back from their data; ids of ours that cannot be read. Others' notifications are left alone. */
export function pendingReminders(requests: readonly Notifications.NotificationRequest[]): { readonly readable: Reminder[]; readonly unreadable: string[] } {
  invariant(Array.isArray(requests), 'the pending notifications are a list');
  const readable: Reminder[] = [];
  const unreadable: string[] = [];
  for (const request of requests.filter((r) => REMINDER_ID.test(r.identifier))) {
    const reminder = reminderOf(request);
    if (reminder === null) {
      unreadable.push(request.identifier);
    } else {
      readable.push(reminder);
    }
  }
  invariant(readable.length + unreadable.length <= requests.length, 'only pending notifications are read');
  return { readable, unreadable };
}

/** The reminder a pending notification was scheduled for, or null when its data is not one. */
function reminderOf(request: Notifications.NotificationRequest): Reminder | null {
  invariant(REMINDER_ID.test(request.identifier), 'only our reminders are read back');
  const data: Record<string, unknown> = request.content.data ?? {};
  const { tripId, tripName, departureEpoch, leaveByEpoch, fireEpoch } = data;
  const numbers = [departureEpoch, leaveByEpoch, fireEpoch].every((n) => typeof n === 'number' && Number.isSafeInteger(n));
  if (data.kind !== DATA_KIND || typeof tripId !== 'string' || typeof tripName !== 'string' || !numbers || !/^[A-Za-z0-9_-]{1,64}$/.test(tripId)) {
    return null;
  }
  const reminder = { tripId, tripName, departureEpoch: departureEpoch as number, leaveByEpoch: leaveByEpoch as number, fireEpoch: fireEpoch as number, id: request.identifier };
  invariant(reminder.id.length > 0, 'a pending reminder has an id');
  return reminder.id === reminderId(tripId, reminder.departureEpoch) ? reminder : null;
}

/** The notification for a reminder: the trip's name, when to leave and when the train goes, firing at its instant. */
export function reminderRequest(reminder: Reminder): Notifications.NotificationRequestInput {
  invariant(reminder.fireEpoch <= reminder.leaveByEpoch && reminder.leaveByEpoch <= reminder.departureEpoch, 'a reminder fires before the leave-by, which comes before the train');
  const leaveIn = Math.round((reminder.leaveByEpoch - reminder.fireEpoch) / 60);
  const trainIn = Math.round((reminder.departureEpoch - reminder.fireEpoch) / 60);
  const data = { kind: DATA_KIND, tripId: reminder.tripId, tripName: reminder.tripName, departureEpoch: reminder.departureEpoch, leaveByEpoch: reminder.leaveByEpoch, fireEpoch: reminder.fireEpoch };
  const request: Notifications.NotificationRequestInput = {
    identifier: reminder.id,
    content: { title: reminder.tripName, body: `${copy.leaveIn(leaveIn)}: your train leaves in ${copy.minutes(trainIn)}.`, data },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminder.fireEpoch * 1000 },
  };
  invariant(request.identifier === reminder.id, 'the notification is scheduled under the reminder id');
  return request;
}

/**
 * Notification permission for reminders: asks (iOS shows its prompt the first time only) unless already
 * granted; true when reminders may alert. Asked when the rider turns reminders on in the add-trip flow.
 */
export async function allowReminders(api: Pick<typeof Notifications, 'getPermissionsAsync' | 'requestPermissionsAsync'> = Notifications): Promise<Result<boolean, string>> {
  invariant(typeof api.requestPermissionsAsync === 'function', 'expo-notifications asks for permission');
  try {
    const current = await api.getPermissionsAsync();
    const granted = current.granted || (current.canAskAgain && (await api.requestPermissionsAsync()).granted);
    invariant(typeof granted === 'boolean', 'a permission answer grants or does not');
    return ok(granted);
  } catch (error) {
    if (error instanceof InvariantError) {
      throw error;
    }
    return err(`notification permission could not be asked: ${error instanceof Error ? error.message : String(error)}`);
  }
}
