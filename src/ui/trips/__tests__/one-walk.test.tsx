import type { SQLiteDatabase } from 'expo-sqlite';
import type { ReactNode } from 'react';

import { SCHEDULE_DB_NAME } from '../../../data/schedule-db-provider';
import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { unmountAll } from '../../primitives/__tests__/render-primitive';
import { fixtureWalks, THIRD_STREET } from '../../walk/__tests__/fixture-walks';
import type { LocationFake } from '../../walk/__tests__/walk-location';
import { cardWalks, fifthToBayfront, moveRider, renderScene, walksShown } from './one-walk-scene';
import { closeTripDbs, nodeBackedDatabase, realScheduleRepo } from './trip-db';

// test-time mock of native module
jest.mock('expo-sqlite', () => ({ SQLiteProvider: mockSQLiteProvider, useSQLiteContext: mockScheduleCopy }));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());
// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('../../walk/__tests__/walk-location').locationModule());

/**
 * mfix11 C: ONE saved trip shows ONE walk. The REAL Now bar, Trips tab and trip screen render in one tree for the saved
 * trip Fifth Street → Bayfront Park at T (one-walk-scene.tsx): the bar's walk and both cards' walks are the same
 * minutes for the estimate (6), the committed street walk (9: mfix9's fetchWalk, INJECTED — no network) and a 7-minute
 * walk of Jamie's own, with or without a street walk known — and they follow the rider's latest fix.
 */

const location = jest.requireMock<LocationFake>('expo-location');
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
  await unmountAll();
});
afterAll(() => closeTripDbs());

/** `metres` due south of platform 805 (Fifth Street, the trip's boarding platform). */
function southOf805(metres: number): LatLon {
  const p805 = realScheduleRepo().platforms().find((p) => p.stopId === '805') as LatLon;
  const point = { latitude: p805.latitude - metres / haversineMeters(p805, { latitude: p805.latitude + 1, longitude: p805.longitude }), longitude: p805.longitude };
  expect(haversineMeters(point, p805)).toBeCloseTo(metres, 3);
  expect(haversineMeters(THIRD_STREET, p805)).toBeCloseTo(342.03, 2);
  return point;
}

/** The minutes m7c's estimate shows for `metres` of straight line at Jamie's default 1.35 m/s. */
function estimatedMinutes(metres: number): number {
  const minutes = Math.ceil(Math.ceil((metres * HURRY_DEFAULTS.detour) / 1.35) / 60);
  expect(Number.isSafeInteger(minutes)).toBe(true);
  expect(minutes).toBeGreaterThan(0);
  return minutes;
}

describe('one saved trip, one walk on every screen (mfix11)', () => {
  it('the bar and the trip card show the same walk for every source', async () => {
    const own = fifthToBayfront({ walkOverrideMin: 7 });
    expect(estimatedMinutes(342.03)).toBe(6);
    expect(walksShown(await renderScene(fifthToBayfront(), { fetchWalk: null }))).toEqual(['~6 min walk', 'a 6 min walk from here', 'a 6 min walk from here']);
    await unmountAll();
    expect(walksShown(await renderScene(own, { fetchWalk: null }))).toEqual(['7 min walk', 'a 7 min walk (your setting)', 'a 7 min walk (your setting)']);
    await unmountAll();
    // The street walk: the bar, the Trips tab and the trip screen share ONE request.
    const streets = fixtureWalks();
    expect(walksShown(await renderScene(fifthToBayfront(), { fetchWalk: streets.fetchWalk }))).toEqual(['~9 min walk', 'a 9 min walk from here', 'a 9 min walk from here']);
    expect(streets.asked).toHaveLength(1);
    await unmountAll();
    // Jamie's own minutes beat a street walk, and a trip that walks them asks Transitous for nothing.
    const quiet = fixtureWalks();
    expect(walksShown(await renderScene(own, { fetchWalk: quiet.fetchWalk }))).toEqual(['7 min walk', 'a 7 min walk (your setting)', 'a 7 min walk (your setting)']);
    expect(quiet.asked).toEqual([]);
  }, 60_000); // three screens over the real schedule DB, four times: never jest's 5 s default on a loaded machine

  it('every screen walks from the rider\'s latest fix', async () => {
    const near = southOf805(100);
    location.rider.at = near;
    const tree = await renderScene(fifthToBayfront(), { fetchWalk: null });
    const fromNear = estimatedMinutes(100);
    expect(walksShown(tree)).toEqual([`~${fromNear} min walk`, `a ${fromNear} min walk from here`, `a ${fromNear} min walk from here`]);
    await moveRider(tree, location, THIRD_STREET);
    expect(walksShown(tree)).toEqual(['~6 min walk', 'a 6 min walk from here', 'a 6 min walk from here']);
  });

  it('a card read before the first fix walks from the trip\'s saved start', async () => {
    location.rider.at = null;
    const start = southOf805(300);
    const tree = await renderScene(fifthToBayfront({ start }), { fetchWalk: null });
    expect(cardWalks(tree)).toEqual([`a ${estimatedMinutes(300)} min walk from your start`, `a ${estimatedMinutes(300)} min walk from your start`]);
    await moveRider(tree, location, THIRD_STREET);
    expect(walksShown(tree)).toEqual(['~6 min walk', 'a 6 min walk from here', 'a 6 min walk from here']);
  });
});
