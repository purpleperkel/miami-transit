import { PlatformColor, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { invariant } from '@/lib/invariant';

import { MODE_NAMES } from '../a11y';
import { TText } from '../primitives/TText';
import { SPACING } from '../tokens';
import { LAYER_IDS, type LayerId, type LayersState } from './layers';

/** What each layer is called on the sheet, and what switching it off hides. */
export const LAYER_COPY: Readonly<Record<LayerId, { readonly title: string; readonly detail: string }>> = Object.freeze({
  rail: { title: MODE_NAMES.rail, detail: 'Green and Orange lines, their stations and trains' },
  mover: { title: MODE_NAMES.mover, detail: 'Inner Loop, Omni and Brickell, their stations and cars' },
  stations: { title: 'Stations', detail: 'Station dots on the lines' },
  vehicles: { title: 'Vehicles', detail: 'Trains and cars, live and scheduled' },
  scheduled: { title: 'Scheduled positions', detail: 'Hollow markers where the timetable places a vehicle no live data covers' },
});

export type LayersSheetProps = {
  readonly layers: LayersState;
  /** Why the saved layers could not be read or saved, or null. */
  readonly problem: string | null;
  readonly onToggle: (layer: LayerId) => void;
};

/**
 * The Layers sheet (plan M5.12, a formSheet over the map): one switch per layer. Each switch flips
 * its layer alone, and the map under the sheet follows at once. A saved state that could not be read
 * (or a change that could not be saved) is said plainly at the bottom.
 */
export function LayersSheet({ layers, problem, onToggle }: LayersSheetProps) {
  invariant(LAYER_IDS.every((id) => typeof layers[id] === 'boolean'), 'every layer is on or off');
  invariant(typeof onToggle === 'function', 'the switches change the layers');
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={styles.sheet} contentContainerStyle={styles.content}>
      {LAYER_IDS.map((id) => (
        <LayerRow key={id} layer={id} on={layers[id]} disabled={id === 'scheduled' && !layers.vehicles} onToggle={onToggle} />
      ))}
      {problem === null ? null : (
        <TText testID="layers-problem" variant="footnote" tone="secondary">
          {problem}
        </TText>
      )}
    </ScrollView>
  );
}

type LayerRowProps = { readonly layer: LayerId; readonly on: boolean; readonly disabled: boolean; readonly onToggle: (layer: LayerId) => void };

/** One layer: its name and what it covers, and its switch (scheduled positions need the vehicles layer). */
function LayerRow({ layer, on, disabled, onToggle }: LayerRowProps) {
  const copy = LAYER_COPY[layer];
  invariant(copy.title.length > 0 && copy.detail.length > 0, `layer ${layer} has a name and a description`);
  invariant(typeof on === 'boolean', 'a layer is on or off');
  return (
    <View style={styles.row}>
      <View style={styles.words}>
        <TText variant="body">{copy.title}</TText>
        <TText variant="footnote" tone="secondary">
          {copy.detail}
        </TText>
      </View>
      <Switch testID={`layer-switch-${layer}`} accessibilityLabel={copy.title} value={on} disabled={disabled} onValueChange={() => onToggle(layer)} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: PlatformColor('systemGroupedBackground') },
  content: { padding: SPACING.md, gap: SPACING.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: PlatformColor('separator'),
  },
  words: { flex: 1, gap: SPACING.xxs },
});
