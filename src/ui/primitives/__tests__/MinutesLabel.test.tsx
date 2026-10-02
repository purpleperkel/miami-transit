import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { formatClockFromServiceSec } from '../../format';
import { CLOCK_AFTER_S, MinutesLabel } from '../MinutesLabel';
import { hostsByTestID, renderPrimitive, unmountAll } from './render-primitive';

/** M6.2 MinutesLabel: minutes for the next hour, a clock time beyond it. */

afterEach(unmountAll);

const NOW_S = 1_790_870_400;

/** The one host text a label rendered. */
async function shown(element: ReactElement): Promise<ReactTestInstance> {
  const tree = await renderPrimitive(element);
  const texts = hostsByTestID(tree.root, 'when');
  expect(texts).toHaveLength(1);
  expect(typeof texts[0]?.props.children).toBe('string');
  return texts[0] as ReactTestInstance;
}

describe('MinutesLabel', () => {
  it('over 60 min renders a clock time', async () => {
    const text = await shown(<MinutesLabel testID="when" epoch={NOW_S + 61 * 60} nowS={NOW_S} depS={97200} />);
    expect(text.props.children).toBe('3:00 AM');
    expect(text.props.children).toBe(formatClockFromServiceSec(97200));
  });

  it('up to an hour away it counts minutes, and under half a minute it reads Now', async () => {
    expect(CLOCK_AFTER_S).toBe(3600);
    const hour = await shown(<MinutesLabel testID="when" epoch={NOW_S + CLOCK_AFTER_S} nowS={NOW_S} depS={97200} />);
    expect(hour.props.children).toBe('60 min');
    await unmountAll();
    const soon = await shown(<MinutesLabel testID="when" epoch={NOW_S + 4 * 60 + 10} nowS={NOW_S} depS={97200} />);
    expect(soon.props.children).toBe('4 min');
    await unmountAll();
    const now = await shown(<MinutesLabel testID="when" epoch={NOW_S + 10} nowS={NOW_S} depS={97200} />);
    expect(now.props.children).toBe('Now');
  });

  it('digits are tabular, and a struck time is drawn through', async () => {
    const plain = await shown(<MinutesLabel testID="when" epoch={NOW_S + 600} nowS={NOW_S} depS={97200} />);
    expect(StyleSheet.flatten(plain.props.style).fontVariant).toContain('tabular-nums');
    expect(StyleSheet.flatten(plain.props.style).textDecorationLine).toBeUndefined();
    await unmountAll();
    const struck = await shown(<MinutesLabel testID="when" epoch={NOW_S + 600} nowS={NOW_S} depS={97200} struck />);
    expect(StyleSheet.flatten(struck.props.style).textDecorationLine).toBe('line-through');
  });
});
