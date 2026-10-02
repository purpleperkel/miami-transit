import { haversineMeters, type LatLon } from '../../../lib/geo';
import { HURRY_DEFAULTS, hurryVerdict } from '../../hurry/verdict';
import fixture from '../__fixtures__/transitous-one-to-many.json';
import { parseWalkTimes, type WalkPath } from '../one-to-many';
import { backoffS, dropStaleWalks, mergeWalks, needsWalkRequest, nextWalkCheckS, requestTargets, type WalkCache, walkFor, walkKey, type WalkStop } from '../walk-cache';

/**
 * mfix9 B + F: the routed-walk policy, and Jamie's 09:12 bug (2026-10-02, "chill" for Fifth Street; Google put the
 * walk at 11 min) in PUBLIC data: the committed one-to-many capture from GTFS stop 815 (Third Street). Fifth Street
 * (805) is 342 m away in a straight line and 710.6 m along the streets: 2.08x, where m7c estimated 1.3x.
 */

const O: LatLon = { latitude: fixture.request.one.lat, longitude: fixture.request.one.lon };
const FIFTH: WalkStop = { stopId: '805', latitude: 25.769165, longitude: -80.192248 };
const RIVERWALK: WalkStop = { stopId: '806', latitude: 25.771051, longitude: -80.192558 };
const BAYFRONT_SOUTH: WalkStop = { stopId: '807', latitude: 25.771865, longitude: -80.191377 };
const FIFTH_WALK: WalkPath = { distanceM: 710.639274597168, costS: 867 };
const PER_DEGREE_M = haversineMeters(O, { latitude: O.latitude + 1, longitude: O.longitude });

/** `metres` due south of the rider at Third Street. */
function south(metres: number): LatLon {
  const point = { latitude: O.latitude - metres / PER_DEGREE_M, longitude: O.longitude };
  expect(haversineMeters(O, point)).toBeCloseTo(metres, 6);
  expect(point.longitude).toBe(O.longitude);
  return point;
}

/** `cache` with one answer merged in: from `origin`, asked at `atS`, each stop with its walk (null: none reaches it). */
function answered(cache: WalkCache | null, origin: LatLon, atS: number, walks: readonly (readonly [WalkStop, WalkPath | null])[]): WalkCache {
  const merged = mergeWalks(cache, { origin, requestedAtS: atS, stops: walks.map(([stop]) => stop), paths: walks.map(([, path]) => path) });
  expect(merged.lastRequestAtS).toBe(atS);
  expect(walks.every(([stop]) => merged.entries.get(walkKey(stop))?.origin === origin)).toBe(true);
  return merged;
}

/** Fifth Street's walk as the capture gave it, and Riverwalk asked for with no walk (as if Transitous answered {}), at 1000 s. */
function fifthCache(): WalkCache {
  const cache = answered(null, O, 1000, [[FIFTH, FIFTH_WALK], [RIVERWALK, null]]);
  expect(cache.entries.size).toBe(2);
  expect(cache.entries.get(walkKey(FIFTH))?.straightAtOrigin).toBeCloseTo(haversineMeters(O, FIFTH), 9);
  return cache;
}

/** m7c's verdict at `now` for one train leaving 430 s later (400 s of slack after boarding), at Jamie's default paces. */
function oneTrainVerdict(now: number, walk: { readonly walkMeters: number; readonly detour: number }) {
  const verdict = hurryVerdict({ now, departures: [{ epoch: now + 30 + 400, live: false, lineId: null, headsign: null }], walkMps: 1.35, jogMps: 2.7, ...walk });
  expect(verdict.departure?.epoch).toBe(now + 430);
  expect(verdict.walkS).toBeCloseTo((walk.walkMeters * walk.detour) / 1.35, 9);
  return verdict;
}

