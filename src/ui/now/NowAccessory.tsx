import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { wallClockNowS } from '../clock';
import { type HurryTarget, useHurryVerdict } from '../hurry/useHurryVerdict';
import { openStationSheet } from '../sheets';
import { countdown } from '../trips/countdown';
import { openTrip } from '../trips/trip-routes';
import { nowStripText } from './now-strip';
import type { AccessoryPlacement, NowText } from './now-text';
import { NowStripContent, stripEmphasis } from './NowStripContent';
import { useHomeContext } from './useHomeContext';

/**
 * The Now strip (ruling R2, plan M7c.3): the tab bar's bottom accessory, under every tab, says hurry or
 * chill for the NEAREST station — "Jog · makes the 2:14 with 1 min spare · Brickell" above the tab bar,
 * "Jog · 1 min" beside the minimized one (the placement iOS gives it, read with
 * NativeTabs.BottomAccessory.usePlacement). Tapping it opens that station's sheet; with no verdict to give
 * it opens Data & Settings, which the regular strip also keeps one tap away (its gear) — the data version
 * and Diagnostics live there, never in the strip.
 *
 * m7b (M7.7) extends it with the HOME CONTEXT (homeContext.ts): a saved trip leaving within the hour
 * takes the strip — "Leave in 6 min · Home → Work", "Leave in 6 min" inline — and a tap opens the trip;
 * when nothing runs (01:30) it says so and when service starts again; otherwise it is the nearest
 * station's hurry or chill as above. The context is published to the Now store, where the Map tab reads
 * whether to auto-present the station the rider is at (useAutoPresent.ts).
 *
 *   NowAccessory (placement, the hurry hook, the home context) → NowAccessoryView (props only, rendered in tests)
 */

export type NowAccessoryProps = {
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

const NEAREST: HurryTarget = Object.freeze({ kind: 'nearest' });
const DATA_SETTINGS = '/data';
const GEAR_PT = 17;

export function NowAccessory({ clock = wallClockNowS }: NowAccessoryProps) {
  const placement: AccessoryPlacement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  const reading = useHurryVerdict(NEAREST, clock);
  const context = useHomeContext(clock);
  const said = nowStripText(context, reading, placement);
  invariant(said.text.length > 0, 'the accessory always says something');
  const trip = context.kind === 'trip' ? context.trip : null;
  const state = context.kind === 'trip' ? countdown(context.trip.status.current.leaveByEpoch, context.nowS).state : null;
  const stationKey = trip === null && context.kind !== 'noService' && reading.kind === 'boards' ? reading.stationKey : null;
  return <NowAccessoryView placement={placement} said={said} stationKey={stationKey} tripId={trip?.card.trip.id ?? null} emphasis={stripEmphasis(context, state)} />;
}

export type NowAccessoryViewProps = {
  readonly placement: AccessoryPlacement;
  readonly said: NowText;
  /** The station whose verdict is shown (a tap opens its sheet), or null with no verdict (a tap opens Data & Settings). */
  readonly stationKey: string | null;
  /** The saved trip whose countdown is shown (a tap opens the trip); absent or null otherwise (M7.7). */
  readonly tripId?: string | null;
  /** The countdown's colour for a trip in its last minutes. */
  readonly emphasis?: 'none' | 'soon' | 'now';
};

export function NowAccessoryView({ placement, said, stationKey, tripId = null, emphasis = 'none' }: NowAccessoryViewProps) {
  invariant(said.text.length > 0 && said.label.length > 0, 'the accessory says something, to the eye and to VoiceOver');
  invariant(stationKey === null || stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
  invariant(tripId === null || stationKey === null, 'the strip is about a trip or a station, not both');
  return (
    <View style={styles.accessory}>
      <Pressable
        testID="now-accessory"
        accessibilityRole="button"
        accessibilityLabel={said.label}
        onPress={() => (tripId !== null ? openTrip(tripId) : stationKey === null ? openDataSettings() : openStationSheet(stationKey))}
        style={styles.main}>
        <NowStripContent placement={placement} said={said} emphasis={emphasis} />
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
});
