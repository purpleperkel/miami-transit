import { act } from 'react-test-renderer';

import { walkKey, type WalkStop } from '../../../domain/walk/walk-cache';
import type { LatLon } from '../../../lib/geo';
import { unmountAll } from '../../primitives/__tests__/render-primitive';
import { askedAt, consumers, FIVE, mountWalks, moveTo, north, O, resetRig, scriptedWalks, south, statusSeen, step, stepUntil, walkSeen } from './walk-rig';

// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('./walk-location').locationModule());

/**
 * mfix9 fix round (arbiter Q1): the cache is PER ENTRY and MERGED. Each stop's entry keeps the place and instant it was
 * answered from; a new answer replaces only its own stops' entries. So consumers that want different stops cost one
 * request each and then none while the rider stands still, stops jittering across the 128th/129th boundary keep their
 * entries, and an entry is dropped only once the rider is more than 300 m from where it was asked. walk-rig.tsx runs the
 * provider under the REAL UserLocationProvider with an injected fetchWalk; the fake clock moves 1 s per act.
 */

const X = FIVE.slice(0, 2);
const Y = FIVE.slice(2);

beforeEach(() => {
  resetRig();
  jest.useFakeTimers({ now: Date.parse('2026-09-30T08:00:00-04:00'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
});

/** The keys of the walks the provider holds, sorted. */
function heldKeys(): string[] {
  const cache = statusSeen.latest?.cache ?? null;
  expect(cache).not.toBeNull();
  expect(cache?.entries.size).toBeGreaterThan(0);
  return [...(cache?.entries.keys() ?? [])].sort();
}

/** Where the provider's walk to `stop` was asked from. */
function askedFrom(stop: WalkStop): LatLon | undefined {
  const entry = statusSeen.latest?.cache?.entries.get(walkKey(stop));
  expect(entry === undefined || entry.requestedAtS > 0).toBe(true);
  expect(entry === undefined || entry.straightAtOrigin >= 0).toBe(true);
  return entry?.origin;
}

describe('one request per stop set, then none while the rider stands still', () => {
  it('alternating stop sets, the rider still for 10 minutes, cost exactly 2 requests', async () => {
    const walks = scriptedWalks();
    await mountWalks(walks.fetchWalk, { x: X, y: Y }, ['x']);
    await moveTo(O);
    await step(2);
    for (let flip = 0; flip < 20; flip += 1) {
      await act(async () => consumers.show(flip % 2 === 0 ? ['y'] : ['x']));
      await step(30);
    }
    expect(walks.asked.map((asked) => asked.many.length)).toEqual([X.length, Y.length]);
    expect(walkSeen('x', X[0] as WalkStop).source).toBe('routed');
  });

  it('130 wanted stops, the rider jittering 3 m for 10 minutes, ask nothing after the first round', async () => {
    // 127 stops north of the rider, the 128th 1280 m north and the 129th 1280.5 m south: 1.5 m of jitter either way
    // swaps them across WALK_MAX_TARGETS. The 130th is far away and never among the nearest 128.
    const stops: WalkStop[] = [...Array.from({ length: 128 }, (_, i) => ({ stopId: `n${i + 1}`, ...north(10 * (i + 1)) })), { stopId: 's129', ...south(1280.5) }, { stopId: 'far', ...north(3000) }];
    const walks = scriptedWalks();
    await mountWalks(walks.fetchWalk, { all: stops }, ['all']);
    await moveTo(north(1.5));
    await step(2);
    for (let jitter = 0; jitter < 30; jitter += 1) {
      await moveTo(jitter % 2 === 0 ? south(1.5) : north(1.5));
      await step(20);
    }
    // The first round: the nearest 128, then (once the gap ends) the 129th as it swaps in. Nothing after it.
    expect(walks.asked).toHaveLength(2);
    expect(askedAt(walks.asked, 1) - askedAt(walks.asked, 0)).toBeLessThanOrEqual(80);
    expect(heldKeys()).toEqual(stops.slice(0, 129).map(walkKey).sort());
  });
});

describe('a move refreshes what is wanted; what is far behind is dropped', () => {
  it('moving 200 m refreshes the wanted stops, and entries from more than 300 m back are dropped', async () => {
    const walks = scriptedWalks();
    await mountWalks(walks.fetchWalk, { x: X, y: Y }, ['x', 'y']);
    await moveTo(O);
    await step(2);
    await act(async () => consumers.show(['x']));
    await stepUntil(askedAt(walks.asked, 0) + 61);
    await moveTo(south(200));
    await step(2);
    // Only the wanted stops are asked again, from where the rider is; the others keep their entries from 200 m back.
    expect(walks.asked.map((asked) => [asked.one, asked.many.length])).toEqual([[O, 5], [south(200), 2]]);
    expect([...X.map(askedFrom), ...Y.map(askedFrom)]).toEqual([south(200), south(200), O, O, O]);
    // 350 m from Third Street (150 m from the refresh): no request, and the entries asked 350 m back are dropped.
    await moveTo(south(350));
    await step(1);
    expect(walks.asked).toHaveLength(2);
    expect(heldKeys()).toEqual(X.map(walkKey).sort());
    // Wanted again, the dropped stops are asked for again once the gap ends.
    await act(async () => consumers.show(['x', 'y']));
    await stepUntil(askedAt(walks.asked, 1) + 61);
    expect(walks.asked.map((asked) => [asked.one, asked.many.length])).toEqual([[O, 5], [south(200), 2], [south(350), 5]]);
  });
});
