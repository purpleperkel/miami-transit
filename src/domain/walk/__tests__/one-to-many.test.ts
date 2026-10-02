import type { LatLon } from '../../../lib/geo';
import { buildPlanRequest } from '../../routes/transitous';
import fixture from '../__fixtures__/transitous-one-to-many.json';
import { buildWalkRequest, parseWalkTimes, WALK_MAX_TARGETS, WALK_ROUTER_URL, type WalkPath } from '../one-to-many';

/**
 * mfix9 A: the Transitous one-to-many walk client. The places are PUBLIC GTFS stops (schedule.db): the rider at Third
 * Street (815), the targets Fifth Street (805) and Riverwalk (806) — the committed capture's origin and two of its targets.
 */

const THIRD_STREET: LatLon = { latitude: 25.772024, longitude: -80.193508 };
const FIFTH_STREET: LatLon = { latitude: 25.769165, longitude: -80.192248 };
const RIVERWALK: LatLon = { latitude: 25.771051, longitude: -80.192558 };

/** `count` targets 10 m apart, due north of Third Street. */
function northward(count: number): LatLon[] {
  const targets = Array.from({ length: count }, (_, i) => ({ latitude: THIRD_STREET.latitude + (10 * (i + 1)) / 111_195, longitude: THIRD_STREET.longitude }));
  expect(targets).toHaveLength(count);
  expect(new Set(targets.map((t) => t.latitude)).size).toBe(count);
  return targets;
}

describe('buildWalkRequest', () => {
  it('writes the one-to-many query out literally, under the same User-Agent the plan client sends', () => {
    const request = buildWalkRequest(THIRD_STREET, [FIFTH_STREET, RIVERWALK], '2.3.4');
    const planAgent = buildPlanRequest({ from: THIRD_STREET, to: FIFTH_STREET, timeEpoch: 1_790_881_200, arriveBy: false }, '2.3.4').headers['User-Agent'];
    expect(request.ok && request.value.url).toBe(
      `${WALK_ROUTER_URL}?one=25.772024;-80.193508&many=25.769165;-80.192248,25.771051;-80.192558&mode=WALK&max=3600&maxMatchingDistance=250&arriveBy=false&withDistance=true`,
    );
    expect(request.ok && request.value.headers).toEqual({ 'User-Agent': planAgent });
  });

  it('carries up to the server limit of 128 targets in one request', () => {
    const request = buildWalkRequest(THIRD_STREET, northward(WALK_MAX_TARGETS), '1.0.0');
    expect(request.ok && request.value.url.split(';')).toHaveLength(WALK_MAX_TARGETS + 2);
    expect(WALK_MAX_TARGETS).toBe(128);
  });

  it('refuses no target, more than the server limit, and a coordinate that is not finite', () => {
    const refused = [
      buildWalkRequest(THIRD_STREET, [], '1.0.0'),
      buildWalkRequest(THIRD_STREET, northward(WALK_MAX_TARGETS + 1), '1.0.0'),
      buildWalkRequest({ latitude: Number.NaN, longitude: THIRD_STREET.longitude }, [FIFTH_STREET], '1.0.0'),
      buildWalkRequest(THIRD_STREET, [FIFTH_STREET, { latitude: 25.7, longitude: Number.POSITIVE_INFINITY }], '1.0.0'),
    ];
    expect(refused.map((r) => (r.ok ? 'ok' : r.error.kind))).toEqual(['bad-request', 'bad-request', 'bad-request', 'bad-request']);
    expect(refused.map((r) => (r.ok ? '' : r.error.message))).toEqual([
      'a one-to-many request carries 1 to 128 targets, got 0',
      'a one-to-many request carries 1 to 128 targets, got 129',
      'the origin NaN;-80.193508 is not a finite coordinate',
      'target 1 is not a finite coordinate',
    ]);
  });
});

