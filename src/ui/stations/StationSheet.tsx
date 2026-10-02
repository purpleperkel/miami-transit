import { Stack } from 'expo-router';
import { type ReactNode, useMemo } from 'react';
import { PlatformColor, ScrollView, StyleSheet } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { LiveBatch, LivePrediction } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import { useNowS, wallClockNowS } from '../clock';
import { copy } from '../copy';
import { DirectionGroup } from '../departures/DirectionGroup';
import { EmptyState } from '../primitives/EmptyState';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { stationSheet, type StationSheetModel } from './station-sheet';
import { StationSheetFooter } from './StationSheetFooter';
import { StationSheetHeader } from './StationSheetHeader';
import { useStationPredictions } from './use-station-predictions';

/**
 * The station sheet (plan M6.4), a native formSheet over the map or the Stations list: the station's
 * name as the sheet's title, its lines and system (StationSheetHeader, with m7c's verdict slot), one
 * DirectionGroup per direction — the timetable with the station's live predictions merged in — and
 * the walk-directions footer. This open sheet is the ONLY place the app watches a station's live
 * predictions (use-station-predictions.ts).
 *
 *   StationSheet (schedule DB, live predictions, clock) → StationSheetView (props only, rendered in tests)
 */

/** The minute counts move with this tick; the departures window moves once a minute. */
export const SHEET_TICK_MS = 15_000;
/** Each direction shows at most this many departures. */
export const SHEET_MAX_ROWS = 4;

export type StationSheetProps = {
  readonly stationKey: string;
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
  /** m7c's hurry-or-chill verdict for this station, shown in the header's slot. */
  readonly verdict?: ReactNode;
};

export function StationSheet({ stationKey, clock = wallClockNowS, verdict }: StationSheetProps) {
  const db = useScheduleDb();
  const nowS = useNowS(SHEET_TICK_MS, clock);
  const minuteS = nowS - (nowS % 60);
  const model = useMemo(() => sheetModel(db, stationKey, minuteS), [db, stationKey, minuteS]);
  const predictions = useStationPredictions(stationKey);
  invariant(model === null || model.kind === 'unknown-station' || model.station.stationKey === stationKey, 'the sheet shows the station asked for');
  invariant(minuteS <= nowS, 'the window starts on the minute just begun');
  return (
    <>
      {model === null || model.kind === 'unknown-station' ? null : <Stack.Title>{model.station.name}</Stack.Title>}
      <StationSheetView db={db} model={model} predictions={predictions} nowS={nowS} verdict={verdict} />
    </>
  );
}

/** The sheet's model once the schedule DB is open; null while it opens (or failed). */
export function sheetModel(db: ScheduleDbState, stationKey: string, nowS: number): StationSheetModel | null {
  invariant(stationKey.length > 0, 'a sheet belongs to a station');
  invariant(Number.isSafeInteger(nowS), 'a sheet is read at a whole second');
  return db.kind === 'ready' ? stationSheet(db.repo, stationKey, nowS) : null;
}

/** What the view needs to know of the schedule DB: opening, open, or failed with why (ScheduleDbState fits). */
export type SheetDbStatus = { readonly kind: 'opening' } | { readonly kind: 'ready' } | { readonly kind: 'failed'; readonly message: string };

export type StationSheetViewProps = {
  readonly db: SheetDbStatus;
  readonly model: StationSheetModel | null;
  readonly predictions: LiveBatch<LivePrediction> | null;
  readonly nowS: number;
  readonly verdict?: ReactNode;
};

export function StationSheetView({ db, model, predictions, nowS, verdict }: StationSheetViewProps) {
  invariant((model === null) === (db.kind !== 'ready'), 'a model exists exactly when the schedule DB is open');
  invariant(Number.isFinite(nowS), 'the sheet is drawn at an instant');
  if (model === null || model.kind === 'unknown-station') {
    const title = model === null ? (db.kind === 'failed' ? copy.sheetUnavailable : copy.scheduleOpening) : copy.unknownStation;
    const message = db.kind === 'failed' ? db.message : model === null ? copy.sheetOpeningMessage : copy.unknownStationMessage;
    return <EmptyState testID="station-sheet-unavailable" title={title} message={message} />;
  }
  return (
    <ScrollView testID="station-sheet" contentInsetAdjustmentBehavior="automatic" style={styles.sheet} contentContainerStyle={styles.content}>
      <StationSheetHeader mode={model.station.mode} lines={model.lines} verdict={verdict} />
      {model.kind === 'gap' ? (
        <TText testID="station-sheet-gap" variant="subhead" tone="secondary">
          {model.gap.kind === 'expired' ? copy.timetableExpired : copy.timetableNotStarted}
        </TText>
      ) : (
        model.groups.map((group) => (
          <DirectionGroup key={group.directionId} title={group.title} departures={group.departures} predictions={predictions} window={model.window} nowS={nowS} maxRows={SHEET_MAX_ROWS} />
        ))
      )}
      <StationSheetFooter coordinate={model.station.coordinate} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
});
