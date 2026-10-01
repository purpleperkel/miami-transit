import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { type DataStatus, statusFace } from '../dataStatus';
import { Glass } from '../primitives/Glass';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';

/** Where a tap on the pill goes: Data & Settings (plan §4: providers, keys, schedule). */
export const DATA_SETTINGS_ROUTE = '/data';
const ICON_PT = 17;

/** The live icon's radio waves light up in turn, over and over (unless Reduce Motion is on). */
const PULSE = { repeating: true, variableAnimationSpec: { iterative: true, dimInactiveLayers: true } } as const;

export type StatusPillProps = {
  readonly status: DataStatus;
  /** Reduce Motion: the live icon stays still. */
  readonly reduceMotion: boolean;
};

/**
 * The map's status pill (plan §4 "Status pill priority", M5.11): floating glass with an SF Symbol AND
 * a word for every status — never colour alone — whose live radio waves pulse. Tapping it opens
 * Data & Settings.
 */
export function StatusPill({ status, reduceMotion }: StatusPillProps) {
  const face = statusFace(status);
  invariant(face.text.length > 0, 'the pill always says something');
  invariant(typeof reduceMotion === 'boolean', 'the pill knows whether to animate');
  return (
    <Pressable
      testID="status-pill"
      accessibilityRole="button"
      accessibilityLabel={`${face.text}. Opens Data & Settings`}
      onPress={() => router.push(DATA_SETTINGS_ROUTE)}>
      <Glass style={styles.pill}>
        <SymbolView
          testID="status-pill-icon"
          name={face.icon}
          size={ICON_PT}
          tintColor={PlatformColor('label')}
          animationSpec={face.pulse && !reduceMotion ? PULSE : undefined}
        />
        <TText testID="status-pill-text" variant="subhead" numberOfLines={1}>
          {face.text}
        </TText>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
});
