import { AppState } from 'react-native';
import { act } from 'react-test-renderer';

import { unmountAll } from '../../primitives/__tests__/render-primitive';
import { type Asked, askedAt, E503, FIFTH, FIVE, type LiveRig, liveRuntime, mountWalks, moveTo, O, resetRig, scriptedWalks, south, statusSeen, step, stepUntil, visibility, walkSeen } from './walk-rig';

// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('./walk-location').locationModule());

/**
 * mfix9 fix rounds (arbiter Q2, then Z2 and Z5): failures and bugs are VISIBLE, and only the request in flight touches
 * the walks. A request is detached work (src/live/detach.ts), and every expected failure is a Result, so a throw while
 * handling an answer — or an injected fetchWalk that rejects — is a BUG: it reaches the bug channel the live runtime's
 * own bugs use (LiveRuntime.reportBug → its state's internalError) through the reporter the request started with, even
 * after the provider has gone, and the provider backs off instead of asking again at once. An ordinary failure stays
 * quiet (a backoff) but is kept as the status's lastError for Diagnostics. A request the provider abandoned (hidden,
 * backgrounded, unmounted) leaves the walks alone: its late answer is dropped unread. The live runtime here is a REAL
 * one over in-memory stores and a silent server.
 */

const NOW_S = Date.parse('2026-09-30T08:00:00-04:00') / 1000;
const REJECTED = 'Routed walks: a walk answer could not be handled: Error: fetchWalk rejected';

beforeEach(() => {
  resetRig();
  jest.useFakeTimers({ now: NOW_S * 1000, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
});

describe('a bug in handling a walk answer is never lost', () => {
  it('a throwing answer handler reaches the bug channel', async () => {
    const live = liveRuntime();
    const walks = scriptedWalks(['throwing', 'rejecting']);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { live });
    await moveTo(O);
    await step(2);
    expect(live.states.at(-1)?.internalError).toBe('Routed walks: a walk answer could not be handled: Error: the answer broke while it was read');
    expect(statusSeen.latest?.bug?.message).toBe('a walk answer could not be handled: Error: the answer broke while it was read');
    // The broken request counts as a failure: the next attempt waits the backoff, and a rejected fetchWalk is a bug too.
    await stepUntil(askedAt(walks.asked, 0) + 59);
    expect(walks.asked).toHaveLength(1);
    await stepUntil(askedAt(walks.asked, 0) + 61);
    expect(live.states.at(-1)?.internalError).toBe(REJECTED);
    await stepUntil(askedAt(walks.asked, 1) + 121);
    expect(walks.asked).toHaveLength(3);
    expect(walkSeen('a', FIFTH).source).toBe('routed');
    live.runtime.stop();
  });

  // ARBITER Z5 (review of 7c0bab8): the bug goes through the reporter captured when the request started, never through
  // the provider's state, which dies with it.
  it('a walk bug after the provider unmounts still reaches the bug channel', async () => {
    const live = liveRuntime();
    const walks = scriptedWalks(['held']);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { live });
    await moveTo(O);
    await step(2);
    expect(walks.asked).toHaveLength(1);
    await unmountAll();
    expect([walks.signals[0]?.aborted, live.runtime.isStarted(), live.states.at(-1)?.internalError]).toEqual([true, true, null]);
    const published = live.states.length;
    await act(async () => walks.land(0, 'rejecting'));
    await step(1);
    expect(live.states.slice(published).map((state) => state.internalError)).toEqual([REJECTED]);
    expect(walks.asked).toHaveLength(1);
    live.runtime.stop();
  });
});

describe('an ordinary failure stays quiet, and is kept for Diagnostics', () => {
  it('keeps a failed request as the status\'s lastError, never a bug, until a request succeeds', async () => {
    const live = liveRuntime();
    const walks = scriptedWalks([E503]);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { live });
    await moveTo(O);
    await step(2);
    expect([statusSeen.latest?.lastError, statusSeen.latest?.bug, live.states.at(-1)?.internalError]).toEqual([E503, null, null]);
    expect(walkSeen('a', FIFTH).source).toBe('estimated');
    await stepUntil(askedAt(walks.asked, 0) + 61);
    expect(walks.asked).toHaveLength(2);
    expect([statusSeen.latest?.lastError, walkSeen('a', FIFTH).source]).toEqual([null, 'routed']);
    live.runtime.stop();
  });
});

describe('an abandoned request never touches the walks', () => {
  // ARBITER Z2 (review of 7c0bab8): an answer is applied only by the request that is currently in flight.
  it("an abandoned request's late answer is dropped quietly", async () => {
    const live = liveRuntime();
    const walks = scriptedWalks(['held', 'held', 'held', 'held']);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { live });
    await moveTo(O);
    await step(2);
    // Hidden and shown again (an <Activity>; Fast Refresh does the same to effects): request 0 is abandoned, 1 asked.
    await act(async () => visibility.set('hidden'));
    await act(async () => visibility.set('visible'));
    await step(1);
    expect([walks.asked.length, walks.signals.map((signal) => signal.aborted)]).toEqual([2, [true, false]]);
    await expectDroppedQuietly(() => walks.land(0, 'walks'), live, walks.asked);
    expect(walkSeen('a', FIFTH).source).toBe('estimated');
    await act(async () => walks.land(1, 'walks'));
    await step(1);
    expect([statusSeen.latest?.cache?.lastRequestAtS, walkSeen('a', FIFTH).source]).toEqual([askedAt(walks.asked, 1), 'routed']);
    // To the background and back: request 2 (200 m on, 60 s later) is abandoned, 3 asked; 2's late answer would throw if read.
    await stepUntil(askedAt(walks.asked, 1) + 60);
    await moveTo(south(200));
    await step(1);
    await act(async () => appState('background'));
    await act(async () => appState('active'));
    await step(1);
    expect([walks.asked.length, walks.signals.map((signal) => signal.aborted)]).toEqual([4, [true, false, true, false]]);
    await expectDroppedQuietly(() => walks.land(2, 'throwing'), live, walks.asked);
    await act(async () => walks.land(3, 'walks'));
    await step(1);
    expect([statusSeen.latest?.cache?.lastRequestAtS, statusSeen.latest?.bug, live.states.at(-1)?.internalError]).toEqual([askedAt(walks.asked, 3), null, null]);
    live.runtime.stop();
  });
});

/** An abandoned request's answer lands: nothing changes — not the status, not the bug channel, not the requests. */
async function expectDroppedQuietly(landLate: () => void, live: LiveRig, asked: readonly Asked[]): Promise<void> {
  const [before, published, requests] = [statusSeen.latest, live.states.length, asked.length];
  await act(async () => landLate());
  await step(2);
  expect(statusSeen.latest).toBe(before);
  expect([before?.lastError, before?.bug]).toEqual([null, null]);
  expect(live.states.slice(published).filter((state) => state.internalError !== null)).toEqual([]);
  expect(asked).toHaveLength(requests);
}

/** The app moves to `state`: every AppState 'change' listener hears it (react-native's jest mock records them). */
function appState(state: 'background' | 'active'): void {
  const listeners = jest.mocked(AppState.addEventListener).mock.calls.filter(([event]) => event === 'change').map(([, listener]) => listener);
  expect(listeners.length).toBeGreaterThan(0);
  Object.assign(AppState, { currentState: state });
  listeners.forEach((listener) => listener(state));
  expect(AppState.currentState).toBe(state);
}
