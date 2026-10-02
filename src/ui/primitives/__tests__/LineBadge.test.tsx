import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { LINE_CATALOG, LINE_IDS, type LineId } from '../../../domain/lines/line-catalog';
import { lineColors } from '../../colors';
import { LineBadge, badgeText } from '../LineBadge';
import { hostsByTestID, renderPrimitive, unmountAll } from './render-primitive';

/** M6.2 LineBadge: a line's colour AND its name, labelled for VoiceOver from the line catalog. */

afterEach(unmountAll);

/** The badge's host view: the accessible node VoiceOver reads. */
async function badgeHost(lineId: LineId): Promise<ReactTestInstance> {
  const tree = await renderPrimitive(<LineBadge lineId={lineId} testID="badge" />);
  const hosts = hostsByTestID(tree.root, 'badge');
  expect(tree.root.findAllByType(LineBadge)).toHaveLength(1);
  expect(hosts).toHaveLength(1);
  return hosts[0] as ReactTestInstance;
}

describe('LineBadge', () => {
  it('GREEN has the accessibility label Green Line', async () => {
    const host = await badgeHost('GREEN');
    expect(host.props.accessibilityLabel).toBe('Green Line');
    expect(host.props.accessible).toBe(true);
  });

  it('every line is labelled with its catalog name and filled with its stroke colour', async () => {
    expect(LINE_CATALOG.map((line) => line.id)).toEqual([...LINE_IDS]);
    for (const line of LINE_CATALOG) {
      const host = await badgeHost(line.id);
      expect(host.props.accessibilityLabel).toBe(line.name);
      expect(StyleSheet.flatten(host.props.style).backgroundColor).toBe(lineColors(line.id, 'light').stroke);
    }
  });

  it('the name is written on the badge in its badge-text colour, never colour alone', async () => {
    expect(LINE_IDS.map(badgeText)).toEqual(['Green', 'Orange', 'Inner Loop', 'Omni', 'Brickell']);
    const host = await badgeHost('MM_OMNI');
    const texts = host.findAll((node) => typeof node.type === 'string' && node.props.children === 'Omni');
    expect(texts).toHaveLength(1);
    expect(StyleSheet.flatten(texts[0]?.props.style).color).toBe(lineColors('MM_OMNI', 'light').badgeText);
  });
});
