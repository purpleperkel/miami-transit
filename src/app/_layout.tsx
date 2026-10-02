import { Stack } from 'expo-router';
import { isValidElement } from 'react';

import { ScheduleDbProvider } from '@/data/schedule-db-provider';
import { UserDbProvider } from '@/data/user-db-provider';
import { invariant } from '@/lib/invariant';
import { LiveDataProvider } from '@/live/live-context';
import { ReminderSync } from '@/ui/trips/ReminderSync';

// The map is the app: the tab shell renders full-bleed under the root stack, with no header bar.
// Every screen pushed above the tabs shows a native header whose back button would read the screen
// beneath's title — for the tab shell, its route name "(tabs)" (seen on the phone at M1.19). So the
// stack's default back label is a real word, whichever tab the screen was opened from; a screen
// pushed from another pushed screen names that screen instead.
const ROOT_SCREEN_OPTIONS = { headerShown: false, headerBackTitle: 'Back' } as const;
// A saved trip (M7.9) opens as a pushed screen with its own header; its native title is the trip's name
// (TripScreen sets it), "Trip" only while the trips open.
const TRIP_OPTIONS = { headerShown: true, title: 'Trip' } as const;
// The add-trip flow (M7.9) is a modal of its own: its steps are a nested Stack (trip/new/_layout.tsx) that
// draws their headers, so this screen draws none.
const ADD_TRIP_OPTIONS = { presentation: 'modal' } as const;
// Directions (M7.6) is a short formSheet: Apple Maps by transit or on foot, to the place it was opened for.
const DIRECTIONS_OPTIONS = {
  headerShown: true,
  title: 'Directions',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.4, 0.7] as number[],
  sheetGrabberVisible: true,
} as const;
const DATA_TITLE = 'Data & Settings';
// Data & Settings (M8b.1) is opened from any tab (the accessory); its back button shows only its chevron.
const DATA_OPTIONS = { headerShown: true, title: DATA_TITLE, headerBackButtonDisplayMode: 'minimal' } as const;
// Diagnostics is reached from Data & Settings (one tap further), so its back button names it.
const DIAGNOSTICS_OPTIONS = { headerShown: true, title: 'Diagnostics', headerBackTitle: DATA_TITLE } as const;
// Layers (M5.12) is a native formSheet over the map (§4 Sheets): half height, pulled up to full, with a
// grabber; the map under it stays bright at half height, so each switch is seen to change it.
const LAYERS_OPTIONS = {
  headerShown: true,
  title: 'Layers',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.5, 1] as number[],
  sheetGrabberVisible: true,
  sheetLargestUndimmedDetentIndex: 0,
} as const;
// The station sheet (M6.4) opens at half height over the map, which stays bright and usable under it
// (M6.7), and pulls up to full height. Its native title is the station's name (StationSheet sets it);
// "Station" shows only while the schedule opens.
const STATION_SHEET_OPTIONS = {
  headerShown: true,
  title: 'Station',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.5, 1] as number[],
  sheetGrabberVisible: true,
  sheetLargestUndimmedDetentIndex: 0,
} as const;
// The vehicle sheet (M6.6) rests low, so a followed vehicle stays in view in the middle of the map
// above it; it pulls up for its stops. Its native title is the vehicle's line (VehicleSheet sets it).
const VEHICLE_SHEET_OPTIONS = {
  headerShown: true,
  title: 'Vehicle',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.35, 0.7] as number[],
  sheetGrabberVisible: true,
  sheetLargestUndimmedDetentIndex: 0,
} as const;
// The route options sheet (M10b) rises over the map, the station sheet or the Trips tab; it opens tall,
// since it holds a search field and a list, and its title is fixed: the options and their legs show inside.
const PLAN_OPTIONS = {
  headerShown: true,
  title: 'Route options',
  presentation: 'formSheet',
  sheetAllowedDetents: [0.75, 1] as number[],
  sheetGrabberVisible: true,
} as const;

/**
 * The root: the bundled schedule DB (M3.8) and the user DB (saved trips, M7.3) are opened once, here,
 * for every screen; the live runtime (M4.9) runs over the schedule — polling only while the app is
 * active — and the reminder sync (M7.5) keeps the phone's "leave now" reminders in step with the trips.
 */
export default function RootLayout() {
  invariant(Stack.Screen !== undefined, 'expo-router provides the Stack navigator and its screens');
  const root = (
    <ScheduleDbProvider>
      <UserDbProvider>
        <LiveDataProvider>
          <ReminderSync />
          <Stack screenOptions={ROOT_SCREEN_OPTIONS}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="trip/[tripId]" options={TRIP_OPTIONS} />
            <Stack.Screen name="trip/new" options={ADD_TRIP_OPTIONS} />
            <Stack.Screen name="directions" options={DIRECTIONS_OPTIONS} />
            <Stack.Screen name="data" options={DATA_OPTIONS} />
            <Stack.Screen name="diagnostics" options={DIAGNOSTICS_OPTIONS} />
            <Stack.Screen name="layers" options={LAYERS_OPTIONS} />
            <Stack.Screen name="station/[stationKey]" options={STATION_SHEET_OPTIONS} />
            <Stack.Screen name="vehicle/[vehicleKey]" options={VEHICLE_SHEET_OPTIONS} />
            <Stack.Screen name="plan" options={PLAN_OPTIONS} />
          </Stack>
        </LiveDataProvider>
      </UserDbProvider>
    </ScheduleDbProvider>
  );
  invariant(isValidElement(root) && root.type === ScheduleDbProvider, 'RootLayout renders the schedule DB provider around the root Stack');
  return root;
}
