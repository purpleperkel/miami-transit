import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { TripsScreen } from '@/ui/trips/TripsScreen';

/** The Trips tab (M5.5): saved trips with their leave-by countdown (M7); for now, its empty state. */
export default function TripsRoute() {
  invariant(typeof TripsScreen === 'function', 'the Trips screen component exists');
  const screen = <TripsScreen />;
  invariant(isValidElement(screen) && screen.type === TripsScreen, 'the route renders the Trips screen');
  return screen;
}
