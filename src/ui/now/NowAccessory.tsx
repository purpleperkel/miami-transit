import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet, Text, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { type HurryTarget, useHurryVerdict } from '../hurry/useHurryVerdict';
import { openStationSheet } from '../sheets';
import { type AccessoryPlacement, nowAccessoryText, type NowText } from './now-text';

/**
 * The Now strip (ruling R2, plan M7c.3): the tab bar's bottom accessory, under every tab, says hurry or
 * chill for the NEAREST station — "Jog · makes the 2:14 with 1 min spare · Brickell" above the tab bar,
 * "Jog · 1 min" beside the minimized one (the placement iOS gives it, read with
 * NativeTabs.BottomAccessory.usePlacement). Tapping it opens that station's sheet; with no verdict to give
 * it opens Data & Settings, which the regular strip also keeps one tap away (its gear) — the data version
 * and Diagnostics live there, never in the strip. m7b extends the strip with trip and countdown context.
 *
 *   NowAccessory (placement, the hurry hook) → NowAccessoryView (props only, rendered in tests)
 */

export type NowAccessoryProps = {
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

const NEAREST: HurryTarget = Object.freeze({ kind: 'nearest' });
const DATA_SETTINGS = '/data';
const GEAR_PT = 17;

export function NowAccessory({ clock }: NowAccessoryProps) {
  const placement: AccessoryPlacement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  const reading = useHurryVerdict(NEAREST, clock);
  const said = nowAccessoryText(reading, placement);
  invariant(said.text.length > 0, 'the accessory always says something');
  return <NowAccessoryView placement={placement} said={said} stationKey={reading.kind === 'boards' ? reading.stationKey : null} />;
}

export type NowAccessoryViewProps = {
  readonly placement: AccessoryPlacement;
  readonly said: NowText;
  /** The station whose verdict is shown (a tap opens its sheet), or null with no verdict (a tap opens Data & Settings). */
  readonly stationKey: string | null;
};

export function NowAccessoryView({ placement, said, stationKey }: NowAccessoryViewProps) {
  invariant(said.text.length > 0 && said.label.length > 0, 'the accessory says something, to the eye and to VoiceOver');
  invariant(stationKey === null || stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  return (
    <View style={styles.accessory}>
      <Pressable
        testID="now-accessory"
        accessibilityRole="button"
        accessibilityLabel={said.label}
        onPress={() => (stationKey === null ? openDataSettings() : openStationSheet(stationKey))}
        style={styles.main}>
        <Text numberOfLines={1} style={styles.text}>
          {said.text}
        </Text>
      </Pressable>
      {placement === 'regular' ? (
        <Pressable testID="now-accessory-settings" accessibilityRole="button" accessibilityLabel="Data & Settings" hitSlop={8} onPress={openDataSettings}>
          <SymbolView name="gearshape" size={GEAR_PT} tintColor={PlatformColor('secondaryLabel')} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Data & Settings (M8b.1): the provider, the paces, the schedule's version; Diagnostics one tap further. */
function openDataSettings(): void {
  invariant(DATA_SETTINGS.startsWith('/'), 'Data & Settings is a route');
  invariant(typeof router.push === 'function', 'expo-router pushes routes');
  router.push(DATA_SETTINGS);
}

const styles = StyleSheet.create({
  accessory: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
  main: { flex: 1, justifyContent: 'center', alignSelf: 'stretch' },
  text: { fontSize: 15, fontVariant: ['tabular-nums'], color: PlatformColor('label') },
});
