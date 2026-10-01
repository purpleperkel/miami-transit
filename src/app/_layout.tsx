import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';

// The map is the app: screens render full-bleed under the root stack, with no header bar.
const ROOT_SCREEN_OPTIONS = { headerShown: false } as const;

export default function RootLayout() {
  invariant(Stack !== undefined, 'expo-router provides the Stack navigator');
  const navigator = <Stack screenOptions={ROOT_SCREEN_OPTIONS} />;
  invariant(isValidElement(navigator) && navigator.type === Stack, 'RootLayout renders the root Stack navigator');
  return navigator;
}
