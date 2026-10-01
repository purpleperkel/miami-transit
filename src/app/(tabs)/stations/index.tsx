import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { StationsScreen } from '@/ui/stations/StationsScreen';

/** The Stations tab (M5.5): every station in the bundled schedule DB, as a plain list (refined in M6.5). */
export default function StationsRoute() {
  invariant(typeof StationsScreen === 'function', 'the Stations screen component exists');
  const screen = <StationsScreen />;
  invariant(isValidElement(screen) && screen.type === StationsScreen, 'the route renders the Stations screen');
  return screen;
}
