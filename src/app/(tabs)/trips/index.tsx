import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { TripsTab } from '@/ui/trips/TripsTab';

/** The Trips tab (M5.5, M7.8): saved trips with their leave-by countdown, or the empty state (TripsScreen) before any is saved. */
export default function TripsRoute() {
  invariant(typeof TripsTab === 'function', 'the Trips tab component exists');
  const screen = <TripsTab />;
  invariant(isValidElement(screen) && screen.type === TripsTab, 'the route renders the Trips tab');
  return screen;
}
