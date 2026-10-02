import { router, Stack } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import type { SavedTrip } from '@/data/saved-trips-repo';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { TripSettings } from '@/data/settings-repo';
import { useUserDb } from '@/data/user-db-provider';
import { invariant } from '@/lib/invariant';

import { useNowS, wallClockNowS } from '../clock';
import { useUserPosition } from '../map/use-user-location';
import { ActionButton } from '../primitives/ActionButton';
import { EmptyState } from '../primitives/EmptyState';
import { TText } from '../primitives/TText';
import { openPlanSheet } from '../sheets';
import { SPACING } from '../tokens';
import { tripWords } from './trip-copy';
import { openDirections } from './trip-routes';
import { TripCard } from './TripCard';
import { TRIPS_TICK_MS, tripsViewState } from './TripsTab';

/**
 * A saved trip's own screen (M7.9, src/app/trip/[tripId].tsx): its card — the countdown, or why there is
 * none — and what to do next: route options from its station (ruling R6: m10b's sheet, the way on when
 * the trip has no direct ride now), Apple Maps directions to the station it leaves from (M7.6), or
 * deleting it (its reminders go with it at the next sync). The native title is the trip's name.
 */
export function TripScreen({ tripId, clock = wallClockNowS }: { readonly tripId: string; readonly clock?: () => number }) {
  const user = useUserDb();
  invariant(tripId.length > 0, 'a trip screen is for a trip');
  const trip = user.kind === 'ready' ? (user.trips.find((t) => t.id === tripId) ?? null) : null;
  if (user.kind !== 'ready' || trip === null) {
    const message = user.kind === 'failed' ? user.message : 'This trip is not saved (it may have been deleted).';
    return <EmptyState testID="trip-missing" title={tripWords.unavailable} message={message} />;
  }
  invariant(trip.id === tripId, 'the screen shows the trip asked for');
  return (
    <>
      <Stack.Title>{trip.name}</Stack.Title>
      <TripDetail trip={trip} settings={user.settings} remove={user.book.remove} clock={clock} />
    </>
  );
}

export type TripDetailProps = { readonly trip: SavedTrip; readonly settings: TripSettings; readonly remove: (tripId: string) => boolean; readonly clock: () => number };

/** The trip's card and actions (no navigator needed: the screen above sets the title). */
export function TripDetail({ trip, settings, remove, clock }: TripDetailProps) {
  const schedule = useScheduleDb();
  const position = useUserPosition();
  const nowS = useNowS(TRIPS_TICK_MS, clock);
  const state = useMemo(() => tripsViewState({ trips: [trip], settings, schedule, position: position.coordinate, nowS }), [trip, settings, schedule, position.coordinate, nowS]);
  const station = schedule.kind === 'ready' ? schedule.repo.stations().find((s) => s.stationKey === trip.fromStationKey) : undefined;
  const onRoute = useCallback(() => openPlanSheet({ fromStation: trip.fromStationKey }), [trip.fromStationKey]);
  const onDelete = useCallback(() => (remove(trip.id) ? router.back() : undefined), [remove, trip.id]);
  invariant(state.kind !== 'cards' || state.cards.length === 1, 'the screen shows one card');
  invariant(trip.fromStationKey.includes(':'), 'route options start at the trip\'s station');
  return (
    <ScrollView testID="trip-screen" contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      {state.kind === 'cards' && state.cards[0] !== undefined ? <TripCard card={state.cards[0]} nowS={state.nowS} /> : null}
      {state.kind === 'waiting' ? (
        <TText variant="subhead" tone="secondary">
          {state.message}
        </TText>
      ) : null}
      <View style={styles.actions}>
        <ActionButton testID="trip-route-options" symbol="arrow.triangle.turn.up.right.diamond" label={tripWords.routeOptions} hint={tripWords.routeOptionsHint} onPress={onRoute} />
        {station === undefined ? null : (
          <ActionButton testID="trip-directions" symbol="map" label={tripWords.directions} hint={tripWords.directionsHint} onPress={() => openDirections({ name: station.name, ...station.coordinate })} />
        )}
        <ActionButton testID="trip-delete" symbol="trash" label={tripWords.deleteTrip} hint={tripWords.deleteTripHint} onPress={onDelete} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
});
