import { useLocalSearchParams } from 'expo-router';
import { isValidElement } from 'react';

import { invariant } from '@/lib/invariant';
import { StationSheet } from '@/ui/stations/StationSheet';

/**
 * /station/[stationKey] — the station sheet (plan M6.4): a native formSheet over the map or the
 * Stations list (root _layout.tsx: STATION_SHEET_OPTIONS), opened by a station marker or a list row.
 */
export default function StationSheetRoute() {
  const { stationKey } = useLocalSearchParams<{ stationKey: string }>();
  invariant(typeof stationKey === 'string' && stationKey.length > 0, 'the station sheet is opened for a station');
  const sheet = <StationSheet stationKey={stationKey} />;
  invariant(isValidElement(sheet) && sheet.type === StationSheet, 'the route renders the station sheet');
  return sheet;
}
