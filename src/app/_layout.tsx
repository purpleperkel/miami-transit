import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { ScheduleDbProvider } from '@/data/schedule-db-provider';
import { invariant } from '@/lib/invariant';
import { LiveDataProvider } from '@/live/live-context';

// The map is the app: the tab shell renders full-bleed under the root stack, with no header bar.
const ROOT_SCREEN_OPTIONS = { headerShown: false } as const;
// Pushed screens above the tabs get a native header with a back button.
const DIAGNOSTICS_OPTIONS = { headerShown: true, title: 'Diagnostics' } as const;

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
          <Stack.Screen name="diagnostics" options={DIAGNOSTICS_OPTIONS} />
        </Stack>
      </LiveDataProvider>
    </ScheduleDbProvider>
  );
  invariant(isValidElement(root) && root.type === ScheduleDbProvider, 'RootLayout renders the schedule DB provider around the root Stack');
  return root;
}
