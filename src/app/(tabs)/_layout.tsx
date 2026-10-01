import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { DataVersionAccessory } from '@/ui/diagnostics/DataVersionAccessory';

/**
 * The tab shell (M1.18, M5.5): native iOS tabs (Liquid Glass on iOS 26+) — Map, Trips, Stations —
 * plus the bottom accessory, which shows the data version and opens Data & Settings.
 * SDK 55–57 import NativeTabs from `expo-router/unstable-native-tabs`.
 *
 * A Trigger names its route relative to this layout. trips/ and stations/ have no _layout of their
 * own, so expo-router hoists their index files here as "trips/index" and "stations/index"; a folder
 * that gains a _layout (M6.5's Stations header Stack) is then named by the folder alone.
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
      <NativeTabs.Trigger name="trips/index">
        <NativeTabs.Trigger.Label>Trips</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="stations/index">
        <NativeTabs.Trigger.Label>Stations</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tram', selected: 'tram.fill' }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
  invariant(isValidElement(tabs) && tabs.type === NativeTabs, 'TabsLayout renders the NativeTabs navigator');
  return tabs;
}
