import { useEffect } from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';

import fixture from '../../../domain/routes/__fixtures__/transitous-plan.json';
import { HURRY_DEFAULTS } from '../../../domain/hurry/verdict';
import { type PlanFetch, PolitePlanClient } from '../../../domain/routes/polite-client';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { PlanBody } from '../PlanScreen';
import type { RecentPlace } from '../recent-places';
import { routeOptions } from '../route-options';
import { type PlanState, usePlanRequest } from '../use-route-plan';
import { ASKED_AT_S, END, FIXTURE_CLOCK, FIXTURE_NAMES, FIXTURE_NETWORK, fixtureItineraries, START } from './route-fixtures';

/**
 * Plan M10b.1–M10b.2, the sheet's moving parts: Transitous is asked through m10a's polite client (an
 * injected fetch, clock and sleep — never the network), once per trip; a call superseded by a newer one
 * shows nothing (no error); and a tapped option opens its legs inside the sheet, with a way back.
 */

const GOVERNMENT_CENTER: RecentPlace = { name: 'Government Center', lat: 25.7743, lon: -80.1955 };

afterEach(async () => {
  await unmountAll();
});

/** The fixture's query time as the sheet's wall clock, in ms (one function, so the plan effect runs once). */
function askedAtMs(): number {
  const ms = ASKED_AT_S * 1000;
  expect(Number.isSafeInteger(ms)).toBe(true);
  expect(ms % 1000).toBe(0);
  return ms;
}

type Sleeps = { readonly resolvers: (() => void)[]; readonly sleep: (ms: number) => Promise<void> };

/** A sleep the test wakes by hand: the polite client's debounce and backoff wait on it. */
function manualSleep(): Sleeps {
  const resolvers: (() => void)[] = [];
  const sleeps: Sleeps = { resolvers, sleep: () => new Promise<void>((resolve) => void resolvers.push(resolve)) };
  expect(sleeps.resolvers).toHaveLength(0);
  expect(typeof sleeps.sleep).toBe('function');
  return sleeps;
}

/** Wakes every pending sleep, round after round, until the client's promises run out; returns how many it woke. */
async function wake(sleeps: Sleeps): Promise<number> {
  let woken = 0;
  for (let round = 0; round < 6; round += 1) {
    const pending = sleeps.resolvers.splice(0);
    woken += pending.length;
    await act(async () => {
      pending.forEach((resolve) => resolve());
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  expect(sleeps.resolvers).toHaveLength(0);
  expect(woken).toBeGreaterThan(0);
  return woken;
}

/** Calls usePlanRequest from START to `to` and reports every state it returns. */
function Probe({ client, to, seen }: { readonly client: PolitePlanClient; readonly to: RecentPlace; readonly seen: (state: PlanState) => void }) {
  const state = usePlanRequest(client, START, to, askedAtMs);
  useEffect(() => {
    seen(state);
  }, [seen, state]);
  expect(typeof seen).toBe('function');
  expect(state.kind).not.toBe('idle');
  return <View testID="probe" />;
}

describe('asking Transitous from the sheet (M10b.1)', () => {
  it('asks once through the polite client and returns its itineraries', async () => {
    const sleeps = manualSleep();
    const fetch = jest.fn<ReturnType<PlanFetch>, Parameters<PlanFetch>>(async () => ({ status: 200, json: async () => fixture as unknown }));
    const client = new PolitePlanClient({ fetch, clock: askedAtMs, sleep: sleeps.sleep, appVersion: '1.0.0' });
    const states: PlanState[] = [];
    await renderPrimitive(<Probe client={client} to={END} seen={(state) => states.push(state)} />);
    expect(await wake(sleeps)).toBe(1);
    expect(states.map((state) => state.kind)).toEqual(['loading', 'ok']);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://api.transitous.org/api/v5/plan?fromPlace=25.7745,-80.1953&toPlace=25.7584,-80.1937&time=2026-10-02T18:00:00.000Z&arriveBy=false']);
    expect(fetch.mock.calls[0]?.[1].headers['User-Agent']).toBe('MiamiTransit/1.0.0 (+https://github.com/purpleperkel/miami-transit)');
  });

  it('a superseded call shows nothing, and an unavailable answer says why', async () => {
    const sleeps = manualSleep();
    const fetch = jest.fn<ReturnType<PlanFetch>, Parameters<PlanFetch>>(async () => ({ status: 503, json: async () => ({}) }));
    const client = new PolitePlanClient({ fetch, clock: askedAtMs, sleep: sleeps.sleep, appVersion: '1.0.0' });
    const first: PlanState[] = [];
    const second: PlanState[] = [];
    await renderPrimitive(<Probe client={client} to={END} seen={(state) => first.push(state)} />);
    await renderPrimitive(<Probe client={client} to={GOVERNMENT_CENTER} seen={(state) => second.push(state)} />);
    // Two debounces, then the backoff before the one retry.
    expect(await wake(sleeps)).toBe(3);
    expect(first.map((state) => state.kind)).toEqual(['loading']);
    expect(second).toEqual([{ kind: 'loading' }, { kind: 'unavailable', reason: 'HTTP 503, then after a 2000 ms backoff: HTTP 503' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('the sheet body (M10b.1–M10b.2)', () => {
  it('opens an option inside the sheet and goes back to every option', async () => {
    const options = routeOptions(fixtureItineraries(), FIXTURE_NETWORK, { position: START, nowS: ASKED_AT_S, pace: { walkMps: HURRY_DEFAULTS.walkMps, jogMps: HURRY_DEFAULTS.jogMps } });
    const props = { origin: { kind: 'ready', origin: { name: 'Your location', coordinate: START } }, destination: END, network: FIXTURE_NETWORK, names: FIXTURE_NAMES, clock: FIXTURE_CLOCK, nowS: ASKED_AT_S } as const;
    const tree = await renderPrimitive(<PlanBody {...props} plan={{ kind: 'ok', itineraries: fixtureItineraries() }} options={options} />);
    await press(tree, 'route-option-1');
    expect(hostsByTestID(tree.root, 'itinerary-detail')).toHaveLength(1);
    expect(hostsByTestID(tree.root, 'itinerary-times')[0]?.props.children).toBe('2:07 → 2:24');
    await press(tree, 'itinerary-back');
    expect(hostsByTestID(tree.root, /^route-option-\d+$/)).toHaveLength(6);
    const waiting = await renderPrimitive(<PlanBody {...props} plan={{ kind: 'loading' }} options={[]} />);
    expect(JSON.stringify(waiting.toJSON())).toContain('Finding routes…');
    const none = await renderPrimitive(<PlanBody {...props} plan={{ kind: 'ok', itineraries: [] }} options={[]} />);
    expect(hostsByTestID(none.root, 'plan-unavailable-reason')[0]?.props.children).toBe('No route options for this trip right now.');
  });
});
