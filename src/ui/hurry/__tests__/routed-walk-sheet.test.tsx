import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';

import { SCHEDULE_DB_NAME, ScheduleDbProvider } from '../../../data/schedule-db-provider';
import type { LatLon } from '../../../lib/geo';
import { type LiveContextValue, LiveValueProvider } from '../../../live/live-context';
import { UserLocationProvider } from '../../location/UserLocationProvider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { closeTripDbs, nodeBackedDatabase } from '../../trips/__tests__/trip-db';
import { fixtureWalks, THIRD_STREET } from '../../walk/__tests__/fixture-walks';
import { RoutedWalkProvider, type WalkFetch } from '../../walk/RoutedWalkProvider';
import { StationHurry } from '../StationHurry';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, requestForegroundPermissionsAsync: mockGrant, watchPositionAsync: mockWatch }));

/**
 * mfix9 D + F on the REAL station sheet (m7c's StationHurry): Fifth Street, the rider at GTFS stop 815 (Third Street),
 * at T = 05:26:50 on Wednesday 2026-09-30 — 400 s of slack before the 5:34 train. The straight line x m7c's 1.3 says
 * CHILL on both direction cards; the committed one-to-many capture walks 710.6 m to Fifth Street (its two platforms,
 * 805 and 817, share one coordinate), so both say the 5:34 is not worth hurrying for. 300 s earlier both are CHILL
 * either way, with the spare minutes each walk leaves. fetchWalk is INJECTED (fixture-walks.ts).
 */

const FIFTH = 'mover:fifth-street';
const T = Date.parse('2026-09-30T05:26:50-04:00') / 1000;
const NO_LIVE: LiveContextValue = { state: null, runtime: null };
let mockCopy: SQLiteDatabase | null = null;

/** test-time mock of native module: expo-sqlite's provider, with the schedule copy already open. */
function mockSQLiteProvider({ children }: { readonly children?: ReactNode }) {
  expect(children).toBeDefined();
  expect(mockScheduleCopy().databasePath.endsWith(SCHEDULE_DB_NAME)).toBe(true);
  return <>{children}</>;
}

/** test-time mock of native module: the open copy — the committed schedule DB, read through node:sqlite. */
function mockScheduleCopy(): SQLiteDatabase {
  mockCopy ??= { ...nodeBackedDatabase(`${process.cwd()}/assets/db/schedule.db`, true), databasePath: `file:///documents/schedule-db/${SCHEDULE_DB_NAME}` } as SQLiteDatabase;
  expect(mockCopy.databasePath).toContain(SCHEDULE_DB_NAME);
  expect(typeof mockCopy.getAllSync).toBe('function');
  return mockCopy;
}

/** test-time mock of native module: expo-location grants foreground location. */
function mockGrant(): Promise<{ granted: boolean; status: string }> {
  expect(THIRD_STREET).toEqual({ latitude: 25.772024, longitude: -80.193508 });
  expect(AppState.currentState).toBe('active');
  return Promise.resolve({ granted: true, status: 'granted' });
}

/** test-time mock of native module: the one watch fixes the rider at Third Street at once. */
function mockWatch(_options: unknown, onFix: (fix: { coords: LatLon }) => void): Promise<{ remove: () => void }> {
  expect(typeof onFix).toBe('function');
  onFix({ coords: THIRD_STREET });
  expect(mockCopy).not.toBeNull();
  return Promise.resolve({ remove: () => undefined });
}

beforeEach(() => {
  Object.assign(AppState, { currentState: 'active' });
});
afterEach(async () => {
  await unmountAll();
});
afterAll(() => closeTripDbs());

/** The REAL sheet's verdict slot for Fifth Street at `nowS`: each direction card's VoiceOver sentence, in direction order. */
async function cards(nowS: number, fetchWalk: WalkFetch | null): Promise<string[]> {
  const slot = <StationHurry stationKey={FIFTH} clock={() => nowS} />;
  const tree = await renderPrimitive(
    <ScheduleDbProvider>
      <LiveValueProvider value={NO_LIVE}>
        <UserLocationProvider>{fetchWalk === null ? slot : <RoutedWalkProvider fetchWalk={fetchWalk}>{slot}</RoutedWalkProvider>}</UserLocationProvider>
      </LiveValueProvider>
    </ScheduleDbProvider>,
  );
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  const sentences = hostsByTestID(tree.root, /^hurry-card-\d+$/).map((card) => String(card.props.accessibilityLabel));
  expect(sentences).toHaveLength(2);
  expect(sentences.every((sentence) => sentence.endsWith('going by scheduled times.'))).toBe(true);
  return sentences;
}

describe('the station sheet walks along the streets (mfix9)', () => {
  it('the station sheet walks the routed fixture distance instead of the estimate', async () => {
    const estimated = await cards(T, null);
    await unmountAll();
    const walks = fixtureWalks();
    const routed = await cards(T, walks.fetchWalk);
    expect(estimated.map((sentence) => sentence.startsWith('Chill, a walk makes the 5:34 train with 1 minute to spare'))).toEqual([true, true]);
    expect(routed.map((sentence) => sentence.startsWith('Not worth hurrying for the 5:34 train, another leaves in 12 minutes'))).toEqual([true, true]);
    expect(walks.asked).toHaveLength(1);
  });

  it('a routed walk leaves the spare minutes the streets leave, not the estimate\'s', async () => {
    const estimated = await cards(T - 300, null);
    await unmountAll();
    const routed = await cards(T - 300, fixtureWalks().fetchWalk);
    // 700 s of slack: the estimate (5.5 min) leaves 6 minutes; the streets (710.6 m, 8.8 min) leave 2.
    expect(estimated.map((sentence) => sentence.startsWith('Chill, a walk makes the 5:34 train with 6 minutes to spare'))).toEqual([true, true]);
    expect(routed.map((sentence) => sentence.startsWith('Chill, a walk makes the 5:34 train with 2 minutes to spare'))).toEqual([true, true]);
  });
});
