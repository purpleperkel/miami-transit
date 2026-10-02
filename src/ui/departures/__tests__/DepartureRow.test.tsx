import { SymbolView } from 'expo-symbols';
import { StyleSheet } from 'react-native';
import type { ReactTestRenderer } from 'react-test-renderer';

import { type DepartureRow as MergedRow, mergeDepartures } from '../../../domain/live/merge-departures';
import type { LivePrediction } from '../../../domain/live/types';
import type { Departure } from '../../../domain/schedule/departures';
import { statusFace } from '../../dataStatus';
import { LineBadge } from '../../primitives/LineBadge';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { serviceSecond } from '../direction-board';
import { DepartureRow } from '../DepartureRow';
import { BOARD, NOW_S, departure, prediction } from './board-fixtures';

/** M6.3 DepartureRow: badge, destination and time; a canceled departure stays, struck through, saying Canceled. */

afterEach(unmountAll);

const A_0828 = departure('trip-a', 8, 28);

/** The merged board row of `tripId`, rendered at NOW_S the way DirectionGroup renders it. */
async function renderRow(tripId: string, departures: Departure[], predictions: LivePrediction[], showSource = false): Promise<{ tree: ReactTestRenderer; row: MergedRow }> {
  const found = mergeDepartures(departures, predictions, BOARD).rows.find((candidate) => candidate.tripId === tripId);
  expect(found).toBeDefined();
  const row = found as MergedRow;
  const tree = await renderPrimitive(<DepartureRow row={row} depS={serviceSecond(row, departures)} nowS={NOW_S} showSource={showSource} />);
  expect(hostsByTestID(tree.root, `departure-row-${row.key}`)).toHaveLength(1);
  return { tree, row };
}

/** The flattened style of the one host node with this testID. */
function styleOf(tree: ReactTestRenderer, testID: string) {
  const nodes = hostsByTestID(tree.root, testID);
  expect(nodes).toHaveLength(1);
  const style = StyleSheet.flatten(nodes[0]?.props.style);
  expect(style).toBeDefined();
  return style;
}

describe('DepartureRow', () => {
  it('canceled departure is struck through and says Canceled', async () => {
    const { tree, row } = await renderRow('trip-a', [A_0828], [prediction('trip-a', { canceled: true, realtime: false })]);
    expect([row.canceled, row.epoch]).toEqual([true, A_0828.epoch]);
    expect(styleOf(tree, `departure-destination-${row.key}`).textDecorationLine).toBe('line-through');
    expect(styleOf(tree, `departure-time-${row.key}`).textDecorationLine).toBe('line-through');
    expect(hostsByTestID(tree.root, `departure-canceled-${row.key}`).map((node) => node.props.children)).toEqual(['Canceled']);
    expect(hostsByTestID(tree.root, `departure-row-${row.key}`)[0]?.props.accessibilityLabel).toBe('Orange Line to Airport, 8 min, Canceled');
  });

  it('a running departure shows its badge, destination and minutes, nothing struck', async () => {
    const { tree, row } = await renderRow('trip-a', [A_0828], []);
    expect(tree.root.findAllByType(LineBadge).map((badge) => badge.props.lineId)).toEqual(['ORANGE']);
    expect(hostsByTestID(tree.root, `departure-destination-${row.key}`).map((node) => node.props.children)).toEqual(['Airport']);
    expect(styleOf(tree, `departure-time-${row.key}`).textDecorationLine).toBeUndefined();
    expect(hostsByTestID(tree.root, /^departure-canceled-/)).toHaveLength(0);
  });

  it('a live-only train the timetable does not know shows its headsign, or Unscheduled train, without a badge', async () => {
    const named = await renderRow('extra-1', [A_0828], [prediction('extra-1', { lineId: null, headsign: 'Dadeland South', epoch: NOW_S + 300 })]);
    expect(named.tree.root.findAllByType(LineBadge)).toHaveLength(0);
    expect(hostsByTestID(named.tree.root, `departure-row-${named.row.key}`)[0]?.props.accessibilityLabel).toBe('To Dadeland South, 5 min');
    const unnamed = await renderRow('extra-2', [A_0828], [prediction('extra-2', { lineId: null, epoch: NOW_S + 300 })]);
    expect(hostsByTestID(unnamed.tree.root, `departure-destination-${unnamed.row.key}`).map((node) => node.props.children)).toEqual(['Unscheduled train']);
    expect(hostsByTestID(unnamed.tree.root, `departure-row-${unnamed.row.key}`)[0]?.props.accessibilityLabel).toBe('Unscheduled train, 5 min');
  });

  it('with showSource the row carries its source icon and says its source to VoiceOver', async () => {
    const { tree, row } = await renderRow('trip-a', [A_0828], [prediction('trip-a', { epoch: A_0828.epoch + 60 })], true);
    expect(hostsByTestID(tree.root, `departure-source-${row.key}`)[0]?.findByType(SymbolView).props.name).toBe(statusFace({ kind: 'live' }).icon);
    expect(hostsByTestID(tree.root, `departure-row-${row.key}`)[0]?.props.accessibilityLabel).toBe('Orange Line to Airport, 9 min, Live');
  });
});
