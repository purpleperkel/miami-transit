import type * as Notifications from 'expo-notifications';

import { MONDAY_TO_FRIDAY } from '../../../data/saved-trips-repo';
import type { Platform } from '../../../domain/hurry/platform';
import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import type { ReminderCandidate } from '../../../domain/trips/notification-plan';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import type { KvStoreFake } from '../../settings/__tests__/native-fakes';
import { saveWalkingPace } from '../../settings/walking-pace';
import { reminderCandidates } from '../reminder-candidates';
import { ReminderStatusStore } from '../reminder-status';
import { type SyncApi, syncReminders } from '../ReminderSync';
import { closeTripDbs, realScheduleRepo, savedTrip, WED_0800 } from './trip-db';

// test-time mock of native module
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn(), SchedulableTriggerInputTypes: { DATE: 'date' } }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * mfix11 B, the reminder rule. Reminders are planned with NO live position (ReminderSync mounts outside the location
 * provider, and a reminder days ahead must not walk from wherever the phone last was), so a reminded trip walks its own
 * minutes when it has them, else the estimate from its saved start — the straight line to the platform its rides board
 * at x 1.3, at Jamie's pace, rounded up — and a trip with neither gets no reminder. Government Center → Dadeland South
 * boards southbound at 9512, 6.4 m west of the station centre; the saved start W is 480 m due west of the centre.
 */

const GOV = 'rail:government-ctr';
const DADS = 'rail:dadeland-south';
const W: LatLon = { latitude: 25.7760455, longitude: -80.200887 };
const REMIND = { reminder: { days: MONDAY_TO_FRIDAY, atMin: 8 * 60 + 30 } };
const BUFFER_S = 120;
const TRIPS = [savedTrip('fixed', GOV, DADS, { start: W, ...REMIND }), savedTrip('minutes', GOV, DADS, { start: W, walkOverrideMin: 6, ...REMIND }), savedTrip('roaming', GOV, DADS, REMIND)];
const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');

afterEach(() => kv.map.clear());
afterAll(() => closeTripDbs());

/** The southbound platform the trip boards at. */
function platform9512(): Platform {
  const found = realScheduleRepo().platforms().find((p) => p.stopId === '9512');
  expect(found?.stationKey).toBe(GOV);
  expect(found?.directionIds).toEqual([0]);
  return found as Platform;
}

/** The walk each of trip `id`'s reminders allowed for: departure − leave-by − the buffer. */
function walksOf(candidates: readonly Pick<ReminderCandidate, 'tripId' | 'departureEpoch' | 'leaveByEpoch'>[], id: string): number[] {
  const mine = candidates.filter((c) => c.tripId === id);
  expect(mine.every((c) => c.leaveByEpoch <= c.departureEpoch)).toBe(true);
  expect(new Set(mine.map((c) => c.departureEpoch)).size).toBe(mine.length);
  return mine.map((c) => c.departureEpoch - c.leaveByEpoch - BUFFER_S);
}

/** A phone with no reminders pending and notifications allowed: what syncReminders schedules lands in `scheduled`. */
function emptyPhone(): { readonly api: SyncApi; readonly scheduled: Notifications.NotificationRequestInput[] } {
  const scheduled: Notifications.NotificationRequestInput[] = [];
  const api = {
    getAllScheduledNotificationsAsync: () => Promise.resolve([]),
    scheduleNotificationAsync: (request: Notifications.NotificationRequestInput) => {
      scheduled.push(request);
      return Promise.resolve(request.identifier ?? '');
    },
    cancelScheduledNotificationAsync: () => Promise.resolve(),
    getPermissionsAsync: () => Promise.resolve({ granted: true }),
  };
  expect(scheduled).toEqual([]);
  expect(Object.keys(api)).toHaveLength(4);
  return { api: api as unknown as SyncApi, scheduled };
}

describe('the reminders walk the trip\'s one walk (mfix11)', () => {
  it('reminders walk the override, else from the saved start, else none', () => {
    const repo = realScheduleRepo();
    const centre = repo.stations().find((s) => s.stationKey === GOV)?.coordinate as LatLon;
    const fromStart = Math.ceil((haversineMeters(W, platform9512()) * HURRY_DEFAULTS.detour) / 1.35);
    // The walk to the boarding platform, rounded up — not m7b's walk to the station centre, rounded (462 s).
    expect([fromStart, Math.round((haversineMeters(W, centre) * 1.3) / 1.35)]).toEqual([457, 462]);
    const candidates = reminderCandidates(repo, TRIPS, { nowS: WED_0800, walkMps: 1.35, bufferS: BUFFER_S });
    // A week of weekdays from Wednesday 08:00, each reminder walking the same walk.
    expect(walksOf(candidates, 'fixed').length).toBeGreaterThanOrEqual(5);
    expect(new Set(walksOf(candidates, 'fixed'))).toEqual(new Set([457]));
    expect(walksOf(candidates, 'minutes')).toEqual(walksOf(candidates, 'fixed').map(() => 360));
    expect(walksOf(candidates, 'roaming')).toEqual([]);
  });

  it('the reminder sync walks Jamie\'s stored pace', async () => {
    expect(saveWalkingPace({ walkMps: 1.1, jogMps: 2.2 }).ok).toBe(true);
    const phone = emptyPhone();
    const status = new ReminderStatusStore();
    await syncReminders({ repo: realScheduleRepo(), trips: TRIPS, settings: { boardBufferS: BUFFER_S, reminderLeadS: 0 }, nowS: WED_0800 }, phone.api, status);
    expect(status.read()).toBeNull();
    const synced = phone.scheduled.map((request) => request.content.data as unknown as ReminderCandidate);
    expect(new Set(walksOf(synced, 'fixed'))).toEqual(new Set([Math.ceil((haversineMeters(W, platform9512()) * HURRY_DEFAULTS.detour) / 1.1)]));
    expect(new Set(walksOf(synced, 'minutes'))).toEqual(new Set([360]));
    expect(walksOf(synced, 'roaming')).toEqual([]);
  });
});