describe('needsWalkRequest', () => {
  it('never asks while backing off or within 60 s of the last answered request', () => {
    expect([needsWalkRequest(null, O, 1000, [FIFTH], 1001), needsWalkRequest(null, O, 1001, [FIFTH], 1001)]).toEqual([false, true]);
    expect([needsWalkRequest(fifthCache(), south(400), 1059, [FIFTH], 0), needsWalkRequest(fifthCache(), south(400), 1060, [FIFTH], 0)]).toEqual([false, true]);
  });

  it('asks again for a stop asked from more than 150 m away, or a wanted stop never asked for', () => {
    expect([needsWalkRequest(fifthCache(), south(149.99), 5000, [FIFTH], 0), needsWalkRequest(fifthCache(), south(150.01), 5000, [FIFTH], 0)]).toEqual([false, true]);
    expect([needsWalkRequest(fifthCache(), O, 5000, [FIFTH, RIVERWALK], 0), needsWalkRequest(fifthCache(), O, 5000, [FIFTH, BAYFRONT_SOUTH], 0)]).toEqual([false, true]);
  });

  it('judges each wanted stop by the place its own entry was asked from', () => {
    // Fifth Street asked from Third Street; Bayfront South asked later, 200 m south: from 100 m south neither is due.
    const both = answered(fifthCache(), south(200), 2000, [[BAYFRONT_SOUTH, { distanceM: 400, costS: 500 }]]);
    expect([needsWalkRequest(both, south(100), 5000, [FIFTH, BAYFRONT_SOUTH], 0), needsWalkRequest(both, south(260), 5000, [BAYFRONT_SOUTH], 0)]).toEqual([false, false]);
    expect([needsWalkRequest(both, south(260), 5000, [FIFTH], 0), needsWalkRequest(both, O, 5000, [BAYFRONT_SOUTH], 0)]).toEqual([true, true]);
  });
});

describe('walkFor', () => {
  it('walks the routed metres within 300 m of where they were asked, scaled by the straight line', () => {
    const scaled = FIFTH_WALK.distanceM * (haversineMeters(south(100), FIFTH) / haversineMeters(O, FIFTH));
    expect(walkFor(fifthCache(), FIFTH, O)).toEqual({ walkMeters: FIFTH_WALK.distanceM, detour: 1, source: 'routed' });
    expect(walkFor(fifthCache(), FIFTH, south(100))).toEqual({ walkMeters: scaled, detour: 1, source: 'routed' });
  });

  it('estimates the straight line with m7c\'s detour beyond 300 m, without a walk, or without a cache', () => {
    const asked: readonly [WalkCache | null, WalkStop, LatLon][] = [[fifthCache(), FIFTH, south(300.5)], [fifthCache(), RIVERWALK, O], [null, FIFTH, O], [fifthCache(), BAYFRONT_SOUTH, O]];
    expect(asked.map(([cache, stop, at]) => walkFor(cache, stop, at))).toEqual(asked.map(([, stop, at]) => ({ walkMeters: haversineMeters(at, stop), detour: HURRY_DEFAULTS.detour, source: 'estimated' })));
    expect(HURRY_DEFAULTS.detour).toBe(1.3);
  });

  it('walks a stop at the origin unscaled, never dividing by its zero straight line', () => {
    const atOrigin = answered(null, O, 0, [[{ stopId: 'o', ...O }, { distanceM: 12, costS: 100 }]]);
    expect(walkFor(atOrigin, { stopId: 'o', ...O }, south(20))).toEqual({ walkMeters: 12, detour: 1, source: 'routed' });
    expect(walkFor(atOrigin, { stopId: 'o', ...O }, O).walkMeters).toBe(12);
  });

  it('scales each walk by its own entry\'s origin', () => {
    const both = answered(fifthCache(), south(200), 2000, [[BAYFRONT_SOUTH, { distanceM: 400, costS: 500 }]]);
    const rider = south(100);
    expect(walkFor(both, FIFTH, rider).walkMeters).toBeCloseTo(FIFTH_WALK.distanceM * (haversineMeters(rider, FIFTH) / haversineMeters(O, FIFTH)), 9);
    expect(walkFor(both, BAYFRONT_SOUTH, rider).walkMeters).toBeCloseTo(400 * (haversineMeters(rider, BAYFRONT_SOUTH) / haversineMeters(south(200), BAYFRONT_SOUTH)), 9);
  });
});

describe('stop keys (stop_id at its place)', () => {
  it('two feeds\' stops sharing a raw stop_id but standing apart never share a walk', () => {
    const elsewhere: WalkStop = { stopId: FIFTH.stopId, latitude: 25.7801, longitude: -80.2001 };
    expect(walkKey(elsewhere)).not.toBe(walkKey(FIFTH));
    expect(walkFor(fifthCache(), elsewhere, O)).toEqual({ walkMeters: haversineMeters(O, elsewhere), detour: HURRY_DEFAULTS.detour, source: 'estimated' });
    expect(needsWalkRequest(fifthCache(), O, 5000, [elsewhere], 0)).toBe(true);
    expect(requestTargets([FIFTH, elsewhere, { ...FIFTH }], O)).toEqual([FIFTH, elsewhere]);
  });

  it('keys a county stop the same every time it is read', () => {
    expect(walkKey(FIFTH)).toBe('805@25.76917,-80.19225');
    expect(walkKey({ ...FIFTH, latitude: FIFTH.latitude + 1e-7 })).toBe(walkKey(FIFTH));
  });
});

