import type { ReactTestRenderer } from 'react-test-renderer';

import directOnly from '../../../domain/routes/__fixtures__/transitous-direct-only.json';
import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { type PlanFetch, PolitePlanClient } from '../../../domain/routes/polite-client';
import { type Itinerary, isWalkOnly } from '../../../domain/routes/transitous';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { ItineraryDetail } from '../ItineraryDetail';
import { PlanBody } from '../PlanScreen';
import type { RecentPlace } from '../recent-places';
import { type OptionContext, type RouteOption, routeOptions } from '../route-options';
import { RouteOptionsList } from '../RouteOptionsList';
import type { PlanState } from '../use-route-plan';
import { ASKED_AT_S, FIXTURE_CLOCK, FIXTURE_NAMES, FIXTURE_NETWORK } from './route-fixtures';

/**
 * mfix7 fix 1 (Jamie's 07:10 recording): "No route options" for an 8-minute walk near Brickell, because
 * Transitous answers a trip that walking wins with `itineraries: []` and the walk in `direct[]`. The bodies
 * are REAL: the arbiter's 08:15 direct-only capture (25.7645,-80.1897 → Brickell City Centre) and m10a's
 * Government Center → Brickell answer, both asked of the app's REAL polite client through a fake fetch.
 */

type Body = Record<string, unknown> & { readonly from: { lat: number; lon: number }; readonly to: { lat: number; lon: number } };

const DIRECT_ONLY = directOnly as unknown as Body;
const M10A = fixture as unknown as Body;
const BRICKELL_CITY_CENTRE: RecentPlace = { name: 'Brickell City Centre', lat: 25.766888, lon: -80.192121 };
/** Where Jamie stood: the capture's start. */
const OFF_LINE_POINT = { latitude: 25.7645, longitude: -80.1897 };
const PACE = { walkMps: HURRY_DEFAULTS.walkMps, jogMps: HURRY_DEFAULTS.jogMps };

afterEach(async () => {
  await unmountAll();
});

/** The itineraries the app's polite client reads from `body` (served as HTTP 200 by a fake fetch, never the network). */
async function answerOf(body: Body): Promise<PlanState> {
  const its = (body.itineraries as { startTime: string }[]).concat((body.direct as { startTime: string }[] | undefined) ?? []);
  const askMs = its.length === 0 ? ASKED_AT_S * 1000 : Date.parse(its[0]?.startTime ?? '');
  const fetch = jest.fn<ReturnType<PlanFetch>, Parameters<PlanFetch>>(async () => ({ status: 200, json: async () => JSON.parse(JSON.stringify(body)) as unknown }));
  const client = new PolitePlanClient({ fetch, clock: () => askMs, sleep: async () => undefined, appVersion: '1.0.0' });
  const outcome = await client.plan({ from: { latitude: body.from.lat, longitude: body.from.lon }, to: { latitude: body.to.lat, longitude: body.to.lon }, timeEpoch: askMs / 1000, arriveBy: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') {
    throw new Error(`the polite client answered ${outcome.kind} for an HTTP 200 /plan body`);
  }
  return { kind: 'ok', itineraries: outcome.itineraries };
}

/** The itineraries of an ok answer. */
function itinerariesOf(plan: PlanState): readonly Itinerary[] {
  expect(plan.kind).toBe('ok');
  const itineraries = plan.kind === 'ok' ? plan.itineraries : [];
  expect(Array.isArray(itineraries)).toBe(true);
  return itineraries;
}

/** A deep copy of `value` with every ISO instant moved by `seconds` (bounded walk, no recursion). */
function shifted<T>(value: T, seconds: number): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const stack: Record<string, unknown>[] = [copy as Record<string, unknown>];
  for (let guard = 0; stack.length > 0 && guard < 100_000; guard += 1) {
    const node = stack.pop() as Record<string, unknown>;
    for (const [key, field] of Object.entries(node)) {
      if (typeof field === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(field)) {
        node[key] = new Date(Date.parse(field) + seconds * 1000).toISOString().replace('.000Z', 'Z');
      } else if (field !== null && typeof field === 'object') {
        stack.push(field as Record<string, unknown>);
      }
    }
  }
  expect(stack).toHaveLength(0);
  expect(copy).not.toBe(value);
  return copy;
}

/** The text of the one host Text whose testID is `testID`. */
function textOf(tree: ReactTestRenderer, testID: string): string {
  const nodes = hostsByTestID(tree.root, testID).filter((node) => (node.type as unknown) === 'Text');
  expect(nodes).toHaveLength(1);
  expect(typeof nodes[0]?.props.children).toBe('string');
  return nodes[0]?.props.children as string;
}

/** The options of `plan`, read from `position` at the answer's own start. */
function optionsOf(plan: PlanState, position: OptionContext['position'], nowS: number): RouteOption[] {
  const options = routeOptions(itinerariesOf(plan), FIXTURE_NETWORK, { position, nowS, pace: PACE });
  expect(options.length).toBe(itinerariesOf(plan).length);
  expect(Number.isFinite(nowS)).toBe(true);
  return options;
}

