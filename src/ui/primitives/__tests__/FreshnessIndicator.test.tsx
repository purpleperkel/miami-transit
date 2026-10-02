import { SymbolView } from 'expo-symbols';

import { statusFace } from '../../dataStatus';
import { FRESHNESS_KINDS, type Freshness, FreshnessIndicator } from '../FreshnessIndicator';
import { hostsByTestID, renderPrimitive, unmountAll } from './render-primitive';

/** M6.2 FreshnessIndicator: an icon AND a word for every freshness state (plan §4: never colour alone). */

afterEach(unmountAll);

/** One example of every freshness state, in FRESHNESS_KINDS order. */
const EVERY_FRESHNESS: readonly Freshness[] = [{ kind: 'live' }, { kind: 'stale', ageS: 130 }, { kind: 'scheduled' }];

describe('FreshnessIndicator', () => {
  it('pairs every status icon with a word', async () => {
    expect(EVERY_FRESHNESS.map((freshness) => freshness.kind)).toEqual([...FRESHNESS_KINDS]);
    for (const freshness of EVERY_FRESHNESS) {
      const tree = await renderPrimitive(<FreshnessIndicator testID="fresh" freshness={freshness} />);
      const icons = tree.root.findAllByType(SymbolView);
      const words = hostsByTestID(tree.root, 'fresh-word');
      expect(icons).toHaveLength(1);
      expect(icons[0]?.props.name).toBe(statusFace(freshness).icon);
      expect(words).toHaveLength(1);
      expect(words[0]?.props.children).toBe(statusFace(freshness).text);
      expect(hostsByTestID(tree.root, 'fresh')[0]?.props.accessibilityLabel).toBe(statusFace(freshness).text);
    }
  });

  it('each state has its own icon and its own word', () => {
    const faces = EVERY_FRESHNESS.map((freshness) => statusFace(freshness));
    expect(faces.map((face) => face.icon)).toEqual(['dot.radiowaves.left.and.right', 'clock', 'calendar']);
    expect(faces.map((face) => face.text)).toEqual(['Live', 'Live · 2 min old', 'Scheduled']);
  });

  it('the icon sits still in a list', async () => {
    const tree = await renderPrimitive(<FreshnessIndicator testID="fresh" freshness={{ kind: 'live' }} />);
    expect(tree.root.findByType(SymbolView).props.animationSpec).toBeUndefined();
    expect(statusFace({ kind: 'live' }).pulse).toBe(true);
  });
});
