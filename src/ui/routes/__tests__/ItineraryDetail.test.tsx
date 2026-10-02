import type { ReactTestRenderer } from 'react-test-renderer';

import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { overlayLive } from '../../../domain/routes/overlay';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { ItineraryDetail } from '../ItineraryDetail';
import { type OptionContext, type RouteOption, routeOptions } from '../route-options';
import { ASKED_AT_S, FIXTURE_CLOCK, FIXTURE_NAMES, FIXTURE_NETWORK, fixtureItineraries, fixtureLeg, livePrediction, START } from './route-fixtures';

/**
 * Plan M10b.2: one option's legs inside the sheet. A walk leg's Directions hands the walk to Apple Maps
 * (dirflg=w) toward the leg's end — the Government Center Mover for the first walk of the 2:01 option —
 * and the handoff rule holds (M1.19): openURL resolving, with any value, is success; a rejection is
 * said under the button, after the one https://maps.apple.com fallback.
 */

const AT_ASK: OptionContext = { position: START, nowS: ASKED_AT_S, pace: { walkMps: HURRY_DEFAULTS.walkMps, jogMps: HURRY_DEFAULTS.jogMps } };
/** The first walk of the 2:01 option ends at the Government Center Metromover station. */
const WALK_TO_MOVER = 'maps://?daddr=25.775864,-80.19609&dirflg=w';
const WEB_WALK_TO_MOVER = 'https://maps.apple.com/?daddr=25.775864,-80.19609&dirflg=w';

afterEach(async () => {
  await unmountAll();
});

/** The detail of the option at `index` (sorted by arrival), with `openURL` as its opener. */
async function renderDetail(index: number, openURL: (url: string) => Promise<unknown>, options?: readonly RouteOption[]): Promise<ReactTestRenderer> {
  const option = (options ?? routeOptions(fixtureItineraries(), FIXTURE_NETWORK, AT_ASK))[index];
  expect(option).toBeDefined();
  const tree = await renderPrimitive(<ItineraryDetail option={option as RouteOption} network={FIXTURE_NETWORK} names={FIXTURE_NAMES} clock={FIXTURE_CLOCK} openURL={openURL} />);
  expect(hostsByTestID(tree.root, /^leg-\d+$/)).toHaveLength(option?.itinerary.legs.length ?? -1);
  return tree;
}

/** The text of the one host Text node with this testID. */
function textOf(tree: ReactTestRenderer, testID: string): string {
  const nodes = hostsByTestID(tree.root, testID).filter((node) => (node.type as unknown) === 'Text');
  expect(nodes).toHaveLength(1);
  expect(typeof nodes[0]?.props.children).toBe('string');
  return nodes[0]?.props.children as string;
}

describe('walk legs: Apple Maps walking directions (M10b.2)', () => {
  it('walk leg Directions opens Apple Maps walking with dirflg=w', async () => {
    const openURL = jest.fn(async (_url: string): Promise<boolean> => true);
    const tree = await renderDetail(0, openURL);
    expect([textOf(tree, 'leg-0-times'), textOf(tree, 'leg-0-walk'), textOf(tree, 'leg-0-to')]).toEqual(['2:01 – 2:06', 'Walk 5 min · 320 m', 'to Government Center']);
    await press(tree, 'leg-0-directions');
    expect(openURL.mock.calls).toEqual([[WALK_TO_MOVER]]);
    expect(WALK_TO_MOVER.startsWith('maps://?daddr=') && WALK_TO_MOVER.endsWith('&dirflg=w')).toBe(true);
    await press(tree, 'leg-2-directions');
    expect(openURL.mock.calls[1]).toEqual(['maps://?daddr=25.7584,-80.1937&dirflg=w']);
    expect(textOf(tree, 'leg-2-to')).toBe('to Brickell');
  });

  it('walk leg Directions counts openURL resolving undefined as opened', async () => {
    const openURL = jest.fn(async (_url: string): Promise<void> => undefined);
    const tree = await renderDetail(0, openURL);
    await press(tree, 'leg-0-directions');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(hostsByTestID(tree.root, 'leg-0-failed')).toHaveLength(0);
  });

  it('walk leg Directions shows the failure when openURL rejects', async () => {
    const openURL = jest.fn(async (url: string): Promise<void> => Promise.reject(new Error(`Unable to open URL: ${url.slice(0, 8)}`)));
    const tree = await renderDetail(0, openURL);
    await press(tree, 'leg-0-directions');
    expect(openURL.mock.calls).toEqual([[WALK_TO_MOVER], [WEB_WALK_TO_MOVER]]);
    expect(textOf(tree, 'leg-0-failed')).toBe('Apple Maps did not open: Unable to open URL: https://');
  });
});

describe('transit legs (M10b.2)', () => {
  it('transit leg shows its stations, line badge and Live or Scheduled', async () => {
    const live = overlayLive(fixtureItineraries(), [livePrediction(fixtureLeg('2600'), 120)]);
    // The 2:24 option: walk, the Orange train (2 min late, live), walk, bus 26 (scheduled), walk.
    const tree = await renderDetail(1, async () => undefined, routeOptions(live, FIXTURE_NETWORK, AT_ASK));
    expect(hostsByTestID(tree.root, 'leg-1-badge')[0]?.props.accessibilityLabel).toBe('Orange Line');
    expect([textOf(tree, 'leg-1-board'), textOf(tree, 'leg-1-alight'), textOf(tree, 'leg-1-source-word')]).toEqual(['2:14  Government Center', '2:14  Brickell', 'Live']);
    expect(textOf(tree, 'leg-1-headsign')).toBe('ORANGE LINE DADELAND SOUTH');
    expect(hostsByTestID(tree.root, 'leg-3-badge')[0]?.props.accessibilityLabel).toBe('Bus 26');
    expect([textOf(tree, 'leg-3-board'), textOf(tree, 'leg-3-alight'), textOf(tree, 'leg-3-source-word')]).toEqual(['2:17  BRICKELL STATION (EAST SIDE)', '2:19  BRICKELL AV & SE 15 RD', 'Scheduled']);
    expect(hostsByTestID(tree.root, /^leg-\d-directions$/).map((node) => node.props.testID)).toEqual(['leg-0-directions', 'leg-2-directions', 'leg-4-directions']);
  });
});
