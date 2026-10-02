import { Text } from 'react-native';

import { BOARD, NOW_S, SOUTHBOUND, batch, departure, prediction } from '../../departures/__tests__/board-fixtures';
import { DirectionGroup } from '../../departures/DirectionGroup';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { groupByDirection } from '../station-sheet';
import { StationSheetView } from '../StationSheet';

/**
 * M6.4: the station sheet as drawn — header (with m7c's verdict slot), one DirectionGroup per
 * direction with the station's live predictions merged in, and the walk-directions footer. The
 * departures are m6a's synthetic Government Center board; the real grouping is station-sheet-real's.
 */

const STATION = { stationKey: 'rail:government-ctr', name: 'Government Center', mode: 'rail' as const, coordinate: { latitude: 25.7745, longitude: -80.1957 } };
const READY = { kind: 'ready' } as const;

afterEach(async () => {
  await unmountAll();
});

/** A sheet model for Government Center with these departures in BOARD's window. */
function sheetOf(departures: Parameters<typeof groupByDirection>[0]) {
  const groups = groupByDirection(departures);
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.every((group) => group.departures.length > 0)).toBe(true);
  return { kind: 'sheet' as const, station: STATION, lines: ['GREEN', 'ORANGE'] as const, window: BOARD, groups };
}

describe('StationSheetView (M6.4)', () => {
  it('draws one direction group per direction, live predictions merged in, then the walk directions', async () => {
    const departures = [departure('S1', 8, 22, 'GREEN', SOUTHBOUND), departure('N1', 8, 24, 'ORANGE'), departure('N2', 8, 30, 'GREEN')];
    const live = batch([prediction('N1', { epoch: NOW_S + 9 * 60 })]);
    const tree = await renderPrimitive(<StationSheetView db={READY} model={sheetOf(departures)} predictions={live} nowS={NOW_S} />);
    const groups = tree.root.findAllByType(DirectionGroup);
    expect(groups.map((group) => group.props.title)).toEqual(['To Palmetto', 'To Palmetto or Airport']);
    expect(groups.every((group) => group.props.predictions === live && group.props.window === BOARD)).toBe(true);
    expect(hostsByTestID(tree.root, 'station-sheet-header')).toHaveLength(1);
    expect(hostsByTestID(tree.root, 'station-walk-directions')).toHaveLength(1);
    // S1 leaves in 2 min; N1, predicted 5 min late, in 9; N2 on time in 10.
    expect(hostsByTestID(tree.root, /^departure-time-/).map((node) => node.props.children)).toEqual(['2 min', '9 min', '10 min']);
  });

  it('passes the verdict into the header slot, and says why when it has no times', async () => {
    const verdict = <Text testID="hurry-verdict">Jog · 1 min</Text>;
    const tree = await renderPrimitive(<StationSheetView db={READY} model={sheetOf([departure('N1', 8, 24)])} predictions={null} nowS={NOW_S} verdict={verdict} />);
    expect(hostsByTestID(tree.root, 'station-sheet-verdict')).toHaveLength(1);
    const gap = await renderPrimitive(
      <StationSheetView db={READY} model={{ kind: 'gap', station: STATION, lines: ['GREEN'], gap: { kind: 'expired', lastDate: 20261231 } }} predictions={null} nowS={NOW_S} />,
    );
    expect(hostsByTestID(gap.root, 'station-sheet-gap')[0]?.props.children).toBe('The timetable has run out. Update the app for new times.');
    const opening = await renderPrimitive(<StationSheetView db={{ kind: 'opening' }} model={null} predictions={null} nowS={NOW_S} />);
    expect(JSON.stringify(opening.toJSON())).toContain('Opening the schedule');
  });
});
