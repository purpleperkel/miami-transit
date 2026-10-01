import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { DataVersionAccessory } from '@/ui/diagnostics/DataVersionAccessory';

/**
 * The tab shell (M1.18): native iOS tabs (Liquid Glass on iOS 26+) with one Map tab for now, plus
 * the bottom accessory showing the data version. M5.5 adds the Trips and Stations tabs.
 * SDK 55–57 import NativeTabs from `expo-router/unstable-native-tabs`.
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
    </NativeTabs>
  );
  invariant(isValidElement(tabs) && tabs.type === NativeTabs, 'TabsLayout renders the NativeTabs navigator');
  return tabs;
}
