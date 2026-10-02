import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Modal, PlatformColor, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import type { ColorScheme } from '../colors';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import type { UserLocation } from './use-user-location';
import { ClockBadge, VehicleBody } from './VehicleMarker';
import { MIN_HIT_AREA_PT, vehicleVisual, type VehicleVisualInput } from './vehicleVisual';

/**
 * The map legend (mfix3 §5, Jamie 2026-10-01: "idk what G dot is"): every kind of marker the map draws,
 * each beside a swatch drawn by the markers' own visual (vehicleVisual + VehicleBody), plus one line on
 * the you-are-here dot — or, when location is off, why there is none. A native page sheet over the map,
 * opened by the control stack's ⓘ button.
 */

/** The legend's one location line, for each state of the location permission. */
export function locationLine(location: UserLocation): string {
  invariant(['asking', 'granted', 'denied'].includes(location.kind), 'location is asked, granted or denied');
  const line =
    location.kind === 'granted'
      ? 'Blue dot — where you are'
      : location.kind === 'asking'
        ? 'Asking for your location…'
        : location.problem === null
          ? 'Location is off — allow it in Settings to see where you are'
          : `Location is unavailable — ${location.problem}`;
  invariant(line.length > 0, 'the location line says something');
  return line;
}

/** A swatch: one vehicle as the map draws it (a live 30 s old fix by default). */
function swatch(lineId: LiveLineId, look: { readonly source?: 'live' | 'scheduled'; readonly stale?: boolean } = {}): VehicleVisualInput {
  const source = look.source ?? 'live';
  const feedAgeS = look.stale === true ? 600 : 30;
  const input: VehicleVisualInput = {
    vehicleKey: `legend-${lineId}-${source}-${feedAgeS}`,
    mode: lineId === 'GREEN' || lineId === 'ORANGE' || lineId === 'RAIL_TRUNK' ? 'rail' : 'mover',
    lineId,
    source,
    live: source === 'live' ? { provider: 'transitland', ageS: feedAgeS, feedAgeS, lagS: 0 } : null,
    bearing: null,
    scheme: 'light',
  };
  invariant((input.source === 'live') === (input.live !== null), 'a live swatch carries a sighting');
  invariant(input.vehicleKey.length > 0, 'a swatch is keyed');
  return input;
}

type Row = { readonly key: string; readonly swatches: readonly VehicleVisualInput[]; readonly text: string };

/** The marker kinds, in the order a rider meets them. */
const ROWS: readonly Row[] = [
  { key: 'green', swatches: [swatch('GREEN')], text: 'G — Green Line train (Metrorail)' },
  { key: 'orange', swatches: [swatch('ORANGE')], text: 'O — Orange Line train (Metrorail)' },
  { key: 'trunk', swatches: [swatch('RAIL_TRUNK')], text: 'M — Metrorail train on the shared track, line not known yet' },
  { key: 'mover', swatches: [swatch('MM_INNER'), swatch('MM_OMNI'), swatch('MM_BRICKELL')], text: 'Dots — Metromover cars, coloured by loop: Inner Loop, Omni, Brickell' },
  { key: 'live', swatches: [swatch('ORANGE'), swatch('MM_OMNI')], text: 'Solid — a live position' },
  { key: 'scheduled', swatches: [swatch('ORANGE', { source: 'scheduled' }), swatch('MM_OMNI', { source: 'scheduled' })], text: 'Hollow — a timetable estimate' },
  { key: 'stale', swatches: [swatch('ORANGE', { stale: true })], text: 'Last seen a while ago' },
];

export type MapLegendProps = {
  readonly scheme: ColorScheme;
  readonly location: UserLocation;
  readonly onClose: () => void;
};

export function MapLegend({ scheme, location, onClose }: MapLegendProps) {
  invariant(typeof onClose === 'function', 'the legend can be closed');
  invariant(ROWS.length === 7, 'the legend explains every marker kind');
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View testID="map-legend" style={styles.sheet}>
        <View style={styles.header}>
          <TText variant="headline" accessibilityRole="header">
            Map legend
          </TText>
          <Pressable testID="map-legend-done" accessibilityRole="button" onPress={onClose} hitSlop={SPACING.sm}>
            <TText variant="body">Done</TText>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.rows}>
          {ROWS.map((row) => (
            <KindRow key={row.key} row={row} scheme={scheme} />
          ))}
          <LegendRow testID="map-legend-location" text={locationLine(location)}>
            <SymbolView name={location.kind === 'granted' ? 'location.fill' : 'location.slash'} size={18} tintColor={PlatformColor('systemBlue')} />
          </LegendRow>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** One marker kind: its swatches in the map's colour scheme, then the words. */
function KindRow({ row, scheme }: { readonly row: Row; readonly scheme: ColorScheme }) {
  invariant(row.swatches.length > 0, `the ${row.key} row shows its markers`);
  invariant(row.text.length > 0, `the ${row.key} row says what they are`);
  return (
    <LegendRow testID={`map-legend-row-${row.key}`} text={row.text}>
      {row.swatches.map((input) => (
        <Swatch key={input.vehicleKey} input={{ ...input, scheme }} />
      ))}
    </LegendRow>
  );
}

/** One row: its swatches, then the words. */
function LegendRow({ testID, text, children }: { readonly testID: string; readonly text: string; readonly children: ReactNode }) {
  invariant(text.trim().length > 0, 'a legend row says what it shows');
  invariant(testID.startsWith('map-legend-'), 'a legend row is identifiable');
  return (
    <View testID={testID} style={styles.row} accessible accessibilityLabel={text}>
      <View style={styles.swatches}>{children}</View>
      <TText variant="subhead" style={styles.text} testID={`${testID}-text`}>
        {text}
      </TText>
    </View>
  );
}

/** A marker as the map draws it, in a 44 pt cell (faded with its clock badge when stale). */
function Swatch({ input }: { readonly input: VehicleVisualInput }) {
  const visual = vehicleVisual(input);
  invariant(visual.hitPt === MIN_HIT_AREA_PT, 'a swatch sits in a marker-sized cell');
  invariant(visual.opacity > 0 && visual.opacity <= 1, 'a swatch is visible');
  return (
    <View style={styles.cell}>
      <View style={{ opacity: visual.opacity }}>
        <VehicleBody visual={visual} />
      </View>
      {visual.stale ? <ClockBadge testID={`map-legend-clock-${input.lineId}`} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: PlatformColor('systemBackground') },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: SPACING.md },
  rows: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xl, gap: SPACING.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, minHeight: MIN_HIT_AREA_PT },
  swatches: { flexDirection: 'row', minWidth: MIN_HIT_AREA_PT, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  cell: { width: MIN_HIT_AREA_PT, height: MIN_HIT_AREA_PT, alignItems: 'center', justifyContent: 'center' },
});
