import { useMemo } from 'react';
import { PlatformColor, ScrollView, StyleSheet, View } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import { orderStations } from '@/domain/stations/order-stations';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { useNowS, wallClockNowS } from '../clock';
import { copy } from '../copy';
import { type UserPosition, useUserPosition } from '../map/use-user-location';
import { EmptyState } from '../primitives/EmptyState';
import { TText } from '../primitives/TText';
import { openStationSheet } from '../sheets';
import { SPACING } from '../tokens';
import { type StationList, stationList, type StationSection } from './station-list';
import { StationRow } from './StationRow';

/**
 * The Stations tab (plan M6.5 + R7, refining M5.5's plain list): every station of the bundled schedule
 * in two sections, Metrorail then Metromover — nearest first with walking distances once the phone
 * knows where the rider is (orderStations), else in line order — and each row shows its next
 * SCHEDULED departure per direction inline. The list never touches the live layer (REALTIME COST
 * RULE: a row costs zero Transitland calls); tapping a row opens the station sheet, which does. The
 * title is the tab's native large-title header (stations/_layout.tsx), which the ScrollView insets under.
 *
 *   StationsScreen (schedule DB, clock, location) → StationsView (props only, rendered in tests)
 */

/** The list re-reads its next departures this often. */
export const LIST_REFRESH_MS = 30_000;

/** What the list can show: the schedule DB is still opening, failed to open, or the list. */
export type StationsState =
  | { readonly kind: 'opening' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly list: StationList };

export type StationsScreenProps = {
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

export function StationsScreen({ clock = wallClockNowS }: StationsScreenProps) {
  const db = useScheduleDb();
  const nowS = useNowS(LIST_REFRESH_MS, clock);
  const location = useUserPosition();
  const state = useMemo(() => stationsState(db, nowS), [db, nowS]);
  invariant(state.kind === db.kind, 'the list follows the schedule DB state');
  invariant(Number.isSafeInteger(nowS), 'the list is read at a whole second');
  return <StationsView state={state} nowS={nowS} location={location} onOpen={openStationSheet} />;
}

/** The list's state from the schedule DB's: an open DB gives the stations with their next departures at `nowS`. */
export function stationsState(db: ScheduleDbState, nowS: number): StationsState {
  invariant(db.kind === 'opening' || db.kind === 'ready' || db.kind === 'failed', 'the schedule DB state is known');
  const state: StationsState = db.kind === 'ready' ? { kind: 'ready', list: stationList(db.repo, nowS) } : db;
  invariant(state.kind === db.kind, 'the list follows the schedule DB state');
  return state;
}

export type StationsViewProps = {
  readonly state: StationsState;
  readonly nowS: number;
  readonly location: UserPosition;
  readonly onOpen: (stationKey: string) => void;
};

export function StationsView({ state, nowS, location, onOpen }: StationsViewProps) {
  invariant(state.kind === 'opening' || state.kind === 'ready' || state.kind === 'failed', 'the list state is known');
  invariant(state.kind !== 'failed' || state.message.length > 0, 'a failure says why');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      {state.kind === 'ready' ? (
        <>
          <ListNotes list={state.list} location={location} />
          {state.list.sections.map((section) => (
            <Section key={section.mode} section={section} location={location.coordinate} nowS={nowS} onOpen={onOpen} />
          ))}
        </>
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

/** One line above the list when it cannot do all it should: the timetable does not cover now, or location is off. */
function ListNotes({ list, location }: { readonly list: StationList; readonly location: UserPosition }) {
  invariant(list.sections.length > 0, 'the list has sections');
  invariant(location.coordinate === null || location.note === null, 'a located list has nothing to excuse');
  const gap = list.gap === null ? null : list.gap.kind === 'expired' ? copy.timetableExpired : copy.timetableNotStarted;
  const notes = [gap, location.note].filter((note): note is string => note !== null);
  return notes.length === 0 ? null : (
    <View testID="stations-notes">
      {notes.map((note) => (
        <TText key={note} variant="footnote" tone="secondary">
          {note}
        </TText>
      ))}
    </View>
  );
}

/** A section — Metrorail or Metromover — its rows nearest first when the rider's location is known. */
function Section({ section, location, nowS, onOpen }: { readonly section: StationSection; readonly location: LatLon | null; readonly nowS: number; readonly onOpen: (stationKey: string) => void }) {
  const ordered = orderStations(section.rows, location);
  invariant(ordered.length === section.rows.length, 'every station of the section is listed once');
  invariant(section.title.length > 0, 'a section has a heading');
  return (
    <View testID={`stations-section-${section.mode}`} style={styles.section}>
      <TText variant="headline" accessibilityRole="header">
        {section.title}
      </TText>
      <View style={styles.list}>
        {ordered.map(({ station, walkingMeters }) => (
          <StationRow key={station.stationKey} row={station} walkingMeters={walkingMeters} nowS={nowS} onPress={onOpen} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemBackground') },
  content: { padding: SPACING.md, gap: SPACING.lg },
  section: { gap: SPACING.xs },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: PlatformColor('separator') },
});
