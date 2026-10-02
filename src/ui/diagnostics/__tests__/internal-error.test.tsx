import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import { unmountAll } from '../../primitives/__tests__/render-primitive';
import { askedAt, E503, FIVE, liveRuntime, mountWalks, moveTo, O, resetRig, scriptedWalks, south, step, stepUntil } from '../../walk/__tests__/walk-rig';
import { DiagnosticsScreen } from '../DiagnosticsScreen';

// test-time mock of native module
jest.mock('expo-location', () => jest.requireActual('../../walk/__tests__/walk-location').locationModule());

/**
 * mfix9 (arbiter Z4): Diagnostics shows the bug channel. src/live/detach.ts sends every bug in detached work to the live
 * state's internalError "shown by Diagnostics", and the routed-walk runtime keeps its own latest answer, failure and bug
 * (useWalkStatus). The REAL Diagnostics screen renders inside the REAL RoutedWalkProvider under a REAL started
 * LiveRuntime (walk-rig.tsx), as the root layout mounts them; the walks are answered by the rig's injected fetchWalk.
 */

const NOW_S = Date.parse('2026-09-30T08:00:00-04:00') / 1000;
const BROKE = 'a walk answer could not be handled: Error: the answer broke while it was read';

beforeEach(() => {
  resetRig();
  jest.useFakeTimers({ now: NOW_S * 1000, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});

afterEach(async () => {
  await unmountAll();
  jest.useRealTimers();
});

/** The lines of the Diagnostics row with testID `id` in `tree`: its title, then each line it shows. */
function rowLines(tree: ReactTestRenderer, id: string): string[] {
  const rows = tree.root.findAll((node: ReactTestInstance) => typeof node.type === 'string' && node.props.testID === id);
  expect(rows).toHaveLength(1);
  const texts = rows[0]?.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string') ?? [];
  expect(texts.length).toBeGreaterThan(1);
  return texts.map((node) => node.props.children as string);
}

describe('Diagnostics shows the bug channel (mfix9 Z4)', () => {
  it('diagnostics shows the live runtime internal error and the routed walks status', async () => {
    const live = liveRuntime();
    const walks = scriptedWalks(['walks', E503, 'throwing']);
    const tree = await mountWalks(walks.fetchWalk, { a: FIVE }, ['a'], { live, beside: <DiagnosticsScreen /> });
    expect(rowLines(tree, 'live-data').slice(0, 2)).toEqual(['Live data', 'No bug reported']);
    expect(rowLines(tree, 'routed-walks').slice(0, 4)).toEqual(['Routed walks', 'Last answer: none yet', 'Last error: none', 'Bug: none']);
    // Request 0 answers; 60 s later the rider is 200 m on and request 1 fails (503); 60 s after that request 2 breaks.
    await moveTo(O);
    await step(2);
    await stepUntil(askedAt(walks.asked, 0) + 60);
    await moveTo(south(200));
    await step(2);
    expect(rowLines(tree, 'routed-walks').slice(1, 4)).toEqual(['Last answer: asked 1 min ago', `Last error: ${E503.message}`, 'Bug: none']);
    await stepUntil(askedAt(walks.asked, 1) + 61);
    expect(walks.asked).toHaveLength(3);
    expect(live.states.at(-1)?.internalError).toBe(`Routed walks: ${BROKE}`);
    expect(rowLines(tree, 'live-data').slice(0, 2)).toEqual(['Live data', `Bug: Routed walks: ${BROKE}`]);
    expect(rowLines(tree, 'routed-walks').slice(0, 4)).toEqual(['Routed walks', 'Last answer: asked 2 min ago', `Last error: ${E503.message}`, `Bug: ${BROKE}`]);
    live.runtime.stop();
  });
});