describe('a walk-only route option (mfix7)', () => {
  it('a walk-only option shows its walk minutes with no live badge and no hurry chip', async () => {
    const plan = await answerOf(DIRECT_ONLY);
    const walk = itinerariesOf(plan)[0] as Itinerary;
    // Even from a known position the walk has no hurry verdict: there is no train to make.
    const options = optionsOf(plan, OFF_LINE_POINT, walk.startEpoch);
    expect(options.map((option) => [option.verdict, option.live, option.badges.length, option.walkS])).toEqual([[null, false, 0, 480]]);
    const tree = await renderPrimitive(<RouteOptionsList options={options} clock={FIXTURE_CLOCK} nowS={walk.startEpoch} onSelect={() => undefined} />);
    expect(textOf(tree, 'route-option-0-times')).toBe('8:15 → 8:23');
    expect(textOf(tree, 'route-option-0-walk-only')).toBe('Walk 8 min · no train needed');
    expect(hostsByTestID(tree.root, 'route-option-0-live')).toHaveLength(0);
    expect(hostsByTestID(tree.root, /^route-option-0-hurry/)).toHaveLength(0);
    expect(hostsByTestID(tree.root, /^route-option-0-badge-/)).toHaveLength(0);
    expect(hostsByTestID(tree.root, 'route-option-0')[0]?.props.accessibilityLabel).toBe('8:15 to 8:23, Walk 8 min, no train needed');
  });

  it('a mixed answer lists transit and walk-only options sorted by arrival', async () => {
    // m10a's answer (asked 18:00 UTC) with the capture's walk moved six hours, to 18:15–18:23 UTC: 2:15 → 2:23 in Miami.
    const plan = await answerOf({ ...M10A, direct: shifted(DIRECT_ONLY.direct, 6 * 3600) });
    expect(itinerariesOf(plan).map(isWalkOnly)).toEqual([false, false, false, false, false, false, true]);
    const options = optionsOf(plan, null, ASKED_AT_S);
    expect(options.map((option) => option.arriveEpoch - ASKED_AT_S)).toEqual([1260, 1380, 1440, 1560, 1680, 1860, 2160]);
    const tree = await renderPrimitive(<RouteOptionsList options={options} clock={FIXTURE_CLOCK} nowS={ASKED_AT_S} onSelect={() => undefined} />);
    const times = [0, 1, 2, 3, 4, 5, 6].map((i) => textOf(tree, `route-option-${i}-times`));
    expect(times).toEqual(['2:01 → 2:21', '2:15 → 2:23', '2:07 → 2:24', '2:06 → 2:26', '2:07 → 2:28', '2:11 → 2:31', '2:16 → 2:36']);
    expect(hostsByTestID(tree.root, /^route-option-\d+-walk-only$/).map((node) => node.props.testID)).toEqual(['route-option-1-walk-only']);
    expect(textOf(tree, 'route-option-0-transfers')).toBe('No transfers');
  });
});

describe('the sheet body around walk-only answers (mfix7)', () => {
  const sheet = { origin: { kind: 'ready', origin: { name: 'Your location', coordinate: OFF_LINE_POINT, takenAtMs: ASKED_AT_S * 1000 } }, destination: BRICKELL_CITY_CENTRE, network: FIXTURE_NETWORK, names: FIXTURE_NAMES, clock: FIXTURE_CLOCK, nowS: ASKED_AT_S } as const;

  it('route options are unavailable only when itineraries and direct are both empty', async () => {
    const empty = await answerOf({ ...DIRECT_ONLY, itineraries: [], direct: [] });
    const none = await renderPrimitive(<PlanBody {...sheet} plan={empty} options={optionsOf(empty, OFF_LINE_POINT, ASKED_AT_S)} />);
    expect(hostsByTestID(none.root, 'plan-unavailable')).toHaveLength(1);
    expect(textOf(none, 'plan-unavailable-reason')).toBe('No route options for this trip right now.');
    // Jamie's trip: no itinerary, one direct walk — an option, never "No route options".
    const walkable = await answerOf(DIRECT_ONLY);
    const tree = await renderPrimitive(<PlanBody {...sheet} plan={walkable} options={optionsOf(walkable, OFF_LINE_POINT, ASKED_AT_S)} />);
    expect(hostsByTestID(tree.root, 'plan-unavailable')).toHaveLength(0);
    expect(hostsByTestID(tree.root, /^route-option-\d+$/)).toHaveLength(1);
    expect(textOf(tree, 'route-option-0-walk-only')).toBe('Walk 8 min · no train needed');
  });

  it('a walk-only option detail opens apple maps walking directions with dirflg=w', async () => {
    const plan = await answerOf(DIRECT_ONLY);
    const [option] = optionsOf(plan, OFF_LINE_POINT, ASKED_AT_S);
    expect(option).toBeDefined();
    const openURL = jest.fn(async (_url: string) => undefined);
    const tree = await renderPrimitive(<ItineraryDetail option={option as RouteOption} network={FIXTURE_NETWORK} names={{ ...FIXTURE_NAMES, destination: 'Brickell City Centre' }} clock={FIXTURE_CLOCK} openURL={openURL} />);
    expect(textOf(tree, 'itinerary-facts')).toBe('Walk 8 min · no train needed');
    expect(textOf(tree, 'leg-0-to')).toBe('to Brickell City Centre');
    await press(tree, 'leg-0-directions');
    expect(openURL.mock.calls).toEqual([['maps://?daddr=25.766888,-80.192121&dirflg=w']]);
    // Success is the openURL promise resolving (any value): nothing is said under the button.
    expect(hostsByTestID(tree.root, 'leg-0-failed')).toHaveLength(0);
  });
});
