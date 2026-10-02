import { router } from 'expo-router';

import TripsRoute from '../../../app/(tabs)/trips/index';
import { UserDbProvider } from '../../../data/user-db-provider';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { press } from '../../stations/__tests__/press';
import { leaveAt, type TripCardModel, tripCards } from '../trip-card';
import { TripCard } from '../TripCard';
import { TripsTab, TripsView } from '../TripsTab';
import { closeTripDbs, memoryUserRepos, realScheduleRepo, savedTrip, WED_0130, WED_0800 } from './trip-db';

// test-time mock of native module
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => Promise.resolve({ granted: false, status: 'denied', canAskAgain: false }),
  Accuracy: { Balanced: 3 },
}));
// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * M7.8: the Trips tab. With nothing saved it is the empty state ("No trips yet", with its actions); with
 * trips saved, one TripCard each, sorted by leave-by — built here by the app's own selector over the REAL
 * committed schedule DB at 08:00 on a Wednesday, with Jamie's default pace (an empty kv store) — and at
 * night a card says there are no trains, never "transfer" (m3a's input: nothing leaving is not a change).
 */

afterEach(async () => {
  jest.restoreAllMocks();
  await unmountAll();
});
afterAll(() => closeTripDbs());

const PACE = { walkMps: 1.35, bufferS: 120, position: null };

describe('the Trips tab with nothing saved (M7.8)', () => {
  it('Trips tab empty state: No trips yet, from an empty user DB and outside one alike', async () => {
    const inside = await renderPrimitive(
      <UserDbProvider open={memoryUserRepos}>
        <TripsTab clock={() => WED_0800} />
      </UserDbProvider>,
    );
    const outside = await renderPrimitive(<TripsRoute />);
    for (const tree of [inside, outside]) {
      expect(JSON.stringify(tree.toJSON())).toContain('"No trips yet"');
      expect(hostsByTestID(tree.root, 'trips-add')).toHaveLength(1);
    }
    expect(hostsByTestID(inside.root, 'trips-list')).toHaveLength(0);
  });

  it('Add a trip opens the add-trip flow at its first step', async () => {
    const push = jest.spyOn(router, 'push').mockImplementation(() => undefined);
    const tree = await renderPrimitive(<TripsRoute />);
    expect(hostsByTestID(tree.root, 'trips-add')[0]?.props.accessibilityLabel).toBe('Add a trip');
    await press(tree, 'trips-add');
    expect(push.mock.calls).toEqual([['/trip/new/from']]);
  });
});

/** Three saved trips at Wed 08:00: two rail trips with different walks, and one that needs a transfer. */
const MORNING_TRIPS = [
  savedTrip('close', 'rail:brickell', 'rail:government-ctr', { walkOverrideMin: 3, createdEpoch: 1 }),
  savedTrip('transfer', 'rail:dadeland-south', 'mover:bayfront-park', { walkOverrideMin: 5, createdEpoch: 2 }),
  savedTrip('far', 'rail:dadeland-north', 'rail:government-ctr', { walkOverrideMin: 25, createdEpoch: 3 }),
];

describe('the Trips tab with saved trips (M7.8)', () => {
  it('trip cards are sorted by leaveAt, soonest first, with the untimed card last', async () => {
    const repo = realScheduleRepo();
    const cards = tripCards(repo, MORNING_TRIPS, { nowS: WED_0800, ...PACE });
    expect(cards.map((card) => card.status.kind)).toEqual(['leave', 'leave', 'needs-transfer']);
    const leaves = cards.slice(0, 2).map(leaveAt);
    expect(leaves[0]).toBeLessThan(leaves[1] as number);
    // Saved in the opposite order, the cards still come out by leave-by: the order is the sort's, not the save's.
    const reversed = tripCards(repo, [...cards].reverse().map((card) => card.trip), { nowS: WED_0800, ...PACE });
    expect(reversed.map((card) => card.trip.id)).toEqual(cards.map((card) => card.trip.id));
    const tree = await renderPrimitive(<TripsView state={{ kind: 'cards', cards, nowS: WED_0800 }} reminderProblem={null} />);
    const shown = hostsByTestID(tree.root, /^trip-card-(close|far|transfer)$/).map((node) => node.props.testID);
    expect(shown).toEqual(cards.map((card) => `trip-card-${card.trip.id}`));
  });

  it('at night (no service) the card never says transfer', async () => {
    const [card] = tripCards(realScheduleRepo(), [savedTrip('airport', 'rail:miami-international-airport', 'rail:brickell')], { nowS: WED_0130, ...PACE });
    expect(card?.status.kind).toBe('no-service');
    const tree = await renderPrimitive(<TripCard card={card as TripCardModel} nowS={WED_0130} />);
    const said = JSON.stringify(tree.toJSON());
    expect(said).toContain('No trains now');
    expect(said).not.toMatch(/transfer/i);
  });
});
