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
 * The Now strip's content (M7.7): one line of tabular text — the home context as now-strip.ts words it —
 * in either placement iOS gives the accessory (regular above the tab bar, inline beside the minimized
 * one, where it is at most 14 characters). One Text, so VoiceOver reads the strip's label, not its parts.
 */
export function NowStripContent({ placement, said, emphasis = 'none' }: NowStripContentProps) {
  invariant(said.text.length > 0, 'the strip always says something');
  invariant(placement === 'regular' || placement === 'inline', 'the strip renders in a known placement');
  return (
    <Text numberOfLines={1} style={[styles.text, { color: PlatformColor(EMPHASIS_COLOR[emphasis]) }]}>
      {said.text}
    </Text>
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
});
