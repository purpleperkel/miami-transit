import { windowFrom } from '../../../domain/gtfs/service-day';
import type { Platform } from '../../../domain/hurry/platform';
import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { PLANNING_WALK_MPS } from '../../../domain/trips/walk-estimate';
import type { WalkEstimate, WalkStop, WalkTo } from '../../../domain/walk/walk-cache';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { THIRD_STREET } from '../../walk/__tests__/fixture-walks';
import { boardingPlatforms, savedTripWalk, type SavedTripWalk, type SavedTripWalkInput } from '../trip-walk';
import { closeTripDbs, realScheduleRepo, WED_0800 } from './trip-db';

/**
 * mfix11 A: ONE function decides a saved trip's walk — the trip's own minutes, else the street walk from the rider
 * (mfix9's useWalkTo), else the straight line x m7c's 1.3 detour from the rider or, with no fix, from the saved start —
 * to the boarding platform nearest where the walk starts, at the pace the caller passes (Jamie's), never a default.
 * The rider stands at GTFS stop 815 (Third Street), 342 m from platform 805 (Fifth Street) and 144 m from 806
 * (Riverwalk): two platforms to choose from.
 */

const O = THIRD_STREET;
const NO_SETTING = { start: null, walkOverrideMin: null };

afterAll(() => closeTripDbs());

/** A platform of the committed schedule, by its GTFS stop_id. */
function platform(stopId: string): Platform {
  const found = realScheduleRepo().platforms().find((p) => p.stopId === stopId);
  expect(found).toBeDefined();
  expect(found?.stopId).toBe(stopId);
  return found as Platform;
}

/** mfix9's WalkTo (asked with the stop itself) knowing a street walk of `metres` to every stop; `asked` lists the stop_ids asked for. */
function streetWalks(metres: number): { readonly walk: WalkTo; readonly asked: string[] } {
  const asked: string[] = [];
  expect(metres).toBeGreaterThan(0);
  expect(asked).toHaveLength(0);
  return {
    asked,
    walk: (stop) => {
      asked.push(stop.stopId);
      return { walkMeters: metres, detour: 1, source: 'routed' };
    },
  };
}

/** mfix9's WalkTo when Transitous gave no walk: its own straight-line estimate from the rider at O. */
function mfix9Estimate(stop: WalkStop): WalkEstimate {
  expect(stop.stopId.length).toBeGreaterThan(0);
  expect(HURRY_DEFAULTS.detour).toBeGreaterThan(1);
  return { walkMeters: haversineMeters(O, stop), detour: HURRY_DEFAULTS.detour, source: 'estimated' };
}

/** savedTripWalk's input for the platforms 805 and 806, at 1.35 m/s. */
function twoPlatforms(position: LatLon | null, walk?: WalkTo): SavedTripWalkInput {
  const platforms = [platform('805'), platform('806')];
  expect(platforms.map((p) => p.stationKey)).toEqual(['mover:fifth-street', 'mover:riverwalk']);
  expect(haversineMeters(O, platforms[1] as Platform)).toBeLessThan(haversineMeters(O, platforms[0] as Platform)); // from O, 806 is the nearer
  return { platforms, position, walkMps: 1.35, walk };
}

/** The walk of a trip set to `minutes` of walking. */
function ownMinutes(minutes: number): SavedTripWalk {
  expect(Number.isSafeInteger(minutes)).toBe(true);
  expect(minutes).toBeGreaterThanOrEqual(0);
  return { source: 'override', from: 'setting', walkS: minutes * 60, minutes, stopId: null, walkedM: null, straightM: null };
}

/** m7c's estimate: the straight line x 1.3 at `mps`, in whole seconds rounded up. */
function estimateS(from: LatLon, to: LatLon, mps: number): number {
  const seconds = Math.ceil((haversineMeters(from, to) * HURRY_DEFAULTS.detour) / mps);
  expect(Number.isSafeInteger(seconds)).toBe(true);
  expect(HURRY_DEFAULTS.detour).toBe(1.3);
  return seconds;
}

/** The measured walk savedTripWalk should give: from `from` to `to` (a platform), `walkS` seconds over `walkedM` metres. */
function measured(source: 'routed' | 'estimated', where: 'here' | 'start', start: LatLon, to: Platform, walk: { readonly walkS: number; readonly walkedM: number }): SavedTripWalk {
  expect(walk.walkS).toBeGreaterThan(0);
  expect(walk.walkedM).toBeGreaterThan(0);
  return { source, from: where, walkS: walk.walkS, minutes: Math.ceil(walk.walkS / 60), stopId: to.stopId, walkedM: walk.walkedM, straightM: haversineMeters(start, to) };
}

