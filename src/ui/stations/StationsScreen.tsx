import { useMemo } from 'react';
import { PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { StationListing } from '@/data/schedule-queries';
import { invariant } from '@/lib/invariant';

import { MODE_NAMES, stationLabel } from '../a11y';
import { EmptyState } from '../primitives/EmptyState';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';

/**
 * The Stations tab (plan M5.5): a plain list of every station in the bundled schedule DB, rail first,
 * each mode in name order — every station the map draws is also reachable here (plan §4
 * accessibility). M6.5 refines the rows (line strips, sections) and opens the station sheet. The title
 * is the tab's native large-title header (stations/_layout.tsx), which the ScrollView insets under.
 *
 *   StationsScreen (reads the schedule DB context) → StationsView (props only, rendered in tests)
 */

/** What the list can show: the schedule DB is still opening, failed to open, or its stations. */
export type StationsState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly stations: readonly StationListing[] };

export function StationsScreen() {
  const db = useScheduleDb();
  const state = useMemo(() => stationsState(db), [db]);
  invariant(state.kind === db.kind, 'the list follows the schedule DB state');
  invariant(state.kind !== 'ready' || state.stations.length > 0, 'an open schedule has stations');
  return <StationsView state={state} />;
}

/** The list's state from the schedule DB's: an open DB lists its stations (read once by the repo). */
export function stationsState(db: ScheduleDbState): StationsState {
  invariant(db.kind === 'opening' || db.kind === 'ready' || db.kind === 'failed', 'the schedule DB state is known');
  const state: StationsState = db.kind === 'ready' ? { kind: 'ready', stations: db.repo.stations() } : db;
  invariant(state.kind === db.kind, 'the list follows the schedule DB state');
  return state;
}

export function StationsView({ state }: { readonly state: StationsState }) {
  invariant(state.kind === 'opening' || state.kind === 'ready' || state.kind === 'failed', 'the list state is known');
  invariant(state.kind !== 'failed' || state.message.length > 0, 'a failure says why');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      {state.kind === 'ready' ? (
        <View style={styles.list}>
          {state.stations.map((station) => (
            <StationListRow key={station.stationKey} station={station} />
          ))}
        </View>
      ) : (
        <EmptyState
          testID="stations-unavailable"
          title={state.kind === 'opening' ? 'Opening the schedule' : 'Stations unavailable'}
          message={state.kind === 'opening' ? 'The station list appears in a moment.' : state.message}
        />
      )}
    </ScrollView>
  );
}

/** One station: its name, then which system it belongs to (two stations are named Government Center). */
function StationListRow({ station }: { readonly station: StationListing }) {
  const label = stationLabel(station);
  invariant(label.startsWith(station.name), 'the row reads its station name first');
  invariant(station.stationKey.length > 0, 'a row belongs to a station');
  return (
    <View testID={`station-row-${station.stationKey}`} accessible accessibilityLabel={label} style={styles.row}>
      <TText variant="body">{station.name}</TText>
      <TText variant="footnote" tone="secondary">
        {MODE_NAMES[station.mode]}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemBackground') },
  content: { padding: SPACING.md, gap: SPACING.sm },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: PlatformColor('separator') },
  row: {
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: PlatformColor('separator'),
  },
});
