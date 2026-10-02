import { SymbolView } from 'expo-symbols';
import { PlatformColor, StyleSheet, View } from 'react-native';

import { LINE_IDS, type LineId, lineById } from '@/domain/lines/line-catalog';
import type { DepartureRow as MergedRow } from '@/domain/live/merge-departures';
import { invariant } from '@/lib/invariant';

import { copy } from '../copy';
import { statusFace } from '../dataStatus';
import { LineBadge } from '../primitives/LineBadge';
import { MinutesLabel, minutesText } from '../primitives/MinutesLabel';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';

const SOURCE_ICON_PT = 13;

export type DepartureRowProps = {
  /** One row of the merged board (m4a's merge-departures: a timetable departure, live-adjusted, or a live-only train). */
  readonly row: MergedRow;
  /** The row's instant as a service-day second (direction-board's serviceSecond), for its clock time beyond the hour. */
  readonly depS: number;
  /** Now (epoch s). */
  readonly nowS: number;
  /** Show the row's own live/scheduled icon — only when the rows around it mix sources (plan M6.3). */
  readonly showSource: boolean;
};

/**
 * One departure (plan M6.3): the line's badge, where the train goes, and how soon it leaves. A
 * canceled departure stays listed (§4 merge rule 6): its destination and time are struck through and
 * the word "Canceled" sits under the destination, so the cancellation never rests on colour or
 * strikethrough alone. VoiceOver reads the row as one sentence (copy.departureLabel).
 */
export function DepartureRow({ row, depS, nowS, showSource }: DepartureRowProps) {
  const lineId = catalogLine(row.lineId);
  const destination = row.destName ?? copy.unscheduledTrain;
  const source = statusFace({ kind: row.live ? 'live' : 'scheduled' });
  const label = copy.departureLabel({
    line: lineId === null ? null : lineById(lineId).name,
    destination: row.destName,
    when: minutesText({ epoch: row.epoch, nowS, depS }),
    canceled: row.canceled,
    source: showSource ? source.text : null,
  });
  invariant(row.key.length > 0, 'a board row is keyed');
  invariant(label.includes(destination), 'VoiceOver hears what the row shows for where the train goes');
  return (
    <View testID={`departure-row-${row.key}`} accessible accessibilityLabel={label} style={styles.row}>
      {lineId === null ? null : <LineBadge lineId={lineId} />}
      <View style={styles.destination}>
        <TText
          testID={`departure-destination-${row.key}`}
          variant="body"
          numberOfLines={1}
          tone={row.canceled ? 'secondary' : 'primary'}
          style={row.canceled ? styles.struck : null}>
          {destination}
        </TText>
        {row.canceled ? (
          <TText testID={`departure-canceled-${row.key}`} variant="footnote" style={styles.canceled}>
            {copy.canceled}
          </TText>
        ) : null}
      </View>
      {showSource ? (
        <View testID={`departure-source-${row.key}`}>
          <SymbolView name={source.icon} size={SOURCE_ICON_PT} tintColor={PlatformColor('secondaryLabel')} />
        </View>
      ) : null}
      <MinutesLabel testID={`departure-time-${row.key}`} epoch={row.epoch} nowS={nowS} depS={depS} struck={row.canceled} />
    </View>
  );
}

/** The row's line when the catalog draws it, else null (a live-only train whose line the schedule does not know). */
function catalogLine(lineId: string | null): LineId | null {
  invariant(lineId === null || lineId.length > 0, 'a line id is null or a name');
  const known = LINE_IDS.find((id) => id === lineId) ?? null;
  invariant(known === null || known === lineId, 'a row only ever shows its own line');
  return known;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.xs },
  destination: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
  canceled: { color: PlatformColor('systemRed'), fontWeight: '600' },
});
