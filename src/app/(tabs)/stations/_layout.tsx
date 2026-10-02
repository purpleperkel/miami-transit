import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';

// NativeTabs draws no header of its own (a Trigger's label is only the tab-bar label), so the tab nests a
// native Stack: an iOS large title that collapses on scroll, and the list starts below the status bar.
const STATIONS_OPTIONS = { title: 'Stations', headerLargeTitleEnabled: true } as const;

/** The Stations tab's native header Stack (R3a): the list under a "Stations" large title. */
export default function StationsLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const stack = (
    <Stack>
      <Stack.Screen name="index" options={STATIONS_OPTIONS} />
    </Stack>
  );
  invariant(isValidElement(stack) && stack.type === Stack, 'the Stations tab renders a native Stack');
  return stack;
}
