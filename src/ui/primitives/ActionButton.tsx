import type { SFSymbol } from 'expo-symbols';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { RADIUS, SPACING } from '../tokens';
import { TText } from './TText';

const ICON_PT = 17;

export type ActionButtonProps = {
  readonly testID: string;
  /** An SF Symbol beside the words. */
  readonly symbol: SFSymbol;
  /** The words on the button, which VoiceOver also reads. */
  readonly label: string;
  /** What pressing does, for VoiceOver. */
  readonly hint: string;
  readonly onPress: () => void;
};

/**
 * A sheet's action (the station sheet's footer, the route options sheet, the Trips tab's empty state):
 * an SF Symbol and words on a grouped-background capsule, at least 44 pt tall, dimmed while pressed.
 * Never an icon alone (plan §4): the label is written on the button.
 */
export function ActionButton({ testID, symbol, label, hint, onPress }: ActionButtonProps) {
  invariant(label.trim().length > 0 && hint.trim().length > 0, 'an action says what it is and what it does');
  invariant(typeof onPress === 'function', 'an action does something');
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}>
      <SymbolView name={symbol} size={ICON_PT} tintColor={PlatformColor('label')} />
      <TText variant="headline">{label}</TText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: 44,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
  },
  pressed: { opacity: 0.6 },
});
