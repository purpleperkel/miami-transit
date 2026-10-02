import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';

import { SCHEDULE_DB_NAME } from '../../../data/schedule-db-provider';
import { type HurryVerdict, hurryVerdict } from '../../../domain/hurry/verdict';
import { hurryShort } from '../../hurry/copy';
import { unmountAll } from '../../primitives/__tests__/render-primitive';
import type { KvStoreFake } from '../../settings/__tests__/native-fakes';
import { saveWalkingPace } from '../../settings/walking-pace';
import { barOf, fifthToBayfront, renderScene, T } from '../../trips/__tests__/one-walk-scene';
import { closeTripDbs, nodeBackedDatabase } from '../../trips/__tests__/trip-db';
import { fixtureWalks, THIRD_STREET } from '../../walk/__tests__/fixture-walks';
import type { LocationFake } from '../../walk/__tests__/walk-location';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('../../walk/__tests__/walk-location').locationModule());

/**
 * mfix11 D on the REAL Now bar: a saved trip's OWN walk minutes (Jamie's setting) are the walk the bar judges and
 * shows — before this card the bar ignored them. The rider stands at GTFS stop 815 with the saved trip Fifth Street →
 * Bayfront Park set to a 7-minute walk, 430 s before Wednesday's first ride from platform 805 (one-walk-scene.tsx):
 * 420 s of walking misses it, a jog makes it, and the next train follows within 6 min — "Not worth it · 7 min walk",
 * with no "~" (it is Jamie's number, not an estimate), and VoiceOver hears "your 7-minute walk", never "estimated" or
 * "along streets", whether or not a street walk is known (mfix9's fetchWalk, injected).
 */

const location = jest.requireMock<LocationFake>('expo-location');
const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');
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

beforeEach(() => {
  location.rider.at = THIRD_STREET;
});
afterEach(async () => {
  kv.map.clear();
  await unmountAll();
});
afterAll(() => closeTripDbs());

/** The verdict on the 05:34 train alone, at `nowS`, for a walk of `walkMeters` (no detour) at 1.1 / 2.2 m/s. */
function onFirstTrain(nowS: number, walkMeters: number): HurryVerdict {
  const verdict = hurryVerdict({ now: nowS, walkMeters, detour: 1, departures: [{ epoch: T + 430, live: false, lineId: null, headsign: null }], walkMps: 1.1, jogMps: 2.2 });
  expect(verdict.departure?.epoch).toBe(T + 430);
  expect(verdict.walkS).toBeCloseTo(walkMeters / 1.1, 9);
  return verdict;
}

describe('the Now bar walks the trip\'s own minutes (mfix11)', () => {
  it('an override walk shows without a tilde and is voiced as your walk', async () => {
    for (const streets of [null, fixtureWalks()]) {
      const shown = barOf(await renderScene(fifthToBayfront({ walkOverrideMin: 7 }), { fetchWalk: streets?.fetchWalk ?? null, cards: false }));
      expect(shown.lines).toEqual(['Bayfront Park', 'Not worth it · 7 min walk']);
      expect(shown.label).toMatch(/, your 7-minute walk\. Opens the trip\.$/);
      expect(shown.label).not.toMatch(/\bestimated\b|walk along streets|~/i);
      expect(streets?.asked ?? []).toEqual([]);
      await unmountAll();
    }
    expect(barOf(await renderScene(fifthToBayfront({ walkOverrideMin: 7 }), { fetchWalk: null, placement: 'inline', cards: false })).lines).toEqual(['Not worth it']);
  });

  it('the trip\'s own minutes are walked at Jamie\'s stored pace, in exactly those minutes', async () => {
    expect(saveWalkingPace({ walkMps: 1.1, jogMps: 2.2 }).ok).toBe(true);
    // 870 s before the 05:34 train leaves its 30 s to board, a chill walk: 420 s spares 7 min. The same minutes turned
    // into metres at any other pace (the default 1.35 m/s, say) and walked at Jamie's 1.1 m/s would spare only 5.
    const nowS = T - 470;
    const ctx = { now: nowS, clock: () => '5:34 AM' };
    const right = hurryShort(onFirstTrain(nowS, 420 * 1.1), ctx);
    expect([right, hurryShort(onFirstTrain(nowS, 420 * 1.35), ctx)]).toEqual(['Chill · 7 min spare', 'Chill · 5 min spare']);
    const shown = barOf(await renderScene(fifthToBayfront({ walkOverrideMin: 7 }), { fetchWalk: null, cards: false, clock: () => nowS }));
    expect(shown.lines).toEqual(['Bayfront Park', `${right} · 7 min walk`]);
  });
});
