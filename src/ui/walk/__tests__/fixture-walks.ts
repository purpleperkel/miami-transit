import fixture from '../../../domain/walk/__fixtures__/transitous-one-to-many.json';
import type { LiveError } from '../../../domain/live/types';
import { WALK_ROUTER_URL } from '../../../domain/walk/one-to-many';
import { haversineMeters, type LatLon } from '../../../lib/geo';
import { err, ok } from '../../../lib/result';
import type { WalkFetch } from '../RoutedWalkProvider';

/**
 * mfix9: injected fetchWalks for the walk tests (no network): one answering from the committed one-to-many capture
 * (src/domain/walk/__fixtures__/transitous-one-to-many.json, asked from Third Street — a PUBLIC GTFS stop, 815 — never
 * a rider's position), one that always fails, and one answering street walks twice the straight line.
 */

/** GTFS stop 815 (Third Street): where the capture was asked from, and where these tests stand the rider. */
export const THIRD_STREET: LatLon = { latitude: fixture.request.one.lat, longitude: fixture.request.one.lon };

/** A fetchWalk and the one-to-many URLs it was asked for. */
export type RecordedWalks = { readonly fetchWalk: WalkFetch; readonly asked: string[] };

/** fetchWalk answering from the capture: each target by its coordinates, {} (no walk) for one the capture does not hold. */
export function fixtureWalks(): RecordedWalks {
  const byPoint = new Map<string, unknown>(fixture.request.many.map((target, i) => [`${target.lat};${target.lon}`, fixture.response[i]]));
  const asked: string[] = [];
  expect(byPoint.size).toBe(fixture.response.length);
  expect(fixture.request.one.stopId).toBe('815');
  return {
    asked,
    fetchWalk: (request, signal) => {
      asked.push(request.url);
      const query = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1));
      expect(query.get('one')).toBe(`${THIRD_STREET.latitude};${THIRD_STREET.longitude}`);
      expect(signal.aborted).toBe(false);
      return Promise.resolve(ok((query.get('many') ?? '').split(',').map((target) => byPoint.get(target) ?? {})));
    },
  };
}

/** fetchWalk whose every request fails with `failure` (as a 503 from Transitous would). */
export function failingWalks(failure: LiveError): RecordedWalks {
  const asked: string[] = [];
  expect(failure.message.length).toBeGreaterThan(0);
  expect(['http', 'network', 'timeout', 'decode']).toContain(failure.kind);
  return {
    asked,
    fetchWalk: (request) => {
      asked.push(request.url);
      return Promise.resolve(err(failure));
    },
  };
}

/** A one-to-many request as asked: where from, and to where. */
export type AskedWalks = { readonly one: LatLon; readonly many: readonly LatLon[] };

/** A `<lat>;<lon>` of the one-to-many query, as a coordinate. */
export function queryPoint(text: string): LatLon {
  const parts = text.split(';').map(Number);
  expect(parts).toHaveLength(2);
  expect(parts.every(Number.isFinite)).toBe(true);
  return { latitude: parts[0] as number, longitude: parts[1] as number };
}

/**
 * A fetchWalk answering every target with a street walk twice the straight line (no detour), so a routed walk never
 * reads as m7c's estimate (1.3x); `asked` records each request's origin and targets.
 */
export class DoubledWalks {
  readonly asked: AskedWalks[] = [];

  readonly fetchWalk: WalkFetch = (request, signal) => {
    const query = new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1));
    const one = queryPoint(query.get('one') ?? '');
    const many = (query.get('many') ?? '').split(',').map(queryPoint);
    expect([request.url.startsWith(`${WALK_ROUTER_URL}?`), signal.aborted]).toEqual([true, false]);
    expect(Object.keys(request.headers)).toEqual(['User-Agent']);
    this.asked.push({ one, many });
    return Promise.resolve(ok(many.map((target) => ({ duration: 1, distance: 2 * haversineMeters(one, target) }))));
  };
}
