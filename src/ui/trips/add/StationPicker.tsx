import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { PlatformColor, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { StationListing } from '@/data/schedule-queries';
import type { Mode } from '@/domain/network/stations';
import { invariant } from '@/lib/invariant';

import { MODE_NAMES, stationLabel } from '../../a11y';
import { formatDistance } from '../../format';
import { ActionButton } from '../../primitives/ActionButton';
import { TText } from '../../primitives/TText';
import { RADIUS, SPACING } from '../../tokens';
import { tripWords } from '../trip-copy';

export type PickerRow = {
  readonly station: StationListing;
  /** Why the station cannot be picked here (shown in the trailing group), or null when it can. */
  readonly excludedBecause: string | null;
  /** Straight-line metres from the rider (m6b's orderStations) when the rows come nearest first; null otherwise. */
  readonly walkingMeters: number | null;
};

export type StationPickerProps = {
  /** What the list is for, above it ("Where does the trip leave from?"). */
  readonly prompt: string;
  readonly rows: readonly PickerRow[];
  readonly onPick: (stationKey: string) => void;
  readonly testID: string;
  /** Opens route options, which can plan a trip the trailing "Needs a transfer" group cannot be picked for. */
  readonly onRouteOptions?: () => void;
};

const MODES: readonly Mode[] = ['rail', 'mover'];

/**
 * The add-trip flow's station list (M7.9, mfix7). The stations that can be picked come first: nearest
 * first in ONE list, each with its distance, when the rows carry the rider's distances (Leaving from, with a
 * location); otherwise Metrorail then Metromover, each in the schedule's name order. Every station that
 * cannot be picked goes in ONE trailing "Needs a transfer" group — collapsed, so the reachable stations
 * lead (Jamie's 07:10 recording: the Going-to list opened on a wall of greyed-out Metrorail rows) — which
 * says why once and offers route options, which can plan the trip with its transfer.
 */
export function StationPicker({ prompt, rows, onPick, testID, onRouteOptions }: StationPickerProps) {
  const pickable = rows.filter((row) => row.excludedBecause === null);
  const excluded = rows.filter((row) => row.excludedBecause !== null);
  const nearest = pickable.some((row) => row.walkingMeters !== null);
  invariant(rows.length > 0, 'the picker lists stations');
  invariant(pickable.length + excluded.length === rows.length && typeof onPick === 'function', 'every station is listed once, and a pick goes somewhere');
  return (
    <ScrollView testID={testID} contentInsetAdjustmentBehavior="automatic" style={styles.screen} contentContainerStyle={styles.content}>
      <TText variant="subhead" tone="secondary">
        {prompt}
      </TText>
      {nearest ? (
        <Section id={`${testID}-nearest`} title={tripWords.nearestFirst} rows={pickable} onPick={onPick} />
      ) : (
        MODES.map((mode) => {
          const inMode = pickable.filter((row) => row.station.mode === mode);
          return inMode.length === 0 ? null : <Section key={mode} id={`${testID}-${mode}`} title={MODE_NAMES[mode]} rows={inMode} onPick={onPick} />;
        })
      )}
      {excluded.length === 0 ? null : <TransferGroup id={`${testID}-transfer`} rows={excluded} onRouteOptions={onRouteOptions} />}
    </ScrollView>
  );
}

type SectionProps = { readonly id: string; readonly title: string; readonly rows: readonly PickerRow[]; readonly onPick: (stationKey: string) => void };

function Section({ id, title, rows, onPick }: SectionProps) {
  invariant(rows.length > 0, 'a section lists stations');
  invariant(title.length > 0 && rows.every((row) => row.excludedBecause === null), 'a titled section of stations to pick');
  return (
    <View testID={id} style={styles.section}>
      <TText variant="footnote" tone="secondary" accessibilityRole="header">
        {title.toUpperCase()}
      </TText>
      <View style={styles.group}>
        {rows.map((row) => (
          <PickRow key={row.station.stationKey} row={row} onPick={onPick} />
        ))}
      </View>
    </View>
  );
}

/** A station to pick: its name and, nearest first, its system and how far it is ("Metromover · 360 m"). */
function PickRow({ row, onPick }: { readonly row: PickerRow; readonly onPick: (stationKey: string) => void }) {
  const key = row.station.stationKey;
  const distance = row.walkingMeters === null ? null : formatDistance(row.walkingMeters);
  const detail = distance === null ? null : `${MODE_NAMES[row.station.mode]} · ${distance}`;
  invariant(key.includes(':') && row.excludedBecause === null, 'a row to pick is a station that can be picked');
  invariant(detail === null || detail.length > 0, 'a distance reads as words');
  return (
    <Pressable
      testID={`pick-${key}`}
      accessibilityRole="button"
      accessibilityLabel={distance === null ? row.station.name : `${stationLabel(row.station)}, ${distance}`}
      onPress={() => onPick(key)}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <TText variant="body">{row.station.name}</TText>
      {detail === null ? null : (
        <TText testID={`pick-distance-${key}`} variant="footnote" tone="secondary">
          {detail}
        </TText>
      )}
    </Pressable>
  );
}

type TransferGroupProps = { readonly id: string; readonly rows: readonly PickerRow[]; readonly onRouteOptions?: () => void };

/** The stations no single vehicle reaches: one collapsed group after every station that can be picked. */
function TransferGroup({ id, rows, onRouteOptions }: TransferGroupProps) {
  const [open, setOpen] = useState(false);
  const reasons = [...new Set(rows.map((row) => row.excludedBecause as string))];
  invariant(rows.length > 0 && reasons.every((reason) => reason.length > 0), 'the group lists stations, each with why');
  invariant(typeof setOpen === 'function', 'the group opens and closes');
  return (
    <View testID={id} style={styles.section}>
      <Pressable
        testID={`${id}-toggle`}
        accessibilityRole="button"
        accessibilityLabel={`${tripWords.needsTransfer}, ${tripWords.stationCount(rows.length)}`}
        accessibilityHint={open ? tripWords.hideTransfersHint : tripWords.showTransfersHint}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => setOpen((was) => !was)}
        style={styles.toggle}>
        <TText variant="footnote" tone="secondary" style={styles.toggleText}>
          {`${tripWords.needsTransfer} · ${tripWords.stationCount(rows.length)}`.toUpperCase()}
        </TText>
        <SymbolView name={open ? 'chevron.up' : 'chevron.down'} size={13} tintColor={PlatformColor('secondaryLabel')} />
      </Pressable>
      {open ? <TransferRows id={id} rows={rows} reasons={reasons} onRouteOptions={onRouteOptions} /> : null}
    </View>
  );
}