describe('one walk for a saved trip (mfix11)', () => {
  it('a saved trip walks its override, else the routed walk, else the estimate', () => {
    const [p805, p806] = [platform('805'), platform('806')];
    const street = streetWalks(300);
    // Jamie's own minutes beat a known street walk, need no fix (0 stays 0), and ask for no street walk.
    expect(savedTripWalk({ start: null, walkOverrideMin: 7 }, twoPlatforms(O, street.walk))).toEqual(ownMinutes(7));
    expect(savedTripWalk({ start: null, walkOverrideMin: 0 }, twoPlatforms(null, street.walk))).toEqual(ownMinutes(0));
    expect(street.asked).toEqual([]);
    // From the rider: the street walk to the platform nearest the rider (806), asked for that platform only.
    const routed = measured('routed', 'here', O, p806, { walkS: Math.ceil(300 / 1.35), walkedM: 300 });
    expect(savedTripWalk(NO_SETTING, twoPlatforms(O, street.walk))).toEqual(routed);
    expect(street.asked).toEqual(['806']);
    // No street walk known (no provider, or mfix9 answers its own estimate): m7c's estimate to 806.
    const estimate = measured('estimated', 'here', O, p806, { walkS: estimateS(O, p806, 1.35), walkedM: haversineMeters(O, p806) * 1.3 });
    expect(savedTripWalk(NO_SETTING, twoPlatforms(O))).toEqual(estimate);
    expect(savedTripWalk(NO_SETTING, twoPlatforms(O, mfix9Estimate))).toEqual(estimate);
    // A saved start yields to a located rider; without a fix the walk is the estimate from the start, to ITS nearest
    // platform (805), and the street walk (which starts at the rider) is never asked.
    const start = { latitude: p805.latitude - 0.0009, longitude: p805.longitude };
    expect(savedTripWalk({ start, walkOverrideMin: null }, twoPlatforms(O, street.walk))).toEqual(routed);
    street.asked.length = 0;
    const fromStart = measured('estimated', 'start', start, p805, { walkS: estimateS(start, p805, 1.35), walkedM: haversineMeters(start, p805) * 1.3 });
    expect(savedTripWalk({ start, walkOverrideMin: null }, twoPlatforms(null, street.walk))).toEqual(fromStart);
    expect(street.asked).toEqual([]);
    // Nothing tells how far it is: no walk.
    expect(savedTripWalk(NO_SETTING, twoPlatforms(null, street.walk))).toBeNull();
  });

  it('the walk goes to the platform the trip boards at, never the station centre', () => {
    const repo = realScheduleRepo();
    const rides = repo.tripRides('rail:government-ctr', 'rail:dadeland-south', windowFrom(WED_0800, 3 * 3600));
    const southbound = boardingPlatforms(repo.platforms(), 'rail:government-ctr', rides.ok && rides.value.kind === 'rides' ? rides.value.rides : []);
    expect(southbound.map((p) => p.stopId)).toEqual(['9512']);
    expect(boardingPlatforms(repo.platforms(), 'rail:government-ctr', []).map((p) => p.stopId)).toEqual(['9512', '9513']);
    // From due east of the station the northbound platform 9513 is nearer, but the trip boards southbound at 9512.
    const east = { latitude: 25.7760455, longitude: -80.1940935 };
    const walk = savedTripWalk(NO_SETTING, { platforms: southbound, position: east, walkMps: 1.35 });
    expect(haversineMeters(east, platform('9513'))).toBeLessThan(haversineMeters(east, platform('9512')));
    expect(walk).toEqual(measured('estimated', 'here', east, platform('9512'), { walkS: estimateS(east, platform('9512'), 1.35), walkedM: haversineMeters(east, platform('9512')) * 1.3 }));
    // Fifth Street's 805 and 817 stand on one spot: a tie keeps the platform listed first.
    expect(savedTripWalk(NO_SETTING, { platforms: [platform('805'), platform('817')], position: O, walkMps: 1.35 })?.stopId).toBe('805');
    expect(savedTripWalk(NO_SETTING, { platforms: [platform('817'), platform('805')], position: O, walkMps: 1.35 })?.stopId).toBe('817');
  });
});

describe('the pace is always Jamie\'s (mfix11)', () => {
  it('the walk never falls back to a module default pace', () => {
    const platforms = [platform('805')];
    for (const missing of [undefined, 0, Number.NaN, -1.35]) {
      expect(() => savedTripWalk(NO_SETTING, { platforms, position: O, walkMps: missing as unknown as number })).toThrow(/Jamie's pace/);
    }
    // Jamie's 1.1 m/s is walked — not m7c's default 1.35, not m7a's planning 1.3 — for the estimate and the street walk alike.
    const slow = savedTripWalk(NO_SETTING, { platforms, position: O, walkMps: 1.1 });
    expect(slow?.walkS).toBe(estimateS(O, platforms[0] as Platform, 1.1));
    expect([HURRY_DEFAULTS.walkMps, PLANNING_WALK_MPS].map((mps) => estimateS(O, platforms[0] as Platform, mps))).not.toContain(slow?.walkS);
    expect(savedTripWalk(NO_SETTING, { platforms, position: O, walkMps: 1.1, walk: streetWalks(710.64).walk })?.walkS).toBe(Math.ceil(710.64 / 1.1));
    // Jamie's own minutes are his at any pace.
    expect(savedTripWalk({ start: null, walkOverrideMin: 7 }, { platforms, position: O, walkMps: 1.1 })?.walkS).toBe(420);
  });
});
