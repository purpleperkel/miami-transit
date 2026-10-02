import { PlatformColor, Pressable, StyleSheet, View } from 'react-native';

import { lineById } from '@/domain/lines/line-catalog';
import { invariant } from '@/lib/invariant';

import { stationLabel } from '../a11y';
import { copy } from '../copy';
import { formatDistance } from '../format';
import { minutesText } from '../primitives/MinutesLabel';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { LineStrip } from './LineStrip';
import type { NextDeparture, StationRowModel } from './station-list';

export type StationRowProps = {
  readonly row: StationRowModel;
  /** Straight-line metres from the rider (orderStations), or null without a location. */
  readonly walkingMeters: number | null;
  /** Now (epoch s): the departures' minute counts run from it. */
  readonly nowS: number;
  /** Opens the station sheet. */
  readonly onPress: (stationKey: string) => void;
  /**
   * What the row's test ids start with: 'station-row' in its mode's section, 'nearby-row' in the Nearby section
   * (mfix7), where the same station is listed a second time and must not be counted twice.
   */
  readonly idPrefix?: StationRowIdPrefix;
};

export type StationRowIdPrefix = 'station-row' | 'nearby-row';

/**
 * One station in the Stations list (plan M6.5 + R7): its name and how far away it is, the lines that
 * stop there (LineStrip), and — inline — the next SCHEDULED departure in each direction, headsign and
 * time ("Dadeland South · 4 min"), straight from the bundled timetable. A row never asks for live
 * predictions; tapping it opens the station sheet, which does. VoiceOver reads the row as one sentence.
 */
export function StationRow({ row, walkingMeters, nowS, onPress, idPrefix = 'station-row' }: StationRowProps) {
  invariant(row.lines.length > 0, `${row.stationKey} is served by a line`);
  invariant(walkingMeters === null || (Number.isFinite(walkingMeters) && walkingMeters >= 0), 'a walking distance is a non-negative number of metres');
  const distance = walkingMeters === null ? null : formatDistance(walkingMeters);
  const times = row.next.map((next) => ({ next, when: minutesText({ epoch: next.epoch, nowS, depS: next.depS }) }));
  const label = copy.stationRowLabel({
    station: stationLabel(row),
    lines: copy.lineNames(row.lines.map((id) => lineById(id).name)),
    distance,
    departures: times.map(({ next, when }) => `${next.headsign}, ${when}`),
  });
  return (
    <Pressable
      testID={`${idPrefix}-${row.stationKey}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPress(row.stationKey)}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <View style={styles.title}>
        <TText variant="body" numberOfLines={1} style={styles.name}>
          {row.name}
        </TText>
        {distance === null ? null : (
          <TText testID={`${idPrefix}-distance-${row.stationKey}`} variant="subhead" tone="secondary">
            {distance}
          </TText>
        )}
      </View>
      <LineStrip lines={row.lines} testID={`${idPrefix}-lines-${row.stationKey}`} />
      {times.length === 0 ? (
        <TText variant="footnote" tone="secondary">
          {copy.nothingSoon}
        </TText>
      ) : (
        times.map(({ next, when }) => <NextLine key={next.directionId} id={`${idPrefix}-next-${row.stationKey}-${next.directionId}`} next={next} when={when} />)
      )}
    </Pressable>
  );
}

/** One direction's next departure: "Dadeland South · 4 min". */
function NextLine({ id, next, when }: { readonly id: string; readonly next: NextDeparture; readonly when: string }) {
  invariant(next.headsign.trim().length > 0, 'a departure says where it goes');
  invariant(when.length > 0 && id.endsWith(`-${next.directionId}`), 'a departure says when it leaves, under its direction\'s id');
  return (
    <View testID={id} style={styles.next}>
      <TText variant="subhead" numberOfLines={1} style={styles.headsign}>
        {next.headsign}
      </TText>
      <TText variant="subhead" tone="secondary" style={styles.when}>
        {when}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: SPACING.sm,
    gap: SPACING.xxs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: PlatformColor('separator'),
  },
  pressed: { opacity: 0.6 },
  title: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.xs },
  name: { flex: 1, fontWeight: '600' },
  next: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.xs },
  headsign: { flex: 1 },
  when: { fontVariant: ['tabular-nums'] },
});
