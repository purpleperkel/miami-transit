import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { PlatformColor, Pressable, StyleSheet, Text } from 'react-native';

import { useScheduleDb } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';

import { dataVersionText } from './data-version';

/**
 * The NativeTabs bottom accessory (M1.18): shows the data version — the schedule DB the phone has
 * open (M3.8) — and opens Data & Settings (M8b.1; Diagnostics is one tap further). iOS renders one
 * copy per placement (regular above the tab bar, inline beside it); the DB state comes from the root
 * ScheduleDbProvider.
 */
export function DataVersionAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  const { text, accessibilityLabel } = dataVersionText(useScheduleDb(), placement);
  invariant(text.length > 0 && accessibilityLabel.length > 0, 'the accessory always says something');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => router.push('/data')}
      style={styles.accessory}>
      <Text numberOfLines={1} style={styles.text}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  accessory: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  text: { fontSize: 15, fontVariant: ['tabular-nums'], color: PlatformColor('label') },
});
