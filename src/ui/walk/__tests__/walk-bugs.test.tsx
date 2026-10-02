import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { FakeServer, runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { unmountAll } from '../../primitives/__tests__/render-primitive';
import { askedAt, E503, FIFTH, FIVE, mountWalks, moveTo, O, resetRig, scriptedWalks, statusSeen, step, stepUntil, walkSeen } from './walk-rig';

// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('./walk-location').locationModule());

/**
 * mfix9 fix round (arbiter Q2): failures and bugs are VISIBLE. A request is detached work (src/live/detach.ts), and every
 * expected failure is a Result, so a throw while handling an answer — or an injected fetchWalk that rejects — is a BUG:
 * it reaches the bug channel the live runtime's own bugs use (LiveRuntime.reportBug → its state's internalError), and
 * the provider backs off instead of asking again at once. An ordinary failure stays quiet (a backoff) but is kept as
 * the status's lastError for Diagnostics. The live runtime here is a REAL one over in-memory stores and a silent server.
 */

const NOW_S = Date.parse('2026-09-30T08:00:00-04:00') / 1000;

/** A started live runtime over an in-memory Keychain and quota store, and every state it publishes. */
function liveRuntime(): { readonly runtime: LiveRuntime; readonly states: LiveState[] } {
  const states: LiveState[] = [];
  const keys = new Map<string, string>();
  const runtime = new LiveRuntime({
    network: runtimeNetwork(),
    onChange: (state) => void states.push(state),
    fetch: new FakeServer({}).fetch,
    nowS: () => NOW_S,
    keychain: { getItemAsync: (k) => Promise.resolve(keys.get(k) ?? null), setItemAsync: (k, v) => Promise.resolve(void keys.set(k, v)), deleteItemAsync: (k) => Promise.resolve(void keys.delete(k)) },
    quotaStore: { get: () => null, set: () => undefined },
  });
  runtime.start();
  expect(runtime.isStarted()).toBe(true);
  expect(states.at(-1)?.internalError).toBeNull();
  return { runtime, states };
}

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
    const { runtime, states } = liveRuntime();
    const walks = scriptedWalks(['throwing', 'rejecting']);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { state: null, runtime });
    await moveTo(O);
    await step(2);
    expect(states.at(-1)?.internalError).toBe('Routed walks: a walk answer could not be handled: Error: the answer broke while it was read');
    expect(statusSeen.latest?.bug?.message).toBe('a walk answer could not be handled: Error: the answer broke while it was read');
    // The broken request counts as a failure: the next attempt waits the backoff, and a rejected fetchWalk is a bug too.
    await stepUntil(askedAt(walks.asked, 0) + 59);
    expect(walks.asked).toHaveLength(1);
    await stepUntil(askedAt(walks.asked, 0) + 61);
    expect(states.at(-1)?.internalError).toBe('Routed walks: a walk answer could not be handled: Error: fetchWalk rejected');
    await stepUntil(askedAt(walks.asked, 1) + 121);
    expect(walks.asked).toHaveLength(3);
    expect(walkSeen('a', FIFTH).source).toBe('routed');
    runtime.stop();
  });
});

describe('an ordinary failure stays quiet, and is kept for Diagnostics', () => {
  it('keeps a failed request as the status\'s lastError, never a bug, until a request succeeds', async () => {
    const { runtime, states } = liveRuntime();
    const walks = scriptedWalks([E503]);
    await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { state: null, runtime });
    await moveTo(O);
    await step(2);
    expect([statusSeen.latest?.lastError, statusSeen.latest?.bug, states.at(-1)?.internalError]).toEqual([E503, null, null]);
    expect(walkSeen('a', FIFTH).source).toBe('estimated');
    await stepUntil(askedAt(walks.asked, 0) + 61);
    expect(walks.asked).toHaveLength(2);
    expect([statusSeen.latest?.lastError, walkSeen('a', FIFTH).source]).toEqual([null, 'routed']);
    runtime.stop();
  });
});
