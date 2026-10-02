import { useLocalSearchParams } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { PlanScreen } from '@/ui/routes/PlanScreen';

/**
 * /plan — the route options sheet (plan M10b): a native formSheet titled "Route options" (root
 * _layout.tsx: PLAN_OPTIONS), opened by the map's Directions button, the station sheet's "Route from
 * here" (with `fromStation`) and the Trips tab's "Plan a route". Its itinerary detail opens inside it.
 */
export default function PlanRoute() {
  const { fromStation } = useLocalSearchParams<{ fromStation?: string }>();
  invariant(fromStation === undefined || (typeof fromStation === 'string' && fromStation.includes(':')), `a plan starts at the rider's location or at a station, got "${String(fromStation)}"`);
  const screen = <PlanScreen fromStation={fromStation ?? null} />;
  invariant(isValidElement(screen) && screen.type === PlanScreen, 'the route renders the route options sheet');
  return screen;
}
