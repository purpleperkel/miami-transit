import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';

// NativeTabs draws no header of its own (a Trigger's label is only the tab-bar label), so the tab nests a
// native Stack: an iOS large title that collapses on scroll, and the content starts below the status bar.
const TRIPS_OPTIONS = { title: 'Trips', headerLargeTitleEnabled: true } as const;

/** The Trips tab's native header Stack (R3a): saved trips under a "Trips" large title. */
export default function TripsLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const stack = (
    <Stack>
      <Stack.Screen name="index" options={TRIPS_OPTIONS} />
    </Stack>
  );
  invariant(isValidElement(stack) && stack.type === Stack, 'the Trips tab renders a native Stack');
  return stack;
}
