import { Linking } from 'react-native';

import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { StationSheetFooter } from '../StationSheetFooter';
import { press } from './press';

/**
 * M6.4 + M7.6: the station sheet's walk directions, handed to Apple Maps through the domain handoff.
 * React Native's Linking.openURL is the real door (spied on, never mocked away): it is Promise<void>,
 * so resolving — even with undefined — means Apple Maps opened (M1.19); only a rejection fails.
 */

const GOVERNMENT_CENTER = { latitude: 25.7745, longitude: -80.1957 };
const WALK_URL = 'maps://?daddr=25.7745,-80.1957&dirflg=w';
const WEB_WALK_URL = 'https://maps.apple.com/?daddr=25.7745,-80.1957&dirflg=w';

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});

/**
 * A spy on Linking.openURL with no calls and no answers yet. jest-expo already stubs Linking.openURL
 * with a jest.fn, which spyOn hands back as is (restoreAllMocks cannot undo it), so it is reset here.
 */
function spyOpenURL(): jest.SpyInstance<Promise<void>, [url: string]> {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockReset();
  expect(spy).not.toHaveBeenCalled();
  expect(jest.isMockFunction(Linking.openURL)).toBe(true);
  return spy;
}

describe('StationSheetFooter: walk directions (M6.4)', () => {
  it('walk directions open Apple Maps with dirflg=w to the station', async () => {
    const openURL = spyOpenURL().mockResolvedValue(undefined);
    const tree = await renderPrimitive(<StationSheetFooter coordinate={GOVERNMENT_CENTER} />);
    expect(hostsByTestID(tree.root, 'station-walk-directions')[0]?.props.accessibilityLabel).toBe('Walk directions');
    await press(tree, 'station-walk-directions');
    expect(openURL.mock.calls).toEqual([[WALK_URL]]);
  });

  it('openURL resolving undefined counts as opened', async () => {
    const openURL = spyOpenURL().mockResolvedValue(undefined);
    const tree = await renderPrimitive(<StationSheetFooter coordinate={GOVERNMENT_CENTER} />);
    await press(tree, 'station-walk-directions');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(hostsByTestID(tree.root, 'station-walk-failed')).toHaveLength(0);
  });

  it('openURL rejecting shows the failure', async () => {
    const openURL = spyOpenURL().mockRejectedValue(new Error('Unable to open URL'));
    const tree = await renderPrimitive(<StationSheetFooter coordinate={GOVERNMENT_CENTER} />);
    await press(tree, 'station-walk-directions');
    expect(openURL.mock.calls).toEqual([[WALK_URL], [WEB_WALK_URL]]);
    const failure = hostsByTestID(tree.root, 'station-walk-failed');
    expect(failure).toHaveLength(1);
    expect(failure[0]?.props.children).toBe('Apple Maps did not open: Unable to open URL');
  });

  it('a refused app URL falls back to the web host without a failure, and a later success clears an old failure', async () => {
    const openURL = spyOpenURL().mockRejectedValueOnce(new Error('no maps://')).mockResolvedValueOnce(undefined);
    const tree = await renderPrimitive(<StationSheetFooter coordinate={GOVERNMENT_CENTER} />);
    await press(tree, 'station-walk-directions');
    expect(openURL.mock.calls).toEqual([[WALK_URL], [WEB_WALK_URL]]);
    expect(hostsByTestID(tree.root, 'station-walk-failed')).toHaveLength(0);
    openURL.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second')).mockResolvedValueOnce(undefined);
    await press(tree, 'station-walk-directions');
    expect(hostsByTestID(tree.root, 'station-walk-failed')).toHaveLength(1);
    await press(tree, 'station-walk-directions');
    expect(hostsByTestID(tree.root, 'station-walk-failed')).toHaveLength(0);
  });
});
