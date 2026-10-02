import { haversineMeters, type LatLon } from '../../../lib/geo';
import { HURRY_DEFAULTS, hurryVerdict } from '../../hurry/verdict';
import fixture from '../__fixtures__/transitous-one-to-many.json';
import { parseWalkTimes } from '../one-to-many';
import { backoffS, needsWalkRequest, nextWalkCheckS, requestTargets, type WalkCache, walkFor, type WalkStop } from '../walk-cache';

/**
 * mfix9 B + F: the routed-walk policy, and Jamie's 09:12 bug (2026-10-02, "chill" for Fifth Street; Google put the
 * walk at 11 min) in PUBLIC data: the committed one-to-many capture from GTFS stop 815 (Third Street). Fifth Street
 * (805) is 342 m away in a straight line and 710.6 m along the streets: 2.08x, where m7c estimated 1.3x.
 */

const O: LatLon = { latitude: fixture.request.one.lat, longitude: fixture.request.one.lon };
const FIFTH: WalkStop = { stopId: '805', latitude: 25.769165, longitude: -80.192248 };
const RIVERWALK: WalkStop = { stopId: '806', latitude: 25.771051, longitude: -80.192558 };
/** Fifth Street's walk as the capture gave it; Riverwalk asked for, but no walk (as if Transitous answered {}). */
const CACHE: WalkCache = { origin: O, requestedAtS: 1000, paths: new Map([['805', { distanceM: 710.639274597168, costS: 867 }], ['806', null]]) };
const PER_DEGREE_M = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });

