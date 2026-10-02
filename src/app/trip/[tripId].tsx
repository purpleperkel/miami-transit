import { useLocalSearchParams } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { TripScreen } from '@/ui/trips/TripScreen';

/**
 * /trip/[tripId] — a saved trip (M7.9): its countdown card, route options from its station (ruling R6),
 * directions to the station, and delete. Pushed over the tabs (root _layout.tsx: TRIP_OPTIONS) from a
 * trip card or the Now strip.
 */
export default function TripRoute() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  invariant(typeof tripId === 'string' && tripId.length > 0, 'the trip screen is opened for a trip');
  const screen = <TripScreen tripId={tripId} />;
  invariant(isValidElement(screen) && screen.type === TripScreen, 'the route renders the trip screen');
  return screen;
}
