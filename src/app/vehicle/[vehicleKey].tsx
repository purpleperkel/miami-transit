import { useLocalSearchParams } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { VehicleSheet } from '@/ui/vehicles/VehicleSheet';

/**
 * /vehicle/[vehicleKey] — the vehicle sheet (plan M6.6): a native formSheet over the map (root
 * _layout.tsx: VEHICLE_SHEET_OPTIONS), opened by a vehicle marker; its Follow button shares the map's
 * follow store (src/ui/map/follow.ts).
 */
export default function VehicleSheetRoute() {
  const { vehicleKey } = useLocalSearchParams<{ vehicleKey: string }>();
  invariant(typeof vehicleKey === 'string' && vehicleKey.length > 0, 'the vehicle sheet is opened for a vehicle');
  const sheet = <VehicleSheet vehicleKey={vehicleKey} />;
  invariant(isValidElement(sheet) && sheet.type === VehicleSheet, 'the route renders the vehicle sheet');
  return sheet;
}
