import type { ReactTestRenderer } from 'react-test-renderer';

import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { overlayLive } from '../../../domain/routes/overlay';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { type OptionContext, type RouteOption, routeOptions } from '../route-options';
import { RouteOptionsList, RoutesAttribution } from '../RouteOptionsList';
import { ASKED_AT_S, FIXTURE_CLOCK, FIXTURE_NETWORK, fixtureItineraries, fixtureLeg, livePrediction, START } from './route-fixtures';

/**
 * Plan M10b.1 A: the options list over m10a's real Government Center → Brickell answer — sorted by
 * arrival, each row's facts, the first leg's hurry chip (m7c's engine, run here through m10a's
 * firstLegVerdict), the Live badge for an overlaid leg — and the credits Transitous and OSM require.
 */

const AT_ASK: OptionContext = { position: START, nowS: ASKED_AT_S, pace: { walkMps: HURRY_DEFAULTS.walkMps, jogMps: HURRY_DEFAULTS.jogMps } };

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});

/** The list for `options`, drawn at the fixture's query time with its Miami clock. */
async function renderList(options: readonly RouteOption[]): Promise<ReactTestRenderer> {
  const tree = await renderPrimitive(<RouteOptionsList options={options} clock={FIXTURE_CLOCK} nowS={ASKED_AT_S} onSelect={() => undefined} />);
  expect(hostsByTestID(tree.root, 'route-options')).toHaveLength(1);
  expect(hostsByTestID(tree.root, /^route-option-\d+$/)).toHaveLength(options.length);
  return tree;
}

/** The text of the host Text node whose testID is `testID`. */
function textOf(tree: ReactTestRenderer, testID: string): string {
  const nodes = hostsByTestID(tree.root, testID).filter((node) => (node.type as unknown) === 'Text');
  expect(nodes).toHaveLength(1);
  expect(typeof nodes[0]?.props.children).toBe('string');
  return nodes[0]?.props.children as string;
}

describe('the route options list (M10b.1)', () => {
  it('route options are sorted by arrival', async () => {
    const options = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, AT_ASK);
    // Transitous answered in departure order; the 2:24 rail + bus option arrives before the 2:26 Mover.
    expect(fixtureItineraries().map((it) => it.endEpoch - ASKED_AT_S)).toEqual([1260, 1560, 1680, 1440, 1860, 2160]);
    expect(options.map((option) => option.arriveEpoch - ASKED_AT_S)).toEqual([1260, 1440, 1560, 1680, 1860, 2160]);
    const tree = await renderList(options);
    expect([0, 1, 2, 3, 4, 5].map((i) => textOf(tree, `route-option-${i}-times`))).toEqual(['2:01 → 2:21', '2:07 → 2:24', '2:06 → 2:26', '2:07 → 2:28', '2:11 → 2:31', '2:16 → 2:36']);
  });

  it('route option shows depart and arrive times, duration, transfers and walk minutes', async () => {
    const tree = await renderList(routeOptions(fixtureItineraries(), FIXTURE_NETWORK, AT_ASK));
    expect(['times', 'duration', 'transfers', 'walk'].map((fact) => textOf(tree, `route-option-0-${fact}`))).toEqual(['2:01 → 2:21', '20 min', 'No transfers', '13 min walk']);
    expect(['times', 'duration', 'transfers', 'walk'].map((fact) => textOf(tree, `route-option-1-${fact}`))).toEqual(['2:07 → 2:24', '17 min', '1 transfer', '12 min walk']);
    // The badges: the Brickell loop and the Orange train by the schedule's lines, the bus by its route name.
    expect(hostsByTestID(tree.root, 'route-option-0-badge-0')[0]?.props.accessibilityLabel).toBe('Brickell');
    expect(hostsByTestID(tree.root, /^route-option-1-badge-\d$/).map((node) => node.props.accessibilityLabel)).toEqual(['Orange Line', 'Bus 26']);
    expect(hostsByTestID(tree.root, 'route-option-0')[0]?.props.accessibilityLabel).toBe('2:01 to 2:21, 20 min, No transfers, 13 min walk, Brickell');
  });
});

