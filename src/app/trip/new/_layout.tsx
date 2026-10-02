import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { CancelAddTrip } from '@/ui/trips/add/AddTripSteps';

// The add-trip flow (M7.9) is a modal (root _layout.tsx: ADD_TRIP_OPTIONS) holding its own Stack, so each
// step has a real title and its back button names the step before it (M1.19: never a route name). Every
// step can Cancel the whole flow. There is no index route: every door names its step (from, or to).
const FLOW_OPTIONS = { headerShown: true, headerBackTitle: 'Back', headerRight: () => <CancelAddTrip /> } as const;
const FROM_OPTIONS = { title: 'Leaving from' } as const;
const TO_OPTIONS = { title: 'Going to' } as const;
const START_OPTIONS = { title: 'Your walk' } as const;
const CONFIRM_OPTIONS = { title: 'Save trip' } as const;

/** The add-trip flow's Stack: from → to → start (the walk) → confirm. */
export default function AddTripLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const stack = (
    <Stack screenOptions={FLOW_OPTIONS}>
      <Stack.Screen name="from" options={FROM_OPTIONS} />
      <Stack.Screen name="to" options={TO_OPTIONS} />
      <Stack.Screen name="start" options={START_OPTIONS} />
      <Stack.Screen name="confirm" options={CONFIRM_OPTIONS} />
    </Stack>
  );
  invariant(isValidElement(stack) && stack.type === Stack, 'the add-trip flow is a native Stack');
  return stack;
}
