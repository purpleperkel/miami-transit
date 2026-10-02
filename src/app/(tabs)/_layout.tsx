import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { DataVersionAccessory } from '@/ui/diagnostics/DataVersionAccessory';

/**
 * The tab shell (M1.18, M5.5): native iOS tabs (Liquid Glass on iOS 26+) — Map, Trips, Stations —
 * plus the bottom accessory, which says the live status and when the schedule runs out, and opens
 * Data & Settings. SDK 55–57 import NativeTabs from `expo-router/unstable-native-tabs`.
 *
 * A Trigger names its route relative to this layout. trips/ and stations/ each have a _layout of
 * their own (a native header Stack, R3a: NativeTabs draws no header), so each tab is named by its
 * folder alone.
 */
export default function TabsLayout() {
  invariant(NativeTabs.BottomAccessory !== undefined, 'expo-router 57 provides NativeTabs.BottomAccessory');
  const tabs = (
    <NativeTabs>
      <NativeTabs.BottomAccessory>
        <DataVersionAccessory />
      </NativeTabs.BottomAccessory>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Map</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'map', selected: 'map.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="trips">
        <NativeTabs.Trigger.Label>Trips</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="stations">
        <NativeTabs.Trigger.Label>Stations</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tram', selected: 'tram.fill' }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
  invariant(isValidElement(tabs) && tabs.type === NativeTabs, 'TabsLayout renders the NativeTabs navigator');
  return tabs;
}
