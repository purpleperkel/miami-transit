import { SymbolView } from 'expo-symbols';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import { statusFace } from '../../dataStatus';
import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { DirectionGroup, type DirectionGroupProps } from '../DirectionGroup';
import { BOARD, NOW_S, batch, departure, prediction } from './board-fixtures';

/**
 * M6.3 DirectionGroup: one direction of the board, live predictions merged in through m4a's
 * merge-departures, capped at maxRows, with source icons only where live and scheduled rows mix.
 */

afterEach(unmountAll);

const ROW = /^departure-row-/;
const SOURCE = /^departure-source-/;
const A_0828 = departure('trip-a', 8, 28);
const B_0834 = departure('trip-b', 8, 34, 'GREEN');
const C_0846 = departure('trip-c', 8, 46);

/** A northbound group at NOW_S over the fixture window. */
async function renderGroup(props: Pick<DirectionGroupProps, 'departures' | 'predictions' | 'maxRows'>): Promise<ReactTestRenderer> {
  const tree = await renderPrimitive(<DirectionGroup title="To Palmetto and the Airport" window={BOARD} nowS={NOW_S} {...props} />);
  expect(hostsByTestID(tree.root, 'direction-group')).toHaveLength(1);
  expect(hostsByTestID(tree.root, ROW).length).toBeLessThanOrEqual(props.maxRows);
  return tree;
}

/** The SF Symbol name inside one row's source icon. */
function sourceIconName(source: ReactTestInstance): string {
  const symbols = source.findAllByType(SymbolView);
  expect(symbols).toHaveLength(1);
  expect(typeof symbols[0]?.props.name).toBe('string');
  return String(symbols[0]?.props.name);
}

describe('DirectionGroup', () => {
  it('same-source rows show no per-row source icon', async () => {
    const scheduled = await renderGroup({ departures: [A_0828, B_0834, C_0846], predictions: null, maxRows: 5 });
    expect([hostsByTestID(scheduled.root, ROW).length, hostsByTestID(scheduled.root, SOURCE).length]).toEqual([3, 0]);
    expect(hostsByTestID(scheduled.root, /^direction-freshness-[a-z]+$/).map((node) => node.props.testID)).toEqual(['direction-freshness-scheduled']);
    const everyTrip = [A_0828, B_0834, C_0846].map((d) => prediction(d.tripId, { lineId: d.lineId === 'GREEN' ? 'GREEN' : 'ORANGE', epoch: d.epoch + 60 }));
    const live = await renderGroup({ departures: [A_0828, B_0834, C_0846], predictions: batch(everyTrip), maxRows: 5 });
    expect([hostsByTestID(live.root, ROW).length, hostsByTestID(live.root, SOURCE).length]).toEqual([3, 0]);
    expect(hostsByTestID(live.root, /^direction-freshness-[a-z]+$/).map((node) => node.props.testID)).toEqual(['direction-freshness-live']);
  });

  it('mixed-source rows each show a source icon', async () => {
    const tree = await renderGroup({ departures: [A_0828, B_0834, C_0846], predictions: batch([prediction('trip-b', { lineId: 'GREEN', epoch: B_0834.epoch + 60 })]), maxRows: 5 });
    const sources = hostsByTestID(tree.root, SOURCE);
    expect([hostsByTestID(tree.root, ROW).length, sources.length]).toEqual([3, 3]);
    const icons = sources.map((source) => [String(source.props.testID).includes('trip-b'), sourceIconName(source)]);
    expect(icons).toEqual([
      [false, statusFace({ kind: 'scheduled' }).icon],
      [true, statusFace({ kind: 'live' }).icon],
      [false, statusFace({ kind: 'scheduled' }).icon],
    ]);
    expect(hostsByTestID(tree.root, /^direction-freshness-[a-z]+$/).map((node) => node.props.testID)).toEqual(['direction-freshness-live', 'direction-freshness-scheduled']);
  });

  it('renders at most maxRows rows', async () => {
    const six = [6, 12, 18, 24, 30, 36].map((mm, i) => departure(`trip-${i + 1}`, 8, 22 + mm));
    const tree = await renderGroup({ departures: six, predictions: null, maxRows: 3 });
    const rows = hostsByTestID(tree.root, ROW).map((node) => String(node.props.testID));
    expect(rows).toEqual(['trip-1', 'trip-2', 'trip-3'].map((trip) => `departure-row-20261001:${trip}:9513`));
    expect(hostsByTestID(tree.root, /^departure-time-/).map((node) => node.props.children)).toEqual(['8 min', '14 min', '20 min']);
  });

  it('live prediction replaces the scheduled time', async () => {
    expect(hostsByTestID((await renderGroup({ departures: [A_0828], predictions: null, maxRows: 3 })).root, ROW)[0]?.props.accessibilityLabel).toBe('Orange Line to Airport, 8 min');
    const tree = await renderGroup({ departures: [A_0828], predictions: batch([prediction('trip-a', { epoch: A_0828.epoch + 360 })]), maxRows: 3 });
    const time = hostsByTestID(tree.root, /^departure-time-/);
    expect(time.map((node) => node.props.children)).toEqual(['14 min']);
    expect(hostsByTestID(tree.root, ROW)[0]?.props.accessibilityLabel).toBe('Orange Line to Airport, 14 min');
  });
});

describe('DirectionGroup with nothing to show', () => {
  it('says there are no upcoming departures and names no source', async () => {
    const tree = await renderGroup({ departures: [], predictions: batch([prediction('extra-1', { lineId: null, epoch: NOW_S + 60 })]), maxRows: 3 });
    expect(tree.root.findAll((node) => typeof node.type === 'string' && node.props.children === 'No upcoming departures')).toHaveLength(1);
    expect(hostsByTestID(tree.root, /^direction-freshness-/)).toHaveLength(0);
  });
});