/** `metres` due south of the rider at Third Street. */
function south(metres: number): LatLon {
  const point = { latitude: O.latitude - metres / PER_DEGREE_M, longitude: O.longitude };
  expect(haversineMeters(O, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(O.longitude);
  return point;
}

/** m7c's verdict at `now` for one train leaving 430 s later (400 s of slack after boarding), at Jamie's default paces. */
function oneTrainVerdict(now: number, walk: { readonly walkMeters: number; readonly detour: number }) {
  const verdict = hurryVerdict({ now, departures: [{ epoch: now + 30 + 400, live: false, lineId: null, headsign: null }], walkMps: 1.35, jogMps: 2.7, ...walk });
  expect(verdict.departure?.epoch).toBe(now + 430);
  expect(verdict.walkS).toBeCloseTo((walk.walkMeters * walk.detour) / 1.35, 9);
  return verdict;
}

/** The committed capture as the provider would cache it at Third Street, and the stops it answers for. */
function fixtureCache(): { readonly cache: WalkCache; readonly stops: readonly WalkStop[] } {
  const parsed = parseWalkTimes(fixture.response, fixture.request.many.length);
  const stops = fixture.request.many.map((target) => ({ stopId: target.stopId, latitude: target.lat, longitude: target.lon }));
  expect(parsed.ok && parsed.value.every((walk) => walk !== null)).toBe(true);
  expect(stops.map((stop) => stop.stopId)).toEqual(['806', '805', '804', '807', '808']);
  const walks = parsed.ok ? parsed.value : [];
  return { cache: { origin: O, requestedAtS: 0, paths: new Map(stops.map((stop, i) => [stop.stopId, walks[i] ?? null])) }, stops };
}

describe('needsWalkRequest', () => {
  it('never asks while backing off or within 60 s of the last request', () => {
    expect([needsWalkRequest(null, O, 1000, ['805'], 1001), needsWalkRequest(null, O, 1001, ['805'], 1001)]).toEqual([false, true]);
    expect([needsWalkRequest(CACHE, south(400), 1059, ['805'], 0), needsWalkRequest(CACHE, south(400), 1060, ['805'], 0)]).toEqual([false, true]);
  });

  it('asks again for a move of more than 150 m, or a wanted stop never asked for', () => {
    expect([needsWalkRequest(CACHE, south(149.99), 5000, ['805'], 0), needsWalkRequest(CACHE, south(150.01), 5000, ['805'], 0)]).toEqual([false, true]);
    expect([needsWalkRequest(CACHE, O, 5000, ['805', '806'], 0), needsWalkRequest(CACHE, O, 5000, ['805', '807'], 0)]).toEqual([false, true]);
  });
});

describe('walkFor', () => {
  it('walks the routed metres within 300 m of where they were asked, scaled by the straight line', () => {
    const scaled = 710.639274597168 * (haversineMeters(south(100), FIFTH) / haversineMeters(O, FIFTH));
    expect(walkFor(CACHE, FIFTH, O)).toEqual({ walkMeters: 710.639274597168, detour: 1, source: 'routed' });
    expect(walkFor(CACHE, FIFTH, south(100))).toEqual({ walkMeters: scaled, detour: 1, source: 'routed' });
  });

  it('estimates the straight line with m7c\'s detour beyond 300 m, without a walk, or without a cache', () => {
    const asked: readonly [WalkCache | null, WalkStop, LatLon][] = [[CACHE, FIFTH, south(300.5)], [CACHE, RIVERWALK, O], [null, FIFTH, O]];
    expect(asked.map(([cache, stop, at]) => walkFor(cache, stop, at))).toEqual(asked.map(([, stop, at]) => ({ walkMeters: haversineMeters(at, stop), detour: HURRY_DEFAULTS.detour, source: 'estimated' })));
    expect(walkFor(CACHE, { stopId: '807', latitude: 25.771865, longitude: -80.191377 }, O).source).toBe('estimated');
  });

  it('walks a stop at the origin unscaled, never dividing by its zero straight line', () => {
    const atOrigin: WalkCache = { origin: O, requestedAtS: 0, paths: new Map([['o', { distanceM: 12, costS: 100 }]]) };
    expect(walkFor(atOrigin, { stopId: 'o', ...O }, south(20))).toEqual({ walkMeters: 12, detour: 1, source: 'routed' });
    expect(walkFor(atOrigin, { stopId: 'o', ...O }, O).walkMeters).toBe(12);
  });
});

describe('what one request carries, and when the provider looks again', () => {
  it('asks for each stop once, the nearest 128 to the rider', () => {
    const stops = Array.from({ length: 130 }, (_, i) => ({ stopId: `s${i}`, ...south(10 * (i + 1)) }));
    const targets = requestTargets([...stops].reverse().concat(stops.slice(0, 3)), O);
    expect(targets.map((stop) => stop.stopId)).toEqual(stops.slice(0, 128).map((stop) => stop.stopId));
    expect(requestTargets([FIFTH, RIVERWALK, FIFTH], O)).toEqual([RIVERWALK, FIFTH]);
  });

  it('backs off 60, 120, 240, 480, then 600 s, and looks again only when a request will be due', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(backoffS)).toEqual([60, 120, 240, 480, 600, 600, 600]);
    expect([nextWalkCheckS(CACHE, south(200), ['805'], 0), nextWalkCheckS(CACHE, south(200), ['805'], 1300), nextWalkCheckS(CACHE, O, ['805'], 0), nextWalkCheckS(null, O, ['805'], 1500)]).toEqual([1060, 1300, null, 1500]);
  });
});

describe('the committed one-to-many capture from Third Street (815)', () => {
  it('the fixture walk says jog where the estimate says chill', () => {
    const { cache, stops } = fixtureCache();
    const ratios = stops.map((stop) => Number(((cache.paths.get(stop.stopId)?.distanceM ?? 0) / haversineMeters(O, stop)).toFixed(2)));
    const estimated = oneTrainVerdict(1_790_000_000, walkFor(null, FIFTH, O));
    const routed = oneTrainVerdict(1_790_000_000, walkFor(cache, FIFTH, O));
    expect(ratios).toEqual([2.03, 2.08, 1.31, 1.63, 1.19]);
    expect([estimated.kind, routed.kind]).toEqual(['CHILL', 'JOG']);
    expect([estimated.walkS, routed.walkS, routed.jogS].map((s) => Number(s.toFixed(2)))).toEqual([329.36, 526.4, 263.2]);
  });
});
