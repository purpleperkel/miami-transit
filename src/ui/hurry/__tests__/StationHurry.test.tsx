import { View } from 'react-native';

import { hurryVerdict } from '../../../domain/hurry/verdict';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { HURRY_NOTES } from '../copy';
import type { HurryBoard, HurryReading } from '../hurry-reading';
import { StationHurryView } from '../StationHurry';

// test-time mock of native module
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(() => Promise.resolve()), NotificationFeedbackType: { Warning: 'warning' } }));

/**
 * Plan M7c.3: hurry or chill in the station sheet's verdict slot — a card per direction, or one line
 * saying why there is no verdict; nothing at all where the sheet itself explains (schedule opening,
 * failed or out of date).
 */

afterEach(async () => {
  await unmountAll();
});

/** A direction's board: the engine's verdict 400 m from the platform, for trains at `epochs`. */
function board(directionId: number, title: string, epochs: readonly number[]): HurryBoard {
  const verdict = hurryVerdict({ now: 0, walkMeters: 400, departures: epochs.map((epoch) => ({ epoch, live: false, lineId: 'GREEN', headsign: title })) });
  expect(verdict.walkS).toBeGreaterThan(0);
  expect(title.startsWith('To ')).toBe(true);
  return { directionId, title, walkMeters: 400, verdict, freshness: { kind: 'scheduled' } };
}

/** The slot's rendered texts for `reading`. */
async function slotTexts(reading: HurryReading): Promise<string[]> {
  const tree = await renderPrimitive(<View testID="slot"><StationHurryView reading={reading} /></View>);
  const texts = tree.root.findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string').map((node) => node.props.children as string);
  expect(hostsByTestID(tree.root, 'slot')).toHaveLength(1);
  expect(texts.every((text) => text.length > 0)).toBe(true);
  return texts;
}

describe('hurry or chill on the station sheet (M7c.3)', () => {
  it('shows one card per direction, each under its heading', async () => {
    const ctx = { now: 0, clock: () => '2:14' };
    const reading: HurryReading = { kind: 'boards', stationKey: 'rail:brickell', stationName: 'Brickell', ctx, boards: [board(0, 'To Dadeland South', [600]), board(1, 'To Palmetto', [300, 500])] };
    const texts = await slotTexts(reading);
    expect(texts.filter((text) => text === 'Scheduled')).toHaveLength(2);
    expect(texts).toEqual(['To Dadeland South', 'Scheduled', 'Chill', '3 min to spare', 'To Palmetto', 'Scheduled', 'Not worth it', 'next in 8 min']);
  });

  it('says why there is no verdict, and stays empty where the sheet explains', async () => {
    expect(await slotTexts({ kind: 'locating' })).toEqual([HURRY_NOTES.locating]);
    expect(await slotTexts({ kind: 'no-location', note: 'Location is off' })).toEqual([HURRY_NOTES.noLocation]);
    expect(await slotTexts({ kind: 'far', stationKey: 'rail:palmetto', stationName: 'Palmetto', walkMeters: 3_456 })).toEqual(['You are 3.5 km away, too far to hurry for a train.']);
    expect(await slotTexts({ kind: 'opening' })).toEqual([]);
    expect(await slotTexts({ kind: 'failed', message: 'disk full' })).toEqual([]);
  });
});