type TransferRowsProps = TransferGroupProps & { readonly reasons: readonly string[] };

/** The open group: why (once), route options, and the stations — dimmed, not buttons. */
function TransferRows({ id, rows, reasons, onRouteOptions }: TransferRowsProps) {
  invariant(reasons.length > 0, 'the group says why');
  invariant(rows.every((row) => row.excludedBecause !== null), 'only stations that cannot be picked are in the group');
  return (
    <>
      {reasons.map((reason) => (
        <TText key={reason} testID={`${id}-why`} variant="footnote" tone="secondary">
          {reason}
        </TText>
      ))}
      {onRouteOptions === undefined ? null : <ActionButton testID={`${id}-route-options`} symbol="arrow.triangle.turn.up.right.diamond" label={tripWords.routeOptions} hint={tripWords.transferRouteOptionsHint} onPress={onRouteOptions} />}
      <View style={styles.group}>
        {rows.map((row) => (
          <ExcludedRow key={row.station.stationKey} row={row} />
        ))}
      </View>
    </>
  );
}

/** A station that cannot be picked: its name, dimmed and not a button; VoiceOver hears why. */
function ExcludedRow({ row }: { readonly row: PickerRow }) {
  invariant(row.excludedBecause !== null && row.excludedBecause.length > 0, 'an excluded station says why');
  invariant(row.station.stationKey.includes(':'), 'a row is a station');
  return (
    <View testID={`pick-${row.station.stationKey}`} accessible accessibilityLabel={`${row.station.name}, ${row.excludedBecause}`} accessibilityState={{ disabled: true }} style={[styles.row, styles.excluded]}>
      <TText variant="body" tone="secondary">
        {row.station.name}
      </TText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.md },
  section: { gap: SPACING.xs },
  group: { borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: PlatformColor('secondarySystemGroupedBackground') },
  row: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PlatformColor('separator') },
  toggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  toggleText: { flex: 1 },
  excluded: { opacity: 0.6 },
  pressed: { opacity: 0.6 },
});
