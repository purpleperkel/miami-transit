import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

import { EVERY_DAY } from '../../../data/saved-trips-repo';
import { TRIP_SETTINGS } from '../../../data/settings-repo';
import type { TripBook, UserRepos } from '../../../data/user-db-provider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { goToConfirm, readStep, type StepParams, type WalkChoice } from '../add/add-trip';
import { destinationRows } from '../add/AddTripSteps';
import { saveDraft } from '../add/ConfirmStep';
import { TripDetail } from '../TripScreen';
import { closeTripDbs, memoryUserRepos, realScheduleRepo, savedTrip, WED_0800 } from './trip-db';

// test-time mock of native module
jest.mock('expo-notifications', () => ({ getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn() }));
// test-time mock of native module
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => Promise.resolve({ granted: false, status: 'denied', canAskAgain: false }),
  Accuracy: { Balanced: 3 },
}));

/**
 * M7.9: the add-trip flow. Its state rides in the route params step to step; its destinations are the
 * REAL schedule's directReachable(origin) — one vehicle, no change — with every other station listed as
 * needing a transfer; Save writes through the saved-trips repo and lands on the Trips tab, asking for
 * notification permission when the trip has reminders. A saved trip's screen opens route options (R6).
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});
afterAll(() => closeTripDbs());

/** The params goToConfirm pushes for a walk, read back by the next step. */
function roundTrip(walk: WalkChoice): ReturnType<typeof readStep> {
  const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
  goToConfirm('rail:brickell', 'rail:government-ctr', walk);
  expect(push).toHaveBeenCalledTimes(1);
  const [href] = push.mock.calls[0] ?? [];
  expect(href).toMatchObject({ pathname: '/trip/new/confirm' });
  push.mockRestore();
  return readStep((href as { params: StepParams }).params);
}

describe('the add-trip flow: its steps (M7.9)', () => {
  it('each walk choice survives the trip from one step to the next', () => {
    const walks: WalkChoice[] = [{ kind: 'here-each-time' }, { kind: 'minutes', minutes: 7 }, { kind: 'start', start: { latitude: 25.7617, longitude: -80.1918 } }];
    for (const walk of walks) {
      expect(roundTrip(walk)).toEqual({ from: 'rail:brickell', to: 'rail:government-ctr', walk });
    }
    expect(readStep({ to: 'rail:brickell' })).toBeNull();
    expect(readStep({ from: 'rail:brickell', to: 'rail:brickell' })).toEqual({ from: 'rail:brickell', to: null, walk: null });
  });

  it('from Dadeland South the destinations are the stations one train reaches; Bayfront Park is listed as needing a transfer', () => {
    const rows = destinationRows(realScheduleRepo(), 'rail:dadeland-south');
    const pickable = rows?.filter((row) => row.excludedBecause === null).map((row) => row.station.stationKey) ?? [];
    expect(pickable).toContain('rail:government-ctr');
    expect(pickable.every((key) => key.startsWith('rail:'))).toBe(true);
    expect(rows?.find((row) => row.station.stationKey === 'mover:bayfront-park')?.excludedBecause).toMatch(/^Needs a transfer/);
    expect(destinationRows(realScheduleRepo(), 'rail:nowhere')).toBeNull();
  });
});

/** The writes the user DB provider hands a screen, over a fresh in-memory user DB. */
function bookOverMemory(): { readonly book: TripBook; readonly repos: UserRepos } {
  const opened = memoryUserRepos();
  expect(opened.ok).toBe(true);
  const repos = (opened as Extract<typeof opened, { ok: true }>).value;
  const book: TripBook = { save: (trip) => repos.trips.create(trip), remove: (id) => repos.trips.remove(id) };
  expect(repos.trips.list()).toEqual([]);
  return { book, repos };
}

describe('the add-trip flow: saving (M7.9)', () => {
  it('Save writes the trip through the saved-trips repo, asks for notifications when it reminds, and shows the Trips tab', async () => {
    const { book, repos } = bookOverMemory();
    const navigate = jest.spyOn(router, 'navigate').mockImplementation(() => undefined);
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: true } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: true } as Awaited<ReturnType<typeof Notifications.requestPermissionsAsync>>);
    const draft = { id: 'commute', name: 'Commute', from: 'rail:brickell', to: 'rail:government-ctr', walk: { kind: 'minutes', minutes: 6 } as const, reminderDays: 'every-day' as const, reminderAtMin: 510, createdEpoch: WED_0800 };
    const saved = saveDraft(book, draft, () => undefined);
    await Promise.resolve();
    expect(saved.ok).toBe(true);
    expect(repos.trips.get('commute')).toMatchObject({ walkOverrideMin: 6, start: null, reminder: { days: EVERY_DAY, atMin: 510 } });
    expect(navigate.mock.calls).toEqual([['/trips']]);
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('a refused trip says why and stays on the step', () => {
    const { book } = bookOverMemory();
    const navigate = jest.spyOn(router, 'navigate').mockImplementation(() => undefined);
    const said: (string | null)[] = [];
    const draft = { id: 'blank', name: '   ', from: 'rail:brickell', to: 'rail:government-ctr', walk: { kind: 'here-each-time' } as const, reminderDays: 'off' as const, reminderAtMin: 480, createdEpoch: WED_0800 };
    expect(saveDraft(book, draft, (problem) => said.push(problem)).ok).toBe(false);
    expect(said).toEqual(['a trip name is 1–60 characters']);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("a saved trip's screen (M7.9, ruling R6)", () => {
  it("route options open from the trip's station", async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const trip = savedTrip('gym', 'rail:brickell', 'rail:government-ctr', { walkOverrideMin: 4 });
    const settings = { boardBufferS: TRIP_SETTINGS.boardBufferS.defaultValue, reminderLeadS: 0 };
    const tree = await renderPrimitive(<TripDetail trip={trip} settings={settings} remove={() => true} clock={() => WED_0800} />);
    expect(hostsByTestID(tree.root, 'trip-route-options')[0]?.props.accessibilityLabel).toBe('Route options');
    await press(tree, 'trip-route-options');
    expect(push.mock.calls).toEqual([[{ pathname: '/plan', params: { fromStation: 'rail:brickell' } }]]);
  });
});
