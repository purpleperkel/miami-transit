import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { PlatformColor, Pressable, StyleSheet, Text } from 'react-native';

import probeManifest from '@/assets/db/probe-manifest.json';
import { invariant } from '@/lib/invariant';

const SHORT_SHA_LENGTH = 8;

/**
 * The data version. At M1 the only bundled data is the probe DB, so its content hash — the
 * dbSha256 the generator writes into assets/db/probe-manifest.json — IS the data version, in the
 * same form the schedule manifest will carry it (M2.17). Real bytes, never a placeholder.
 */
export const DATA_VERSION = `probe ${probeManifest.dbSha256.slice(0, SHORT_SHA_LENGTH)}`;

/**
 * The NativeTabs bottom accessory (M1.18): shows the data version and opens Diagnostics. iOS
 * renders one copy per placement (regular above the tab bar, inline beside it); it keeps no state.
 */
export function DataVersionAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  invariant(/^[0-9a-f]{64}$/.test(probeManifest.dbSha256), 'the data version comes from a real SHA-256');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Data version ${DATA_VERSION}. Opens Diagnostics.`}
      onPress={() => router.push('/diagnostics')}
      style={styles.accessory}>
      <Text numberOfLines={1} style={styles.text}>
        {placement === 'inline' ? DATA_VERSION : `Data ${DATA_VERSION} · Diagnostics`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  accessory: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  text: { fontSize: 15, fontVariant: ['tabular-nums'], color: PlatformColor('label') },
});
