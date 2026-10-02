import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { wallClockNowS } from '../clock';
import { useNearTripVerdict } from '../hurry/useHurryVerdict';
import { openPlanSheet } from '../sheets';
import { countdown } from '../trips/countdown';
import { openTrip } from '../trips/trip-routes';
import { useNearTripWalk } from './near-trip-walk';
import { nowStripText, type StripTarget, stripTarget } from './now-strip';
import type { AccessoryPlacement, NowText } from './now-text';
import { NowStripContent, stripEmphasis } from './NowStripContent';
import { useHomeContext } from './useHomeContext';

/**
 * The Now bar (ruling R2; plan M7c.3, M7.7; mfix8): the tab bar's bottom accessory, under every tab. SAVED TRIPS
 * drive it (decision.miami_transit_bar_uses_saved_trips, Jamie 2026-10-02: "By biggest gripe is how it says 'not
 * worth it next in 10 min fifth street' without me even entering where I wanna go"), in the home context's
 * order (homeContext.ts):
 *
 *   a trip counting down, not near   "Dadeland South" / "Leave in 6 min"                     tap: the trip
 *   a saved trip the rider is near   "Bayfront Park" / "Chill · 4 min spare · ~5 min walk"   tap: the trip
 *   nothing runs (01:30)             "No trains now" / "Metrorail opens 5:00 AM"             tap: Data & Settings
 *   otherwise                        "Where to?" — no verdict at all                         tap: route options
 *
 * Above the tab bar ("regular") the first line names what is judged; beside the minimized tab bar ("inline",
 * the placement iOS gives it, read with NativeTabs.BottomAccessory.usePlacement) it is one short line. The
 * regular bar keeps Data & Settings one tap away (its gear) — the data version and Diagnostics live there,
 * never in the bar. The home context is published to the Now store, where the Map tab reads whether to
 * auto-present the station the rider is at (useAutoPresent.ts).
 *
 * A near trip's walk (mfix9) is the street-routed walk to its boarding platform when the app's RoutedWalkProvider knows
 * one (useNearTripWalk), else m7c's straight-line estimate; VoiceOver hears which.
 *
 *   NowAccessory (placement, the home context, the near trip's walk and verdict) → NowAccessoryView (props only, rendered in tests)
 */

export type NowAccessoryProps = {
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

const DATA_SETTINGS = '/data';
const GEAR_PT = 17;

export function NowAccessory({ clock = wallClockNowS }: NowAccessoryProps) {
  const placement: AccessoryPlacement = NativeTabs.BottomAccessory.usePlacement();
  invariant(placement === 'regular' || placement === 'inline', 'the accessory renders in a known placement');
  const context = useHomeContext(clock);
  const walk = useNearTripWalk(context);
  const verdict = useNearTripVerdict(context, walk);
  const said = nowStripText(context, verdict, placement);
  invariant(said.lines.length > 0, 'the accessory always says something');
  const state = context.kind === 'trip' ? countdown(context.trip.status.current.leaveByEpoch, context.nowS).state : null;
  return <NowAccessoryView placement={placement} said={said} target={stripTarget(context)} emphasis={stripEmphasis(context, state)} />;
}

export type NowAccessoryViewProps = {
  readonly placement: AccessoryPlacement;
  readonly said: NowText;
  /** Where a tap goes: the trip shown, route options ("Where to?"), or Data & Settings (no service). */
  readonly target: StripTarget;
  /** The countdown's colour for a trip in its last minutes. */
  readonly emphasis?: 'none' | 'soon' | 'now';
};

export function NowAccessoryView({ placement, said, target, emphasis = 'none' }: NowAccessoryViewProps) {
  invariant(said.lines.length > 0 && said.label.length > 0, 'the accessory says something, to the eye and to VoiceOver');
  invariant(target.kind !== 'trip' || target.tripId.length > 0, 'a trip is opened by its id');
  return (
    <View style={styles.accessory}>
      <Pressable testID="now-accessory" accessibilityRole="button" accessibilityLabel={said.label} onPress={() => openTarget(target)} style={styles.main}>
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

/** Opens what a tap on the bar is about. */
function openTarget(target: StripTarget): void {
  invariant(typeof target.kind === 'string', 'a tap has a target');
  invariant(target.kind !== 'trip' || target.tripId.length > 0, 'a trip is opened by its id');
  switch (target.kind) {
    case 'trip':
      openTrip(target.tripId);
      break;
    case 'plan':
      openPlanSheet();
      break;
    case 'settings':
      openDataSettings();
      break;
  }
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