describe('parseWalkTimes', () => {
  it('reads the committed capture as street distances, keeping each routing cost apart from the walk', () => {
    const parsed = parseWalkTimes(fixture.response, fixture.request.many.length);
    const walks: (WalkPath | null)[] = parsed.ok ? [...parsed.value] : [];
    expect(walks).toEqual(fixture.response.map((answer) => ({ distanceM: answer.distance, costS: answer.duration })));
    // Riverwalk: 292.7 m along the streets for a "duration" of 519 s — 0.56 m/s, a routing cost and never a walking time.
    expect(walks[0]).toEqual({ distanceM: 292.7103862762451, costS: 519 });
  });

  it('reads {} as a target no walk reaches', () => {
    const first = parseWalkTimes([{}, { duration: 0, distance: 0 }], 2);
    const last = parseWalkTimes([{ duration: 519, distance: 292.7 }, {}], 2);
    expect(first.ok && first.value).toEqual([null, { distanceM: 0, costS: 0 }]);
    expect(last.ok && last.value).toEqual([{ distanceM: 292.7, costS: 519 }, null]);
  });

  it('refuses anything but one {} or {duration, distance} per target, finite and non-negative', () => {
    const bodies: readonly [unknown, number][] = [
      [[{}], 2],
      [{}, 1],
      [null, 1],
      [[{ duration: 5 }], 1],
      [[{ distance: 5 }], 1],
      [[{ distance: -1, duration: 5 }], 1],
      [[{ distance: 5, duration: Number.NaN }], 1],
      [[{ distance: '5', duration: 5 }], 1],
      [[null], 1],
      [[[5, 5]], 1],
    ];
    const kinds = bodies.map(([body, n]) => {
      const parsed = parseWalkTimes(body, n);
      return parsed.ok ? 'ok' : parsed.error.kind;
    });
    expect(kinds).toEqual(bodies.map(() => 'malformed'));
    expect(parseWalkTimes([{}, { duration: 5 }], 2)).toEqual({ ok: false, error: { kind: 'malformed', message: expect.stringContaining('walk 1:') } });
  });
});

describe('parseWalkTimes never throws', () => {
  it('reads an answer for a count of targets no request carries as an Err, never a throw', () => {
    const counts = [0, -1, WALK_MAX_TARGETS + 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
    const read = counts.map((n) => parseWalkTimes([], n));
    expect(read.map((r) => (r.ok ? 'ok' : r.error.kind))).toEqual(counts.map(() => 'malformed'));
    expect(read.map((r) => (r.ok ? '' : r.error.message))).toEqual(counts.map((n) => `an answer is read for the 1 to 128 targets a request carries, got ${n}`));
  });

  it('refuses a walk with any key besides its distance and duration, and still reads {} as no walk', () => {
    const extra = [{ duration: 519, distance: 292.7, geometry: 'kv}oC~dbiN' }, { distance: 292.7, duration: 519, steps: [] }, { error: 'no route' }];
    const kinds = extra.map((entry) => parseWalkTimes([{}, entry], 2)).map((r) => (r.ok ? 'ok' : r.error.message));
    expect(kinds).toEqual([
      'walk 1: want {} or exactly a finite, non-negative {duration, distance}, got keys ["distance","duration","geometry"] with distance 292.7, duration 519',
      'walk 1: want {} or exactly a finite, non-negative {duration, distance}, got keys ["distance","duration","steps"] with distance 292.7, duration 519',
      'walk 1: want {} or exactly a finite, non-negative {duration, distance}, got keys ["error"] with distance undefined, duration undefined',
    ]);
    expect(parseWalkTimes([{}, { distance: 292.7, duration: 519 }], 2)).toEqual({ ok: true, value: [null, { distanceM: 292.7, costS: 519 }] });
  });

  // ARBITER Z1 (review of 7c0bab8): JSON can name a key "", and ["", ...].join(',') reads exactly like no key at all.
  it('an entry whose only key is empty is an Err, never a throw', () => {
    const bodies: readonly string[] = ['[{"": 5}]', '[{}, {"": 5, "distance": 5, "duration": 5}]', '[{"": null}]', '[{"distance": 5, "": 5}]'];
    const read = bodies.map((text) => {
      const body: unknown = JSON.parse(text);
      return parseWalkTimes(body, (body as unknown[]).length);
    });
    expect(read.map((r) => (r.ok ? 'ok' : r.error.kind))).toEqual(bodies.map(() => 'malformed'));
    expect(read.map((r) => (r.ok ? '' : r.error.message))).toEqual([
      'walk 0: want {} or exactly a finite, non-negative {duration, distance}, got keys [""] with distance undefined, duration undefined',
      'walk 1: want {} or exactly a finite, non-negative {duration, distance}, got keys ["","distance","duration"] with distance 5, duration 5',
      'walk 0: want {} or exactly a finite, non-negative {duration, distance}, got keys [""] with distance undefined, duration undefined',
      'walk 0: want {} or exactly a finite, non-negative {duration, distance}, got keys ["","distance"] with distance 5, duration undefined',
    ]);
    expect(parseWalkTimes(JSON.parse('[{}]'), 1)).toEqual({ ok: true, value: [null] });
  });
});
