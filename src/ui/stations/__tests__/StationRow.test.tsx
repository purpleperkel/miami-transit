import { act, type ReactTestInstance } from 'react-test-renderer';

import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { StationRow } from '../StationRow';
import { GOVERNMENT_CENTER_ROW, WED_0800 } from './station-fixtures';

/** M6.5 + R7: one Stations row — its lines, its walking distance, its next scheduled departure per direction. */

afterEach(async () => {
  await unmountAll();
});

/** Every text the tree draws, in order. */
function texts(root: ReactTestInstance | undefined): string[] {
  expect(root).toBeDefined();
  const found = (root as ReactTestInstance).findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string').map((node) => String(node.props.children));
  expect(found.length).toBeGreaterThan(0);
  return found;
}

describe('StationRow (R7)', () => {
  it('row shows the next scheduled departure per direction inline', async () => {
    const tree = await renderPrimitive(<StationRow row={GOVERNMENT_CENTER_ROW} walkingMeters={null} nowS={WED_0800} onPress={jest.fn()} />);
    const south = hostsByTestID(tree.root, 'station-row-next-rail:government-ctr-0');
    const north = hostsByTestID(tree.root, 'station-row-next-rail:government-ctr-1');
    expect([south, north].map((found) => found.length)).toEqual([1, 1]);
    expect(texts(south[0])).toEqual(['Dadeland South', '1 min']);
    expect(texts(north[0])).toEqual(['Palmetto', '4 min']);
    const row = hostsByTestID(tree.root, 'station-row-rail:government-ctr')[0];
    expect(row?.props.accessibilityLabel).toBe(
      'Government Center, Metrorail; Green Line and Orange Line; next to Dadeland South, 1 min; next to Palmetto, 4 min',
    );
  });

  it('row shows the walking distance when a location is available', async () => {
    const located = await renderPrimitive(<StationRow row={GOVERNMENT_CENTER_ROW} walkingMeters={347} nowS={WED_0800} onPress={jest.fn()} />);
    const distance = hostsByTestID(located.root, 'station-row-distance-rail:government-ctr');
    expect(distance).toHaveLength(1);
    expect(distance[0]?.props.children).toBe('350 m');
    expect(hostsByTestID(located.root, 'station-row-rail:government-ctr')[0]?.props.accessibilityLabel).toContain('350 m away');
    const unlocated = await renderPrimitive(<StationRow row={GOVERNMENT_CENTER_ROW} walkingMeters={null} nowS={WED_0800} onPress={jest.fn()} />);
    expect(hostsByTestID(unlocated.root, 'station-row-distance-rail:government-ctr')).toHaveLength(0);
  });

  it('a row with nothing scheduled soon says so, and a tap opens its station', async () => {
    const onPress = jest.fn();
    const tree = await renderPrimitive(<StationRow row={{ ...GOVERNMENT_CENTER_ROW, next: [] }} walkingMeters={1234} nowS={WED_0800} onPress={onPress} />);
    expect(texts(tree.root)).toEqual(['Government Center', '1.2 km', 'Green', 'Orange', 'No departures in the next 3 hours']);
    await act(async () => {
      tree.root.findByProps({ testID: 'station-row-rail:government-ctr', accessibilityRole: 'button' }).props.onPress();
    });
    expect(onPress).toHaveBeenCalledWith('rail:government-ctr');
  });
});
