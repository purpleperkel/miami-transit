import * as Notifications from 'expo-notifications';

import { MONDAY_TO_FRIDAY } from '../../../data/saved-trips-repo';
import { TRIP_SETTINGS } from '../../../data/settings-repo';
import { planReminders, type Reminder, type ReminderCandidate } from '../../../domain/trips/notification-plan';
import { applyReminderPlan, reminderRequest } from '../notifications';
import { syncReminders } from '../ReminderSync';
import { ReminderStatusStore } from '../reminder-status';
import { closeTripDbs, realScheduleRepo, savedTrip, WED_0800 } from './trip-db';

// test-time mock of native module
jest.mock('expo-notifications', () => ({
  getAllScheduledNotificationsAsync: jest.fn(), scheduleNotificationAsync: jest.fn(), cancelScheduledNotificationAsync: jest.fn(),
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), setNotificationHandler: jest.fn(), SchedulableTriggerInputTypes: { DATE: 'date' },
}));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * M7.5: the notification service applies M7.4's reminder plan through expo-notifications (the labelled
 * test-time mock, standing in for the phone's pending-notification list): new reminders are scheduled
 * under their plan ids with a DATE trigger, removed ones are cancelled, the app's other notifications are
 * left alone, and applying the same plan twice changes nothing.
 */

const api = jest.mocked(Notifications);
const NOW = WED_0800;
let pending: Notifications.NotificationRequest[] = [];

/** The mocked module keeps a pending list as the phone does: schedule adds (or replaces) by identifier, cancel removes. */
function fakePendingList(): void {
  pending = [];
  api.getAllScheduledNotificationsAsync.mockImplementation(() => Promise.resolve([...pending]));
  api.scheduleNotificationAsync.mockImplementation((request) => {
    pending = [...pending.filter((r) => r.identifier !== request.identifier), { identifier: request.identifier ?? '', content: request.content, trigger: request.trigger } as unknown as Notifications.NotificationRequest];
    return Promise.resolve(request.identifier ?? '');
  });
  api.cancelScheduledNotificationAsync.mockImplementation((id) => Promise.resolve(void (pending = pending.filter((r) => r.identifier !== id))));
  api.getPermissionsAsync.mockResolvedValue({ granted: true } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
  expect(pending).toEqual([]);
  expect(jest.isMockFunction(api.scheduleNotificationAsync)).toBe(true);
}

beforeEach(() => fakePendingList());

afterEach(() => jest.clearAllMocks());
afterAll(() => closeTripDbs());

/** Two trips' reminders an hour or so ahead, as the plan makes them. */
function plan(candidates: readonly ReminderCandidate[]): Reminder[] {
  const desired = planReminders(NOW, candidates);
  expect(desired).toHaveLength(candidates.length);
  expect(desired.every((r) => r.id.startsWith('leave:'))).toBe(true);
  return desired;
}

const HOME: ReminderCandidate = { tripId: 'home', tripName: 'Home', departureEpoch: NOW + 3600, leaveByEpoch: NOW + 3000 };
const GYM: ReminderCandidate = { tripId: 'gym', tripName: 'Gym', departureEpoch: NOW + 7200, leaveByEpoch: NOW + 6300 };
const PROBE: Notifications.NotificationRequest = { identifier: 'probe-notification-id', content: { title: 'probe', data: {} }, trigger: null } as unknown as Notifications.NotificationRequest;

describe('the notification service (M7.5)', () => {
  it('schedules added reminders under their plan ids, firing at the leave-by', async () => {
    const desired = plan([HOME, GYM]);
    const applied = await applyReminderPlan(desired);
    expect(applied.ok ? applied.value.schedule.map((r) => r.id) : applied).toEqual(['leave:home:1790773200', 'leave:gym:1790776800']);
    expect(api.scheduleNotificationAsync.mock.calls.map(([request]) => [request.identifier, request.trigger])).toEqual([
      ['leave:home:1790773200', { type: 'date', date: (NOW + 3000) * 1000 }],
      ['leave:gym:1790776800', { type: 'date', date: (NOW + 6300) * 1000 }],
    ]);
    expect(api.scheduleNotificationAsync.mock.calls[0]?.[0].content).toMatchObject({ title: 'Home', body: 'Leave now: your train leaves in 10 min.' });
    expect(api.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancels removed reminders and leaves the app\'s other notifications alone', async () => {
    const [home, gym] = plan([HOME, GYM]);
    pending = [reminderRequest(home as Reminder), reminderRequest(gym as Reminder), PROBE].map((r) => ({ ...r, identifier: r.identifier ?? '' }) as unknown as Notifications.NotificationRequest);
    const applied = await applyReminderPlan(plan([HOME]));
    expect(api.cancelScheduledNotificationAsync.mock.calls).toEqual([['leave:gym:1790776800']]);
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(pending.map((r) => r.identifier)).toEqual(['leave:home:1790773200', 'probe-notification-id']);
    expect(applied.ok).toBe(true);
  });
});

describe('the notification service: idempotence and failures (M7.5)', () => {
  it('applying the same plan twice changes nothing the second time', async () => {
    const desired = plan([HOME, GYM]);
    expect((await applyReminderPlan(desired)).ok).toBe(true);
    api.scheduleNotificationAsync.mockClear();
    const again = await applyReminderPlan(desired);
    expect(again.ok ? [again.value.schedule, again.value.cancel, again.value.unreadable] : again).toEqual([[], [], []]);
    expect(api.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(api.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('a pending reminder it cannot read back is cancelled, and a native failure is an Err with its message', async () => {
    pending = [{ identifier: 'leave:old:1790000000', content: { title: 'Old', data: { kind: 'something-else' } }, trigger: null } as unknown as Notifications.NotificationRequest];
    const applied = await applyReminderPlan([]);
    expect(applied.ok ? applied.value.unreadable : applied).toEqual(['leave:old:1790000000']);
    expect(pending).toEqual([]);
    api.getAllScheduledNotificationsAsync.mockRejectedValueOnce(new Error('notifications unavailable'));
    expect(await applyReminderPlan(plan([HOME]))).toEqual({ ok: false, error: 'reminders could not be updated: notifications unavailable' });
  });
});

describe('the reminder sync over the real timetable (M7.4 + M7.5)', () => {
  it('plans a week of weekday reminders for a trip with a fixed walk, and none for one without', async () => {
    const repo = realScheduleRepo();
    const commute = savedTrip('commute', 'rail:dadeland-south', 'rail:government-ctr', { walkOverrideMin: 6, reminder: { days: MONDAY_TO_FRIDAY, atMin: 8 * 60 + 30 } });
    const roaming = savedTrip('roaming', 'rail:brickell', 'rail:government-ctr', { reminder: { days: MONDAY_TO_FRIDAY, atMin: 9 * 60 } });
    const settings = { boardBufferS: TRIP_SETTINGS.boardBufferS.defaultValue, reminderLeadS: 0 };
    const status = new ReminderStatusStore();
    await syncReminders({ repo, trips: [commute, roaming], settings, nowS: NOW }, api, status);
    const ids = api.scheduleNotificationAsync.mock.calls.map(([request]) => request.identifier ?? '');
    // Wed 08:30 to Tue 08:30 is five weekdays (Wed, Thu, Fri, Mon, Tue): one reminder each, the commute's only.
    expect(ids).toHaveLength(5);
    expect(ids.every((id) => id.startsWith('leave:commute:'))).toBe(true);
    expect(status.read()).toBeNull();
  });
});
