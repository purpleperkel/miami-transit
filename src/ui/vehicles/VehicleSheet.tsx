import { SymbolView } from 'expo-symbols';
import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { PlatformColor, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { type ScheduleDbState, useScheduleDb } from '@/data/schedule-db-provider';
import type { NextStopsOutcome } from '@/data/schedule-repo';
import { MAX_NEXT_STOPS, type NextStop } from '@/domain/schedule/next-stops';
import { invariant } from '@/lib/invariant';

import { vehicleName } from '../a11y';
import { useNowS, wallClockNowS } from '../clock';
import { copy } from '../copy';
import { useFollow } from '../map/follow';
import { LineBadge } from '../primitives/LineBadge';
import { minutesText } from '../primitives/MinutesLabel';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';

/**
 * The vehicle sheet (plan M6.6), a native formSheet over the map: which line the vehicle runs and
 * where its trip ends, its next stops by the timetable (ScheduleRepo.nextStops: at most three, in time
 * order, continuing onto the trip a Metromover car runs next), and the Follow button — follow mode
 * keeps the map's camera on this vehicle until the rider moves the map (src/ui/map/follow.ts, the one
 * store the map shares). A live vehicle the timetable does not know (`live:` key) has no stops to show,
 * but can still be followed.
 *
 *   VehicleSheet (schedule DB, clock, follow store) → VehicleSheetView (props only, rendered in tests)
 */

/** The stops' minute counts move with this tick. */
export const VEHICLE_TICK_MS = 15_000;
const FOLLOW_ICON_PT = 17;
/** The merge's key for a live vehicle the timetable does not know (merge.ts rule 4). */
const LIVE_ONLY_PREFIX = 'live:';

export type VehicleSheetProps = {
  readonly vehicleKey: string;
  /** Now, in whole epoch seconds (tests pin it; the wall clock by default). */
  readonly clock?: () => number;
};

export function VehicleSheet({ vehicleKey, clock = wallClockNowS }: VehicleSheetProps) {
  const db = useScheduleDb();
  const nowS = useNowS(VEHICLE_TICK_MS, clock);
  const outcome = useMemo(() => vehicleOutcome(db, vehicleKey, nowS), [db, vehicleKey, nowS]);
  const { followedKey, follow, stop } = useFollow();
  const following = followedKey === vehicleKey;
  invariant(outcome === null || !('vehicleKey' in outcome) || outcome.vehicleKey === vehicleKey, 'the sheet shows the vehicle asked for');
  invariant(typeof follow === 'function' && typeof stop === 'function', 'the sheet can change follow mode');
  return (
    <>
      {outcome !== null && outcome.kind === 'next-stops' ? <Stack.Title>{vehicleName(outcome.lineId)}</Stack.Title> : null}
      <VehicleSheetView outcome={outcome} nowS={nowS} following={following} onToggleFollow={() => (following ? stop() : follow(vehicleKey))} />
    </>
  );
}

/** What the sheet shows: the timetable's next stops, a live-only vehicle, or null while the DB opens. */
export type VehicleOutcome = NextStopsOutcome | { readonly kind: 'live-only' };

/** The vehicle's outcome at `nowS` once the schedule DB is open; a live-only key never reaches the timetable. */
export function vehicleOutcome(db: ScheduleDbState, vehicleKey: string, nowS: number): VehicleOutcome | null {
  invariant(vehicleKey.length > 0, 'a sheet belongs to a vehicle');
  invariant(Number.isSafeInteger(nowS), 'a vehicle is placed at a whole second');
  if (vehicleKey.startsWith(LIVE_ONLY_PREFIX)) {
    return { kind: 'live-only' };
  }
  return db.kind === 'ready' ? db.repo.nextStops(vehicleKey, nowS) : null;
}

export type VehicleSheetViewProps = {
  readonly outcome: VehicleOutcome | null;
  readonly nowS: number;
  readonly following: boolean;
  readonly onToggleFollow: () => void;
};

export function VehicleSheetView({ outcome, nowS, following, onToggleFollow }: VehicleSheetViewProps) {
  invariant(Number.isFinite(nowS), 'the sheet is drawn at an instant');
  invariant(typeof onToggleFollow === 'function', 'the Follow button does something');
  return (
    <ScrollView testID="vehicle-sheet" contentInsetAdjustmentBehavior="automatic" style={styles.sheet} contentContainerStyle={styles.content}>
      {outcome !== null && outcome.kind === 'next-stops' ? <NextStops outcome={outcome} nowS={nowS} /> : <Unplaced outcome={outcome} />}
      <Pressable
        testID="vehicle-follow"
        accessibilityRole="button"
        accessibilityLabel={following ? copy.following : copy.follow}
        accessibilityHint={copy.followHint}
        accessibilityState={{ selected: following }}
        onPress={onToggleFollow}
        style={({ pressed }) => [styles.follow, following ? styles.followOn : null, pressed ? styles.pressed : null]}>
        <SymbolView name={following ? 'location.fill' : 'location'} size={FOLLOW_ICON_PT} tintColor={PlatformColor(following ? 'systemBlue' : 'label')} />
        <TText variant="headline" style={following ? styles.followOnText : null}>
          {following ? copy.following : copy.follow}
        </TText>
      </Pressable>
    </ScrollView>
  );
}

/** The line, where the trip ends, and the next stops with their scheduled minutes. */
function NextStops({ outcome, nowS }: { readonly outcome: Extract<VehicleOutcome, { kind: 'next-stops' }>; readonly nowS: number }) {
  invariant(outcome.stops.length <= MAX_NEXT_STOPS, `the sheet lists at most ${MAX_NEXT_STOPS} stops`);
  invariant(outcome.destination.length > 0, 'a trip ends somewhere');
  return (
    <View style={styles.block}>
      <View style={styles.line}>
        <LineBadge lineId={outcome.lineId} />
        <TText variant="headline" numberOfLines={1} style={styles.destination}>
          {copy.toward([outcome.destination])}
        </TText>
      </View>
      <TText variant="footnote" tone="secondary">
        {`${copy.nextStops} · ${copy.scheduledTimes}`}
      </TText>
      {outcome.stops.map((stop) => (
        <StopLine key={`${stop.tripIdx}:${stop.stationKey}`} stop={stop} nowS={nowS} />
      ))}
    </View>
  );
}

function StopLine({ stop, nowS }: { readonly stop: NextStop; readonly nowS: number }) {
  const when = minutesText({ epoch: stop.epoch, nowS, depS: stop.arrS });
  invariant(stop.name.length > 0, 'a stop is at a named station');
  invariant(when.length > 0, 'a stop says when the vehicle gets there');
  return (
    <View testID={`vehicle-stop-${stop.stationKey}`} accessible accessibilityLabel={`${stop.name}, ${when}`} style={styles.stop}>
      <TText variant="body" numberOfLines={1} style={styles.destination}>
        {stop.name}
      </TText>
      <TText variant="body" tone="secondary" style={styles.when}>
        {when}
      </TText>
    </View>
  );
}

/** The sheet's words for each reason it has no stops to list. */
const UNPLACED_TEXT: Readonly<Record<Exclude<VehicleOutcome, { kind: 'next-stops' }>['kind'], string>> = {
  'live-only': copy.notInTimetable,
  'not-running': copy.notRunning,
  expired: copy.timetableExpired,
  'not-started': copy.timetableNotStarted,
};

/** Why there are no stops to list: still opening, not running now, not in the timetable, or no timetable for now. */
function Unplaced({ outcome }: { readonly outcome: Exclude<VehicleOutcome, { kind: 'next-stops' }> | null }) {
  const text = outcome === null ? copy.scheduleOpening : UNPLACED_TEXT[outcome.kind];
  invariant(text.length > 0, 'the sheet says why it lists no stops');
  invariant(outcome === null || outcome.kind in UNPLACED_TEXT, `"${outcome?.kind}" is a reason the sheet can say`);
  return (
    <TText testID="vehicle-unplaced" variant="subhead" tone="secondary">
      {text}
    </TText>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  block: { gap: SPACING.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  destination: { flex: 1 },
  stop: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.xs, minHeight: 32 },
  when: { fontVariant: ['tabular-nums'] },
  follow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    minHeight: 44,
    borderRadius: RADIUS.md,
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
  },
  followOn: { borderWidth: 2, borderColor: PlatformColor('systemBlue') },
  followOnText: { color: PlatformColor('systemBlue') },
  pressed: { opacity: 0.6 },
});