describe('the first leg and live times on a route option (M10b.1)', () => {
  it('route option shows the first leg hurry chip', async () => {
    // 171 m from the Government Center Mover, which leaves at 2:06: a walk there takes 2 min 45 s, so
    // there are 2 min 45 s to spare after the 30 s to board — m7c's CHILL, "Chill · 2 min" inline.
    const options = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, AT_ASK);
    expect(options[0]?.verdict?.kind).toBe('CHILL');
    expect(Math.round(options[0]?.verdict?.spareS ?? -1)).toBe(165);
    const tree = await renderList(options);
    expect(textOf(tree, 'route-option-0-hurry-text')).toBe('Chill · 2 min');
    expect(hostsByTestID(tree.root, 'route-option-0-hurry')[0]?.props.accessibilityLabel).toBe('Chill, a walk makes the 2:06 train with 2 minutes to spare, going by scheduled times.');
    expect(hostsByTestID(tree.root, /^route-option-\d+-hurry$/)).toHaveLength(6);
  });

  it('route option with a live leg shows the Live badge', async () => {
    const rail = fixtureLeg('2600');
    const live = overlayLive(fixtureItineraries(), [livePrediction(rail, 120)]);
    const options = routeOptions(live, FIXTURE_NETWORK, AT_ASK);
    // The Orange train 2 min late is live in both options riding it (2:24 rail + bus, 2:28 rail); the Movers stay scheduled.
    expect(options.map((option) => option.live)).toEqual([false, true, false, true, false, false]);
    const tree = await renderList(options);
    expect(hostsByTestID(tree.root, /^route-option-\d+-live$/).map((node) => node.props.testID)).toEqual(['route-option-1-live', 'route-option-3-live']);
    expect(textOf(tree, 'route-option-1-live-word')).toBe('Live');
  });
});

describe('a missed connection on a route option (mfix5)', () => {
  it('an option whose transfer may be missed says Tight transfer · may miss 26', async () => {
    // The Orange train 2 min late reaches Brickell at 2:16; after the 2 min walk the rider is at bus 26's stop
    // at 2:18, a minute after it leaves at 2:17. The bus does not wait, so the 2:07 → 2:24 option keeps its
    // times and warns instead.
    const live = overlayLive(fixtureItineraries(), [livePrediction(fixtureLeg('2600'), 120)]);
    const tree = await renderList(routeOptions(live, FIXTURE_NETWORK, AT_ASK));
    expect(textOf(tree, 'route-option-1-times')).toBe('2:07 → 2:24');
    expect(textOf(tree, 'route-option-1-risk')).toBe('Tight transfer · may miss 26');
    expect(hostsByTestID(tree.root, /^route-option-\d+-risk$/)).toHaveLength(1);
    expect(hostsByTestID(tree.root, 'route-option-1')[0]?.props.accessibilityLabel).toBe('2:07 to 2:24, 17 min, 1 transfer, 12 min walk, Orange Line, Bus 26, Live, Tight transfer · may miss 26');
    // The rail-only option has no transfer to miss: its arrival moves instead (2:28 → 2:30).
    expect(textOf(tree, 'route-option-3-times')).toBe('2:07 → 2:30');
  });
});

describe('the route options footer (M10b.1)', () => {
  it('footer credits Routes by Transitous with a link to its sources', async () => {
    const openURL = jest.fn(async (_url: string): Promise<void> => undefined);
    const tree = await renderPrimitive(<RoutesAttribution openURL={openURL} />);
    const texts = tree.root.findAll((node) => (node.type as unknown) === 'Text').map((node) => node.props.children as unknown);
    expect(texts).toEqual(['Routes by Transitous', '© OpenStreetMap contributors']);
    await press(tree, 'routes-attribution-transitous');
    expect(openURL.mock.calls).toEqual([['https://transitous.org/sources']]);
    await press(tree, 'routes-attribution-osm');
    expect(openURL.mock.calls[1]).toEqual(['https://www.openstreetmap.org/copyright']);
    expect(hostsByTestID(tree.root, 'routes-attribution-failed')).toHaveLength(0);
  });
});
