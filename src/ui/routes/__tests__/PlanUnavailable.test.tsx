import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { PlanUnavailable } from '../PlanUnavailable';
import { END } from './route-fixtures';

/**
 * Plan M10b.2: when the sheet has no options (the polite client's { kind: 'unavailable' }), the rider
 * still gets there — "Open in Apple Maps" asks Apple Maps for transit directions (dirflg=r).
 */

const TRANSIT_TO_BRICKELL = 'maps://?daddr=25.7584,-80.1937&dirflg=r';

afterEach(async () => {
  await unmountAll();
});

describe('no route options (M10b.2)', () => {
  it('unavailable routes offer Open in Apple Maps with dirflg=r', async () => {
    const openURL = jest.fn(async (_url: string): Promise<void> => undefined);
    const tree = await renderPrimitive(<PlanUnavailable reason="HTTP 503, then after a 2000 ms backoff: HTTP 503" destination={END} openURL={openURL} />);
    expect(hostsByTestID(tree.root, 'plan-unavailable-reason')[0]?.props.children).toBe('HTTP 503, then after a 2000 ms backoff: HTTP 503');
    expect(hostsByTestID(tree.root, 'plan-open-apple-maps')[0]?.props.accessibilityLabel).toBe('Open in Apple Maps');
    await press(tree, 'plan-open-apple-maps');
    expect(openURL.mock.calls).toEqual([[TRANSIT_TO_BRICKELL]]);
    expect(TRANSIT_TO_BRICKELL.endsWith('&dirflg=r')).toBe(true);
    expect(hostsByTestID(tree.root, 'plan-apple-maps-failed')).toHaveLength(0);
  });

  it('says so when Apple Maps would not open either', async () => {
    const openURL = jest.fn(async (_url: string): Promise<void> => Promise.reject(new Error('no Maps')));
    const tree = await renderPrimitive(<PlanUnavailable reason="network: offline" destination={END} openURL={openURL} />);
    await press(tree, 'plan-open-apple-maps');
    expect(openURL.mock.calls).toEqual([[TRANSIT_TO_BRICKELL], ['https://maps.apple.com/?daddr=25.7584,-80.1937&dirflg=r']]);
    expect(hostsByTestID(tree.root, 'plan-apple-maps-failed')[0]?.props.children).toBe('Apple Maps did not open: no Maps');
  });
});
