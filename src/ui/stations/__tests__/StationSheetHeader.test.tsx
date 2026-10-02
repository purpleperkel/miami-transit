import { Text } from 'react-native';

import { hostsByTestID, renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { StationSheetHeader } from '../StationSheetHeader';

/** M6.4 + R7: the station sheet's header, with the slot m7c's hurry-or-chill verdict renders into. */

afterEach(async () => {
  await unmountAll();
});

describe('StationSheetHeader (M6.4)', () => {
  it('sheet header renders the verdict passed into its slot', async () => {
    const verdict = <Text testID="hurry-verdict">Chill · 3 min to spare</Text>;
    const withVerdict = await renderPrimitive(<StationSheetHeader mode="rail" lines={['GREEN', 'ORANGE']} verdict={verdict} />);
    // The slot sits inside the header, and holds exactly what was passed.
    const [header] = hostsByTestID(withVerdict.root, 'station-sheet-header');
    expect(header).toBeDefined();
    const slot = header === undefined ? [] : hostsByTestID(header, 'station-sheet-verdict');
    expect(slot).toHaveLength(1);
    expect(slot[0] === undefined ? null : hostsByTestID(slot[0], 'hurry-verdict')[0]?.props.children).toBe('Chill · 3 min to spare');
    const without = await renderPrimitive(<StationSheetHeader mode="rail" lines={['GREEN', 'ORANGE']} />);
    expect(hostsByTestID(without.root, 'station-sheet-verdict')).toHaveLength(0);
    expect(hostsByTestID(without.root, 'hurry-verdict')).toHaveLength(0);
  });

  it('names the lines and the system', async () => {
    const tree = await renderPrimitive(<StationSheetHeader mode="mover" lines={['MM_INNER', 'MM_OMNI', 'MM_BRICKELL']} />);
    expect(hostsByTestID(tree.root, 'station-sheet-lines')[0]?.props.accessibilityLabel).toBe('Inner Loop, Omni and Brickell');
    expect(JSON.stringify(tree.toJSON())).toContain('"Metromover"');
  });
});
