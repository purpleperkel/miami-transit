import { PlatformColor, StyleSheet, Text } from 'react-native';

import { invariant } from '@/lib/invariant';

import type { HomeContext } from './homeContext';
import type { AccessoryPlacement, NowText } from './now-text';

export type NowStripContentProps = {
  readonly placement: AccessoryPlacement;
  readonly said: NowText;
  /** What the strip is about: a live trip's line takes the countdown's colour when it is time to go. */
  readonly emphasis?: 'none' | 'soon' | 'now';
};

/** The strip's colour per emphasis: a trip leaving soon is orange (plan §4), "Leave now" green; else the label colour. */
const EMPHASIS_COLOR: Readonly<Record<NonNullable<NowStripContentProps['emphasis']>, string>> = { none: 'label', soon: 'systemOrange', now: 'systemGreen' };

/**
 * The Now bar's content (M7.7; mfix8): the home context as now-strip.ts words it, ONE Text per line, each a
 * single line of tabular 15 pt text (the size the regular bar's character budget was measured at). Above the
 * tab bar a second line puts what the bar is about first, in semibold (a saved trip's destination), and the
 * status under it; the status — the last line — takes the countdown's colour. Inline (beside the minimized
 * tab bar) it is one line of at most 14 characters. VoiceOver reads the strip's label, not its lines.
 */
export function NowStripContent({ placement, said, emphasis = 'none' }: NowStripContentProps) {
  invariant(said.lines.length > 0, 'the strip always says something');
  invariant(placement === 'regular' || said.lines.length === 1, 'inline, the strip is one line');
  const last = said.lines.length - 1;
  return (
    <>
      {said.lines.map((line, i) => (
        <Text key={`line-${i}`} numberOfLines={1} style={[styles.text, i < last ? styles.headline : null, { color: PlatformColor(i === last ? EMPHASIS_COLOR[emphasis] : 'label') }]}>
          {line}
        </Text>
      ))}
    </>
  );
}

/** How strongly the strip shows a context: a live trip's countdown in its last minutes stands out. */
export function stripEmphasis(context: HomeContext, state: 'clock' | 'normal' | 'soon' | 'now' | 'missed' | null): NonNullable<NowStripContentProps['emphasis']> {
  invariant(typeof context.kind === 'string', 'a home context has a kind');
  invariant(state === null || context.kind === 'trip', 'only a trip has a countdown state');
  return context.kind !== 'trip' || state === null ? 'none' : state === 'soon' ? 'soon' : state === 'now' ? 'now' : 'none';
}

const styles = StyleSheet.create({
  text: { fontSize: 15, fontVariant: ['tabular-nums'] },
  headline: { fontWeight: '600' },
});