describe('merging answers into the cache', () => {
  it('a new answer replaces its own stops\' entries and keeps every other one', () => {
    const merged = answered(fifthCache(), O, 2000, [[BAYFRONT_SOUTH, { distanceM: 400, costS: 500 }], [RIVERWALK, { distanceM: 300, costS: 600 }]]);
    expect([...merged.entries.keys()].sort()).toEqual([FIFTH, RIVERWALK, BAYFRONT_SOUTH].map(walkKey).sort());
    expect(merged.entries.get(walkKey(FIFTH))).toEqual(fifthCache().entries.get(walkKey(FIFTH)));
    expect(merged.entries.get(walkKey(RIVERWALK))?.path).toEqual({ distanceM: 300, costS: 600 });
  });

  it('moving 200 m refreshes the wanted stops, and entries from more than 300 m back are dropped', () => {
    // Asked at Third Street for Fifth Street and Riverwalk; then 200 m south, only Fifth Street is still wanted.
    expect(needsWalkRequest(fifthCache(), south(200), 2000, [FIFTH], 0)).toBe(true);
    const refreshed = answered(fifthCache(), south(200), 2000, [[FIFTH, { distanceM: 650, costS: 800 }]]);
    expect(refreshed.entries.get(walkKey(FIFTH))?.origin).toEqual(south(200));
    expect(refreshed.entries.get(walkKey(RIVERWALK))?.origin).toEqual(O);
    // 350 m south of Third Street (150 m from the refresh): Riverwalk's entry, asked 350 m back, is dropped.
    const dropped = dropStaleWalks(refreshed, south(350));
    expect([...dropped.entries.keys()]).toEqual([walkKey(FIFTH)]);
    expect(dropped.lastRequestAtS).toBe(2000);
    expect(dropStaleWalks(dropped, south(350))).toBe(dropped);
    // A merge from 400 m south drops what was asked more than 300 m from there, too.
    expect([...answered(refreshed, south(400), 3000, [[BAYFRONT_SOUTH, null]]).entries.keys()].sort()).toEqual([FIFTH, BAYFRONT_SOUTH].map(walkKey).sort());
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
    expect([nextWalkCheckS(fifthCache(), south(200), [FIFTH], 0), nextWalkCheckS(fifthCache(), south(200), [FIFTH], 1300), nextWalkCheckS(fifthCache(), O, [FIFTH], 0), nextWalkCheckS(null, O, [FIFTH], 1500)]).toEqual([1060, 1300, null, 1500]);
  });
});

describe('the committed one-to-many capture from Third Street (815)', () => {
  it('the fixture walk says jog where the estimate says chill', () => {
    const parsed = parseWalkTimes(fixture.response, fixture.request.many.length);
    const stops = fixture.request.many.map((target) => ({ stopId: target.stopId, latitude: target.lat, longitude: target.lon }));
    const walks = parsed.ok ? parsed.value : [];
    const cache = answered(null, O, 0, stops.map((stop, i) => [stop, walks[i] ?? null] as const));
    const ratios = stops.map((stop) => Number(((cache.entries.get(walkKey(stop))?.path?.distanceM ?? 0) / haversineMeters(O, stop)).toFixed(2)));
    const estimated = oneTrainVerdict(1_790_000_000, walkFor(null, FIFTH, O));
    const routed = oneTrainVerdict(1_790_000_000, walkFor(cache, FIFTH, O));
    expect(stops.map((stop) => stop.stopId)).toEqual(['806', '805', '804', '807', '808']);
    expect(ratios).toEqual([2.03, 2.08, 1.31, 1.63, 1.19]);
    expect([estimated.kind, routed.kind]).toEqual(['CHILL', 'JOG']);
    expect([estimated.walkS, routed.walkS, routed.jogS].map((s) => Number(s.toFixed(2)))).toEqual([329.36, 526.4, 263.2]);
  });
});
