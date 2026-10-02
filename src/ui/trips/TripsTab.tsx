import { useCallback, useMemo } from 'react';
import { PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import type { SavedTrip } from '@/data/saved-trips-repo';
import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { TripSettings } from '@/data/settings-repo';
import { useUserDb } from '@/data/user-db-provider';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { useNowS, wallClockNowS } from '../clock';
import { copy } from '../copy';
import { useUserPosition } from '../map/use-user-location';
import { ActionButton } from '../primitives/ActionButton';
import { EmptyState } from '../primitives/EmptyState';
import { TText } from '../primitives/TText';
import { readWalkingPace } from '../settings/walking-pace';
import { openPlanSheet } from '../sheets';
import { RADIUS, SPACING } from '../tokens';
import { useReminderStatus } from './reminder-status';
import { type TripCardModel, tripCards } from './trip-card';
import { tripWords } from './trip-copy';
import { openTrip, startAddTrip } from './trip-routes';
import { TripCard } from './TripCard';
import { TripsScreen } from './TripsScreen';

/**
 * The Trips tab (plan M7.8): with trips saved, one TripCard per trip, sorted by leave-by (soonest first),
 * each counting down to the ride it should take, and "Add a trip" / "Plan a route" under them. With no
 * trip saved (or outside the user DB's provider) it is the tab's empty state, TripsScreen ("No trips yet"),
 * with its own actions — and nothing else runs: no location watch, no clock.
 *
 *   TripsTab (user DB) → SavedTrips (schedule DB, position, pace, clock) → TripsView (props only, rendered in tests)
 */

/** The countdowns move with this tick ("Leave now" is cued within a few seconds of its moment). */
export const TRIPS_TICK_MS = 5_000;

export type TripsViewState =
  /** The user DB would not open: why. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Trips are saved, but the schedule is opening (or failed): they are named, the countdowns wait. */
  | { readonly kind: 'waiting'; readonly trips: readonly SavedTrip[]; readonly message: string }
  | { readonly kind: 'cards'; readonly cards: readonly TripCardModel[]; readonly nowS: number };

export type TripsTabProps = {
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

export function TripsTab({ clock = wallClockNowS }: TripsTabProps) {
  const user = useUserDb();
  invariant(typeof TripsScreen === 'function', 'the empty state exists');
  if (user.kind === 'failed') {
    return <TripsView state={{ kind: 'failed', message: user.message }} reminderProblem={null} />;
  }
  if (user.kind === 'closed' || user.trips.length === 0) {
    return <TripsScreen />;
  }
  invariant(user.trips.length > 0, 'the list is for saved trips');
  return <SavedTrips trips={user.trips} settings={user.settings} clock={clock} />;
}

type SavedTripsProps = { readonly trips: readonly SavedTrip[]; readonly settings: TripSettings; readonly clock: () => number };

/** The saved trips' cards, live: re-read every tick, every new fix and when the schedule opens. */
function SavedTrips({ trips, settings, clock }: SavedTripsProps) {
  const schedule = useScheduleDb();
  const position = useUserPosition();
  const nowS = useNowS(TRIPS_TICK_MS, clock);
  const state = useMemo(() => tripsViewState({ trips, settings, schedule, position: position.coordinate, nowS }), [trips, settings, schedule, position.coordinate, nowS]);
  const reminderProblem = useReminderStatus();
  invariant(trips.length > 0, 'the list is for saved trips');
  invariant(reminderProblem === null || reminderProblem.length > 0, 'a reminder problem says why');
  return <TripsView state={state} reminderProblem={reminderProblem} />;
}

export type TripsInput = {
  readonly trips: readonly SavedTrip[];
  readonly settings: TripSettings;
  readonly schedule: ScheduleDbState;
  readonly position: LatLon | null;
  readonly nowS: number;
};

/** What the list shows for the saved trips, the schedule, the rider's position and the time. */
export function tripsViewState({ trips, settings, schedule, position, nowS }: TripsInput): TripsViewState {
  invariant(Number.isSafeInteger(nowS), 'the tab is read at a whole second');
  invariant(trips.length > 0, 'the list is for saved trips');
  if (schedule.kind !== 'ready') {
    return { kind: 'waiting', trips, message: schedule.kind === 'failed' ? schedule.message : copy.sheetOpeningMessage };
  }
  const { walkMps } = readWalkingPace();
  const cards = tripCards(schedule.repo, trips, { nowS, walkMps, bufferS: settings.boardBufferS, position });
  invariant(cards.length === trips.length, 'one card per saved trip');
  return { kind: 'cards', cards, nowS };
}

export type TripsViewProps = {
  readonly state: TripsViewState;
  /** Why the last reminder sync failed, or null. */
  readonly reminderProblem: string | null;
};

export function TripsView({ state, reminderProblem }: TripsViewProps) {
  invariant(typeof state.kind === 'string', 'the tab knows what to show');
  invariant(reminderProblem === null || reminderProblem.length > 0, 'a reminder problem says why');
  return (
    <ScrollView testID="trips-list" contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      {state.kind === 'failed' ? <EmptyState testID="trips-failed" title={tripWords.unavailable} message={state.message} /> : null}
      {state.kind === 'waiting' ? <Waiting trips={state.trips} message={state.message} /> : null}
      {state.kind === 'cards' ? state.cards.map((card) => <TripCard key={card.trip.id} card={card} nowS={state.nowS} onOpen={openTrip} />) : null}
      {reminderProblem === null ? null : (
        <TText testID="trips-reminder-problem" variant="footnote" style={styles.problem}>
          {reminderProblem}
        </TText>
      )}
      {state.kind === 'failed' ? null : <TripsActions />}
    </ScrollView>
  );
}

/** Saved trips named while the schedule opens (or after it failed, with why). */
function Waiting({ trips, message }: { readonly trips: readonly SavedTrip[]; readonly message: string }) {
  invariant(trips.length > 0, 'trips are saved');
  invariant(message.length > 0, 'the wait says why');
  return (
    <View testID="trips-waiting" style={styles.waiting}>
      {trips.map((trip) => (
        <TText key={trip.id} variant="headline">
          {trip.name}
        </TText>
      ))}
      <TText variant="subhead" tone="secondary">
        {message}
      </TText>
    </View>
  );
}

/** Under the cards: start a new trip, or plan a one-off route (M10b). */
function TripsActions() {
  const onPlan = useCallback(() => openPlanSheet(), []);
  invariant(typeof startAddTrip === 'function', 'the add-trip flow has a door');
  invariant(typeof onPlan === 'function', 'route options have a door');
  return (
    <View style={styles.actions}>
      <ActionButton testID="trips-add" symbol="plus" label={tripWords.addTrip} hint={tripWords.addTripHint} onPress={startAddTrip} />
      <ActionButton testID="trips-plan-route" symbol="arrow.triangle.turn.up.right.diamond" label={copy.planRoute} hint={copy.planRouteHint} onPress={onPlan} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  waiting: { gap: SPACING.xs, padding: SPACING.md, borderRadius: RADIUS.lg, backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACING.xs },
  problem: { color: PlatformColor('systemRed') },
});
