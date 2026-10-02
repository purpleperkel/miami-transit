import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { SavedTrip } from '@/data/saved-trips-repo';
import type { ScheduleRepo } from '@/data/schedule-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { TripSettings } from '@/data/settings-repo';
import { useUserDb } from '@/data/user-db-provider';
import { planReminders } from '@/domain/trips/notification-plan';
import { invariant } from '@/lib/invariant';
import { detach } from '@/live/detach';

import { wallClockNowS } from '../clock';
import { readWalkingPace } from '../settings/walking-pace';
import { applyReminderPlan, type NotificationsApi } from './notifications';
import { reminderCandidates } from './reminder-candidates';
import { REMINDER_STATUS, type ReminderStatusStore } from './reminder-status';

/**
 * Plan M7.5 + R14: the reminders are re-planned every time the app comes to the front, and whenever the
 * saved trips change — over a 7-day horizon, so a week without opening the app still reminds. Mounted
 * once, in the root layout, beside the screens; it renders nothing. Each sync plans from the schedule,
 * the trips with reminders, Jamie's walking pace and the trip settings, then applies the plan through the
 * notification service; what went wrong (if anything) goes to REMINDER_STATUS, which the Trips tab shows.
 *
 * A reminder that fires while the app is open shows as a banner too (the handler below); without it iOS
 * drops a notification for the app in front.
 */

/** What one sync reads. */
export type SyncInput = {
  readonly repo: Pick<ScheduleRepo, 'stations' | 'serviceDays' | 'tripRides'>;
  readonly trips: readonly SavedTrip[];
  readonly settings: TripSettings;
  readonly nowS: number;
};

/** The notification calls a sync makes: the service's, and the permission check. */
export type SyncApi = NotificationsApi & Pick<typeof Notifications, 'getPermissionsAsync'>;

/** Where iOS turns notifications on or off for Expo Go, which hosts this app on the phone. */
const NOTIFICATIONS_OFF = 'Notifications are off for Expo Go, so reminders will not alert. Turn them on in Settings > Notifications > Expo Go.';

/** Plans the reminders and applies the plan; the outcome (null = all good) is reported to `status`. */
export async function syncReminders(input: SyncInput, api: SyncApi = Notifications, status: ReminderStatusStore = REMINDER_STATUS): Promise<void> {
  invariant(Number.isSafeInteger(input.nowS), 'a sync runs at a whole second');
  const { walkMps } = readWalkingPace();
  const candidates = reminderCandidates(input.repo, input.trips, { nowS: input.nowS, walkMps, bufferS: input.settings.boardBufferS });
  const desired = planReminders(input.nowS, candidates, input.settings.reminderLeadS);
  const applied = await applyReminderPlan(desired, api);
  const alerts = desired.length === 0 || (await api.getPermissionsAsync()).granted;
  status.report(!applied.ok ? `Reminders could not be scheduled: ${applied.error}` : alerts ? null : NOTIFICATIONS_OFF);
  invariant(!applied.ok || applied.value.schedule.length <= desired.length, 'only planned reminders are scheduled');
}

/** Keeps the phone's pending reminders in step with the saved trips (mounted once, in the root layout). */
export function ReminderSync() {
  const user = useUserDb();
  const schedule = useScheduleDb();
  const [foregrounds, setForegrounds] = useState(0);
  useEffect(() => watchForeground(() => setForegrounds((n) => n + 1)), []);
  useEffect(
    () => (user.kind === 'ready' && schedule.kind === 'ready' ? startSync({ repo: schedule.repo, trips: user.trips, settings: user.settings, nowS: wallClockNowS() }) : undefined),
    [user, schedule, foregrounds],
  );
  invariant(foregrounds >= 0, 'foregrounds are counted');
  invariant(typeof startSync === 'function', 'the sync can start');
  return null;
}

/** Calls `onActive` each time the app comes to the front; returns the teardown. */
function watchForeground(onActive: () => void): () => void {
  invariant(typeof onActive === 'function', 'someone listens for the app coming to the front');
  showRemindersInForeground();
  const subscription = AppState.addEventListener('change', (state) => (state === 'active' ? onActive() : undefined));
  invariant(typeof subscription.remove === 'function', 'the AppState listener can be removed');
  return () => subscription.remove();
}

/** Starts one sync; a bug in it (a broken invariant) is reported, never lost. */
function startSync(input: SyncInput): void {
  invariant(input.trips.every((trip) => trip.id.length > 0), 'the trips are saved ones');
  invariant(Number.isSafeInteger(input.nowS), 'a sync runs at a whole second');
  detach(syncReminders(input), (message) => REMINDER_STATUS.report(`Reminders could not be planned: ${message}`));
}

/** Without a handler iOS drops a notification that fires while the app is in front. */
function showRemindersInForeground(): void {
  invariant(typeof Notifications.setNotificationHandler === 'function', 'expo-notifications takes a handler');
  const shown = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
  invariant(shown.shouldShowBanner, 'a reminder shows while the app is open');
  Notifications.setNotificationHandler({ handleNotification: () => Promise.resolve(shown) });
}
