import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';

// The map is the app: the tab shell renders full-bleed under the root stack, with no header bar.
const ROOT_SCREEN_OPTIONS = { headerShown: false } as const;
// Pushed screens above the tabs get a native header with a back button.
const DIAGNOSTICS_OPTIONS = { headerShown: true, title: 'Diagnostics' } as const;

export default function RootLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const navigator = (
    <Stack screenOptions={ROOT_SCREEN_OPTIONS}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="diagnostics" options={DIAGNOSTICS_OPTIONS} />
    </Stack>
  );
  invariant(isValidElement(navigator) && navigator.type === Stack, 'RootLayout renders the root Stack navigator');
  return navigator;
}
