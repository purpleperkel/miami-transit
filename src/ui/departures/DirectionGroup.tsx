import { useMemo } from 'react';
import { PlatformColor, StyleSheet, View } from 'react-native';

import type { TimeWindow } from '@/domain/gtfs/service-day';
import type { LiveBatch, LivePrediction } from '@/domain/live/types';
import type { Departure } from '@/domain/schedule/departures';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { FreshnessIndicator } from '../primitives/FreshnessIndicator';
import { TText } from '../primitives/TText';
import { RADIUS, SPACING } from '../tokens';
import { directionBoard } from './direction-board';
import { DepartureRow } from './DepartureRow';

export type DirectionGroupProps = {
  /** The direction's heading, e.g. "To Dadeland South". */
  readonly title: string;
  /** This direction's scheduled departures (M3.3), earliest first. */
  readonly departures: readonly Departure[];
  /** The station's latest live predictions batch (live-context), or null when there is none. */
  readonly predictions: LiveBatch<LivePrediction> | null;
  /** The window the departures were fetched for; start it before now so a late train still matches its timetable slot. */
  readonly window: TimeWindow;
  /** Now (epoch s). */
  readonly nowS: number;
  /** The most rows the group shows. */
  readonly maxRows: number;
};

/**
 * One direction of a station's departure board (plan M6.3), with live predictions merged in through
 * m4a's merge (direction-board.ts → src/domain/live/merge-departures.ts): a prediction replaces the
 * scheduled time, a cancellation is struck through, and a live-only train gets its own row. It shows
 * at most `maxRows` rows still to leave.
 *
 * Where the times come from is said ONCE when they agree — the header's freshness ("Live",
 * "Live · 2 min old" or "Scheduled") — and per row only when live and scheduled rows mix; the header
 * then names both sources, so every row icon has its word on screen (§4: icon plus word).
 */
export function DirectionGroup({ title, departures, predictions, window, nowS, maxRows }: DirectionGroupProps) {
  invariant(title.trim().length > 0, 'a direction group has a heading');
  const board = useMemo(() => directionBoard({ departures, predictions, window, nowS, maxRows }), [departures, predictions, window, nowS, maxRows]);
  invariant(board.rows.length <= maxRows, `the group shows at most ${maxRows} rows`);
  return (
    <View testID="direction-group" style={styles.group}>
      <View style={styles.header}>
        <TText variant="headline" accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {title}
        </TText>
        {board.sources.map((freshness) => (
          <FreshnessIndicator key={freshness.kind} testID={`direction-freshness-${freshness.kind}`} freshness={freshness} />
        ))}
      </View>
      {board.rows.length === 0 ? (
        <TText variant="subhead" tone="secondary">
          {copy.noDepartures}
        </TText>
      ) : (
        board.rows.map(({ row, depS }) => <DepartureRow key={row.key} row={row} depS={depS} nowS={nowS} showSource={board.mixed} />)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: PlatformColor('secondarySystemGroupedBackground'),
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.xxs,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  title: { flex: 1 },
});
