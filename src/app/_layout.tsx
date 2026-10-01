import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { ScheduleDbProvider } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';
import { LiveDataProvider } from '@/live/live-context';

// The map is the app: the tab shell renders full-bleed under the root stack, with no header bar.
// Every screen pushed above the tabs shows a native header whose back button would read the screen
// beneath's title — for the tab shell, its route name "(tabs)" (seen on the phone at M1.19). So the
// stack's default back label is a real word, whichever tab the screen was opened from; a screen
// pushed from another pushed screen names that screen instead.
const ROOT_SCREEN_OPTIONS = { headerShown: false, headerBackTitle: 'Back' } as const;
const DATA_TITLE = 'Data & Settings';
// Data & Settings (M8b.1) is opened from any tab (the accessory); its back button shows only its chevron.
const DATA_OPTIONS = { headerShown: true, title: DATA_TITLE, headerBackButtonDisplayMode: 'minimal' } as const;
// Diagnostics is reached from Data & Settings (one tap further), so its back button names it.
const DIAGNOSTICS_OPTIONS = { headerShown: true, title: 'Diagnostics', headerBackTitle: DATA_TITLE } as const;
// Layers (M5.12) is a native formSheet over the map (§4 Sheets): half height, pulled up to full, with a
// grabber; the map under it stays bright at half height, so each switch is seen to change it.
const LAYERS_OPTIONS = {
  headerShown: true,
  title: 'Layers',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.5, 1] as number[],
  sheetGrabberVisible: true,
  sheetLargestUndimmedDetentIndex: 0,
} as const;

/**
 * The root: the bundled schedule DB (M3.8) is opened once, here, for every screen, and the live
 * runtime (M4.9) runs over it — polling only while the app is active.
 */
export default function RootLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const root = (
    <ScheduleDbProvider>
      <LiveDataProvider>
        <Stack screenOptions={ROOT_SCREEN_OPTIONS}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="data" options={DATA_OPTIONS} />
          <Stack.Screen name="diagnostics" options={DIAGNOSTICS_OPTIONS} />
          <Stack.Screen name="layers" options={LAYERS_OPTIONS} />
        </Stack>
      </LiveDataProvider>
    </ScheduleDbProvider>
  );
  invariant(isValidElement(root) && root.type === ScheduleDbProvider, 'RootLayout renders the schedule DB provider around the root Stack');
  return root;
}
