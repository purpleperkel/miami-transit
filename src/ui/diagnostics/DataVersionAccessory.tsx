import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { PlatformColor, Pressable, StyleSheet, Text } from 'react-native';

import { useScheduleDb } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';

import { dataVersionText } from './data-version';

/**
 * The NativeTabs bottom accessory (M1.18; R3b, the interim until m7c's Now strip replaces it): says
 * the live status and when the bundled schedule runs out, in words ("Live · schedule to Nov 22"), and
 * opens Data & Settings (M8b.1; Diagnostics is one tap further). iOS renders one copy per placement
 * (regular above the tab bar, inline beside it). The schedule DB state comes from the root
 * ScheduleDbProvider; the live status only READS the live runtime's latest state (useLive) — the
 * accessory never asks the runtime for anything (realtime calls are metered).
 */
export function DataVersionAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  const { text, accessibilityLabel } = dataVersionText(useScheduleDb(), placement, useLive().state);
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
