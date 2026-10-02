import { useNavigation } from 'expo-router';
import { useMemo } from 'react';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { StationListing } from '@/data/schedule-queries';
import type { ScheduleRepo } from '@/data/schedule-repo';
import { orderStations } from '@/domain/stations/order-stations';
import type { ExclusionReason } from '@/domain/trips/reachable';
import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { copy } from '../../copy';
import { useUserPosition } from '../../map/use-user-location';
import { EmptyState } from '../../primitives/EmptyState';
import { TText } from '../../primitives/TText';
import { openPlanSheet } from '../../sheets';
import { tripWords } from '../trip-copy';
import { goToDestination, goToWalk } from './add-trip';
import { type PickerRow, StationPicker } from './StationPicker';

/**
 * The add-trip flow's first two steps (M7.9): the station the trip leaves from, then where it goes. The
 * destinations are the schedule's directReachable(origin) — stations ONE vehicle reaches (a saved trip
 * counts down to one ride); every other station stays listed, dimmed, with why: it needs a transfer, which
 * is route options' job (M10).
 *
 * mfix7 (Jamie's 07:10 recording): "Leaving from" lists the nearest stations first once the app's ONE
 * location provider has a fix (m6b's orderStations — the Stations tab's ordering), else the schedule's
 * order; "Going to" lists every reachable destination first and gathers the rest in ONE trailing
 * "Needs a transfer" group, which offers route options from the origin.
 */

/** The words for why a destination is excluded. */
const EXCLUDED_BECAUSE: Readonly<Record<ExclusionReason, string>> = {
  'needs-transfer': 'Needs a transfer, so no single train goes there. Route options can plan it.',
};

/** The schedule is opening, or failed: the step says so instead of listing nothing. */
export function ScheduleWait({ db }: { readonly db: Exclude<ScheduleDbState, { readonly kind: 'ready' }> }) {
  invariant(db.kind === 'opening' || db.kind === 'failed', 'only a schedule that is not ready is waited for');
  invariant(copy.scheduleOpening.length > 0, 'the wait has words');
  return db.kind === 'failed' ? (
    <EmptyState testID="add-trip-wait" title={copy.sheetUnavailable} message={db.message} />
  ) : (
    <EmptyState testID="add-trip-wait" title={copy.scheduleOpening} message={copy.sheetOpeningMessage} />
  );
}

/** Step 1: every station, to leave from — nearest first when the rider's position is known. */
export function FromStep() {
  const db = useScheduleDb();
  const { coordinate } = useUserPosition();
  const rows = useMemo(() => (db.kind === 'ready' ? originRows(db.repo.stations(), coordinate) : null), [db, coordinate]);
  invariant(typeof goToDestination === 'function', 'a pick moves the flow on');
  if (db.kind !== 'ready') {
    return <ScheduleWait db={db} />;
  }
  invariant(rows !== null && rows.length > 1, 'an open schedule lists every station to leave from');
  return <StationPicker testID="add-trip-from" prompt="Which station does the trip leave from?" rows={rows} onPick={goToDestination} />;
}

/** The origin rows: every station, nearest first with its distance at `location` (m6b's orderStations), else in the schedule's order. */
export function originRows(stations: readonly StationListing[], location: LatLon | null): PickerRow[] {
  invariant(stations.length > 1, 'a trip needs two stations to choose from');
  const located = stations.map((station) => ({ ...station.coordinate, station }));
  const ordered = orderStations(located, location);
  const rows = ordered.map(({ station: { station }, walkingMeters }) => ({ station, excludedBecause: null, walkingMeters }));
  invariant(rows.length === stations.length && rows.every((row) => (row.walkingMeters === null) === (location === null)), 'every station once, with a distance exactly when located');
  return rows;
}

/**
 * The destination rows from `from`: every other station, the ones one vehicle reaches first (pickable, in the
 * schedule's order), then every other one with why. Null for an unknown origin.
 */
export function destinationRows(repo: Pick<ScheduleRepo, 'directReachable' | 'stations'>, from: string): PickerRow[] | null {
  invariant(from.includes(':'), `a trip leaves from a station keyed mode:name, got "${from}"`);
  const reach = repo.directReachable(from);
  if (!reach.ok) {
    return null;
  }
  const excluded = new Map(reach.value.excluded.map((e) => [e.station.stationKey, EXCLUDED_BECAUSE[e.reason]] as const));
  const all = repo.stations().filter((station) => station.stationKey !== from).map((station) => ({ station, excludedBecause: excluded.get(station.stationKey) ?? null, walkingMeters: null }));
  const rows = [...all.filter((row) => row.excludedBecause === null), ...all.filter((row) => row.excludedBecause !== null)];
  invariant(rows.filter((row) => row.excludedBecause === null).length === reach.value.direct.length, 'the pickable rows are the direct destinations');
  return rows;
}

/** Step 2: where the trip goes from `from`. */
export function ToStep({ from }: { readonly from: string }) {
  const db = useScheduleDb();
  const rows = useMemo(() => (db.kind === 'ready' ? destinationRows(db.repo, from) : null), [db, from]);
  invariant(from.includes(':'), 'the flow knows its origin');
  invariant(rows === null || rows.length > 0, 'every other station is listed');
  if (db.kind !== 'ready') {
    return <ScheduleWait db={db} />;
  }
  if (rows === null) {
    return <EmptyState testID="add-trip-unknown" title={copy.unknownStation} message={copy.unknownStationMessage} />;
  }
  const name = db.repo.stations().find((station) => station.stationKey === from)?.name ?? from;
  return <StationPicker testID="add-trip-to" prompt={`Where does the trip go from ${name}?`} rows={rows} onPick={(to) => goToWalk(from, to)} onRouteOptions={() => openPlanSheet({ fromStation: from })} />;
}

/** The header's Cancel (every step): closes the whole add-trip modal, saving nothing. */
export function CancelAddTrip() {
  const navigation = useNavigation();
  invariant(typeof navigation.getParent === 'function', 'a step sits in the flow\'s Stack');
  invariant(tripWords.cancel.length > 0, 'Cancel has words');
  return (
    <Pressable testID="add-trip-cancel" accessibilityRole="button" accessibilityHint="Closes the new trip without saving it" hitSlop={8} onPress={() => navigation.getParent()?.goBack()}>
      <TText variant="body" style={styles.cancel}>
        {tripWords.cancel}
      </TText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cancel: { color: PlatformColor('link') },
});
