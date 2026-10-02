import type { KvStoreFake } from '../../settings/__tests__/native-fakes';
import { MAX_RECENT_PLACES, readRecentPlaces, RECENT_PLACES_ITEM, recordRecentPlace, withRecentPlace } from '../recent-places';

// test-time mock of native module
jest.mock('expo-sqlite/kv-store', () => jest.requireActual('../../settings/__tests__/native-fakes').kvStoreModule());

/**
 * Plan M10b.1 (ruling R6): the "To" field's recent places, kept in expo-sqlite/kv-store (here its
 * stand-in over a Map: the store the module reads by default), newest first, each name once.
 */

const BRICKELL = { name: 'Brickell', lat: 25.7584, lon: -80.1937 };
const GOVERNMENT_CENTER = { name: 'Government Center', lat: 25.7743, lon: -80.1955 };
const DADELAND = { name: 'Dadeland South', lat: 25.6847, lon: -80.3134 };

/** The kv-store stand-in jest hands the module, emptied. */
function kvStore(): KvStoreFake {
  const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');
  kv.map.clear();
  expect(kv.map.size).toBe(0);
  expect(readRecentPlaces()).toEqual([]);
  return kv;
}

describe('recent places (M10b.1, ruling R6)', () => {
  it('a planned destination goes first in recent places without duplicates', () => {
    const kv = kvStore();
    for (const place of [BRICKELL, GOVERNMENT_CENTER, DADELAND, { ...GOVERNMENT_CENTER, name: ' government center ' }]) {
      expect(recordRecentPlace(place).ok).toBe(true);
    }
    expect(readRecentPlaces().map((place) => place.name)).toEqual(['government center', 'Dadeland South', 'Brickell']);
    expect(JSON.parse(kv.map.get(RECENT_PLACES_ITEM) ?? 'null')).toHaveLength(3);
    expect(recordRecentPlace(BRICKELL)).toEqual({ ok: true, value: [BRICKELL, { ...GOVERNMENT_CENTER, name: 'government center' }, DADELAND] });
  });

  it('keeps the newest places only, and refuses a place without a real coordinate', () => {
    const kv = kvStore();
    const many = Array.from({ length: MAX_RECENT_PLACES + 2 }, (_, i) => ({ name: `Place ${i}`, lat: 25.7 + i / 100, lon: -80.2 }));
    const list = many.reduce<readonly (typeof BRICKELL)[]>((places, place) => withRecentPlace(places, place), []);
    expect(list.map((place) => place.name)).toEqual(['Place 9', 'Place 8', 'Place 7', 'Place 6', 'Place 5', 'Place 4', 'Place 3', 'Place 2']);
    const refused = recordRecentPlace({ name: 'Nowhere', lat: 125, lon: 0 });
    expect(refused.ok ? null : refused.error.kind).toBe('invalid-place');
    expect(kv.map.size).toBe(0);
  });

  it('reads an unreadable stored value as no recent places, and starts the list again', () => {
    const kv = kvStore();
    kv.map.set(RECENT_PLACES_ITEM, '{not json');
    expect(readRecentPlaces()).toEqual([]);
    kv.map.set(RECENT_PLACES_ITEM, JSON.stringify([{ name: 'Brickell', lat: 'north', lon: -80 }]));
    expect(readRecentPlaces()).toEqual([]);
    expect(recordRecentPlace(DADELAND).ok).toBe(true);
    expect(readRecentPlaces()).toEqual([DADELAND]);
  });
});
