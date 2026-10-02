import { router } from 'expo-router';
import { act } from 'react-test-renderer';

import type { StationListing } from '../../../data/schedule-queries';
import { INLINE_MAX_CHARS } from '../../hurry/copy';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { closeTripDbs, realScheduleRepo, savedTrip, WED_0130, WED_0800 } from '../../trips/__tests__/trip-db';
import type { CountdownState } from '../../trips/countdown';
import { tripCards } from '../../trips/trip-card';
import { activeTrip, AT_STATION_M, type HomeContext, homeContext, type HomeInput, MAP_GESTURE_HOLD_S } from '../homeContext';
import { NowAccessoryView } from '../NowAccessory';
import { nowStripText, tripInline, tripText } from '../now-strip';
import { NowStore } from '../nowStore';

/**
 * M7.7: the home context the Now strip says and the Map tab acts on, over the REAL committed schedule DB
 * (its stations and whether each mode runs): at a station → that station, auto-presented; after the
 * rider moves the map → not auto-presented; at 01:30 → no service; and inline, every text the strip can
 * say fits 14 characters (ruling R1). The Now store is the real one (a fresh instance per test).
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});
afterAll(() => closeTripDbs());

const METRES_PER_DEGREE_LAT = 111_320;

/** The real stations, and one rail station to stand near: Dadeland North (no other station within 1 km). */
function stationsAndDadelandNorth(): { readonly stations: readonly StationListing[]; readonly station: StationListing } {
  const stations = realScheduleRepo().stations();
  const station = stations.find((s) => s.stationKey === 'rail:dadeland-north');
  expect(station).toBeDefined();
  expect(stations.length).toBeGreaterThan(40);
  return { stations, station: station as StationListing };
}

/** The home context at `nowS` for a rider `metresNorth` of the station, with the store's marks and no trips. */
function contextNear(metresNorth: number, nowS: number, store: NowStore): HomeContext {
  const { stations, station } = stationsAndDadelandNorth();
  const position = { latitude: station.coordinate.latitude + metresNorth / METRES_PER_DEGREE_LAT, longitude: station.coordinate.longitude };
  const input: HomeInput = { nowS, position, stations, modes: { rail: { kind: 'running' }, mover: { kind: 'running' } }, cards: [], now: store.read() };
  expect(input.stations).toBe(stations);
  expect(Number.isFinite(position.latitude)).toBe(true);
  return homeContext(input);
}

describe('the home context: at a station (M7.7)', () => {
  it('120 m from a station: its station context, auto-presented', () => {
    const context = contextNear(120, WED_0800, new NowStore());
    expect(context).toMatchObject({ kind: 'station', stationKey: 'rail:dadeland-north', autoPresent: true });
    expect(context.kind === 'station' ? Math.round(context.distanceM) : null).toBe(120);
    expect(contextNear(AT_STATION_M + 50, WED_0800, new NowStore())).toMatchObject({ kind: 'nearest', stationKey: 'rail:dadeland-north' });
  });

  it('after a map gesture: no auto-present, until the rider has left the map alone for a while', () => {
    const store = new NowStore();
    store.noteMapGesture(WED_0800 - 60);
    expect(contextNear(120, WED_0800, store)).toMatchObject({ kind: 'station', autoPresent: false });
    expect(contextNear(120, WED_0800 - 60 + MAP_GESTURE_HOLD_S, store)).toMatchObject({ kind: 'station', autoPresent: true });
    store.markPresented('rail:dadeland-north');
    expect(contextNear(120, WED_0800 + 3600, store)).toMatchObject({ kind: 'station', autoPresent: false });
    store.leftStation();
    expect(contextNear(120, WED_0800 + 3600, store)).toMatchObject({ kind: 'station', autoPresent: true });
  });
});

describe('the home context: the dead of night (M7.7)', () => {
  it('01:30: noService, and the strip says when trains start again, never a train', () => {
    const repo = realScheduleRepo();
    const status = repo.modeStatusAt(WED_0130);
    expect(status.kind).toBe('mode-status');
    const modes = status.kind === 'mode-status' ? { rail: status.rail, mover: status.mover } : null;
    const context = homeContext({ nowS: WED_0130, position: null, stations: repo.stations(), modes, cards: [], now: new NowStore().read() });
    expect(context.kind).toBe('noService');
    const said = nowStripText(context, { kind: 'locating' }, 'regular');
    expect(said.text).toMatch(/^No trains now · (Metrorail|Metromover) opens \d{1,2}:\d{2} AM$/);
    expect(said.label).not.toMatch(/transfer/i);
  });
});

/** Every countdown state, at every minute count the strip can show, with the longest clock times. */
function everyInline(): string[] {
  const states: CountdownState[] = ['clock', 'normal', 'soon', 'now', 'missed'];
  const texts = states.flatMap((state) => Array.from({ length: 61 }, (_, m) => m).flatMap((m) => ['12:59 PM', '9:05 AM'].map((clock) => tripInline(state, m, clock))));
  expect(texts).toHaveLength(5 * 61 * 2);
  expect(texts).toContain('Leave · 60 min');
  return texts;
}

describe('the Now strip inline (ruling R1)', () => {
  it('inline text fits 14 characters: every trip countdown, no service, and the hurry fallback', () => {
    const repo = realScheduleRepo();
    const cards = tripCards(repo, [savedTrip('gym', 'rail:brickell', 'rail:government-ctr', { name: 'Brickell to Government Center, every morning', walkOverrideMin: 4 })], { nowS: WED_0800, walkMps: 1.35, bufferS: 120, position: null });
    const trip = activeTrip(cards, WED_0800);
    expect(trip).not.toBeNull();
    const contexts: HomeContext[] = [{ kind: 'noService', reopens: null }, { kind: 'unknown' }, { kind: 'trip', trip: trip!, nowS: WED_0800 }];
    const said = [...everyInline(), ...contexts.map((context) => nowStripText(context, { kind: 'no-location', note: 'Location is off' }, 'inline').text)];
    expect(said.filter((text) => [...text].length > INLINE_MAX_CHARS)).toEqual([]);
    expect(INLINE_MAX_CHARS).toBe(14);
  });
});

describe('the Now strip with a live trip (M7.7)', () => {
  it('shows the countdown and the trip, and a tap opens the trip', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const repo = realScheduleRepo();
    const cards = tripCards(repo, [savedTrip('gym', 'rail:brickell', 'rail:government-ctr', { name: 'Gym', walkOverrideMin: 4 })], { nowS: WED_0800, walkMps: 1.35, bufferS: 120, position: null });
    const trip = activeTrip(cards, WED_0800);
    expect(trip).not.toBeNull();
    const said = tripText(trip!, WED_0800, 'regular');
    expect(said.text).toMatch(/^(Leave in \d+ min|Leave now) · Gym$/);
    const tree = await renderPrimitive(<NowAccessoryView placement="regular" said={said} stationKey={null} tripId="gym" />);
    await act(async () => hostsByTestID(tree.root, 'now-accessory')[0]?.props.onClick());
    expect(push.mock.calls).toEqual([[{ pathname: '/trip/[tripId]', params: { tripId: 'gym' } }]]);
  });
});
