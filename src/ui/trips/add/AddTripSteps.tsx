import { useNavigation } from 'expo-router';
import { useMemo } from 'react';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { ScheduleRepo } from '@/data/schedule-repo';
import type { ExclusionReason } from '@/domain/trips/reachable';
import { invariant } from '@/lib/invariant';

import { copy } from '../../copy';
import { EmptyState } from '../../primitives/EmptyState';
import { TText } from '../../primitives/TText';
import { tripWords } from '../trip-copy';
import { goToDestination, goToWalk } from './add-trip';
import { type PickerRow, StationPicker } from './StationPicker';

/**
 * The add-trip flow's first two steps (M7.9): the station the trip leaves from, then where it goes. The
 * destinations are the schedule's directReachable(origin) — stations ONE vehicle reaches (a saved trip
 * counts down to one ride); every other station stays listed, dimmed, with why: it needs a transfer, which
 * is route options' job (M10).
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

/** Step 1: every station, to leave from. */
export function FromStep() {
  const db = useScheduleDb();
  invariant(typeof goToDestination === 'function', 'a pick moves the flow on');
  if (db.kind !== 'ready') {
    return <ScheduleWait db={db} />;
  }
  const rows: PickerRow[] = db.repo.stations().map((station) => ({ station, excludedBecause: null }));
  invariant(rows.length > 1, 'a trip needs two stations to choose from');
  return <StationPicker testID="add-trip-from" prompt="Which station does the trip leave from?" rows={rows} onPick={goToDestination} />;
}

/** The destination rows from `from`: every other station, the ones one vehicle reaches pickable. Null for an unknown origin. */
export function destinationRows(repo: Pick<ScheduleRepo, 'directReachable' | 'stations'>, from: string): PickerRow[] | null {
  invariant(from.includes(':'), `a trip leaves from a station keyed mode:name, got "${from}"`);
  const reach = repo.directReachable(from);
  if (!reach.ok) {
    return null;
  }
  const excluded = new Map(reach.value.excluded.map((e) => [e.station.stationKey, EXCLUDED_BECAUSE[e.reason]] as const));
  const rows = repo.stations().filter((station) => station.stationKey !== from).map((station) => ({ station, excludedBecause: excluded.get(station.stationKey) ?? null }));
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
  return <StationPicker testID="add-trip-to" prompt={`Where does the trip go from ${name}?`} rows={rows} onPick={(to) => goToWalk(from, to)} />;
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
