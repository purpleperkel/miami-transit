import { PlatformColor, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { StationListing } from '@/data/schedule-queries';
import type { Mode } from '@/domain/network/stations';
import { invariant } from '@/lib/invariant';

import { MODE_NAMES } from '../../a11y';
import { TText } from '../../primitives/TText';
import { RADIUS, SPACING } from '../../tokens';

export type PickerRow = {
  readonly station: StationListing;
  /** Why the station cannot be picked here (shown under its name), or null when it can. */
  readonly excludedBecause: string | null;
};

export type StationPickerProps = {
  /** What the list is for, above it ("Where does the trip leave from?"). */
  readonly prompt: string;
  readonly rows: readonly PickerRow[];
  readonly onPick: (stationKey: string) => void;
  readonly testID: string;
};

const MODES: readonly Mode[] = ['rail', 'mover'];

/**
 * The add-trip flow's station list (M7.9): Metrorail then Metromover, each in the schedule's name order.
 * A station that cannot be picked stays listed — dimmed, not a button, with why beneath it — so the rider
 * sees that it exists and what it would take (a trip to it needs a transfer: route options).
 */
export function StationPicker({ prompt, rows, onPick, testID }: StationPickerProps) {
  invariant(rows.length > 0, 'the picker lists stations');
  invariant(typeof onPick === 'function', 'a pick goes somewhere');
  return (
    <ScrollView testID={testID} contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <TText variant="subhead" tone="secondary">
        {prompt}
      </TText>
      {MODES.map((mode) => {
        const inMode = rows.filter((row) => row.station.mode === mode);
        return inMode.length === 0 ? null : <Section key={mode} title={MODE_NAMES[mode]} rows={inMode} onPick={onPick} />;
      })}
    </ScrollView>
  );
}

function Section({ title, rows, onPick }: { readonly title: string; readonly rows: readonly PickerRow[]; readonly onPick: (stationKey: string) => void }) {
  invariant(rows.length > 0, 'a section lists stations');
  invariant(title.length > 0, 'a section has a title');
  return (
    <View style={styles.section}>
      <TText variant="footnote" tone="secondary" accessibilityRole="header">
        {title.toUpperCase()}
      </TText>
      <View style={styles.group}>
        {rows.map((row) => (
          <Row key={row.station.stationKey} row={row} onPick={onPick} />
        ))}
      </View>
    </View>
  );
}

function Row({ row, onPick }: { readonly row: PickerRow; readonly onPick: (stationKey: string) => void }) {
  const key = row.station.stationKey;
  invariant(key.includes(':'), 'a row is a station');
  invariant(row.excludedBecause === null || row.excludedBecause.length > 0, 'an exclusion says why');
  if (row.excludedBecause !== null) {
    return (
      <View testID={`pick-${key}`} accessible accessibilityLabel={`${row.station.name}, ${row.excludedBecause}`} accessibilityState={{ disabled: true }} style={[styles.row, styles.excluded]}>
        <TText variant="body" tone="secondary">
          {row.station.name}
        </TText>
        <TText variant="footnote" tone="secondary">
          {row.excludedBecause}
        </TText>
      </View>
    );
  }
  return (
    <Pressable testID={`pick-${key}`} accessibilityRole="button" accessibilityLabel={row.station.name} onPress={() => onPick(key)} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <TText variant="body">{row.station.name}</TText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  section: { gap: SPACING.xs },
  group: { borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  row: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PlatformColor('separator') },
  excluded: { opacity: 0.6 },
  pressed: { opacity: 0.6 },
});
