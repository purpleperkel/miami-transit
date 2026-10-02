import { router } from 'expo-router';
import type { SFSymbol } from 'expo-symbols';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { MIN_HIT_AREA_PT } from './vehicleVisual';
import { copy } from '../copy';
import { Glass } from '../primitives/Glass';
import { openPlanSheet } from '../sheets';

/** The Layers sheet's route (src/app/layers.tsx, a formSheet over the map). */
export const LAYERS_ROUTE = '/layers';
const ICON_PT = 20;

export type MapControlStackProps = {
  /** The ⓘ button: opens the map legend. No button without it. */
  readonly onLegend?: () => void;
  /** The locate-me button: centres the map on the user (MapKit's own button is Google-Maps-only on iOS). No button without it. */
  readonly onLocate?: () => void;
};

/**
 * The map's floating control stack (plan §4: glass only on floating chrome, M5.11; mfix3 §5). It holds
 * the Directions button, which opens the route options sheet from where the rider is (M10b); the Layers
 * button, which opens the Layers sheet — the one way to reach the sheet the plan names no other door
 * for — and, when the map gives their actions, the legend (ⓘ) and locate-me buttons. Each button is a
 * 44 pt square.
 */
export function MapControlStack({ onLegend, onLocate }: MapControlStackProps) {
  invariant(LAYERS_ROUTE.startsWith('/'), 'the Layers sheet has an absolute route');
  invariant(MIN_HIT_AREA_PT === 44, 'controls are 44 pt squares');
  return (
    <Glass style={styles.stack}>
      <ControlButton id="directions" symbol="arrow.triangle.turn.up.right.diamond" label={copy.directions} hint={copy.directionsHint} onPress={() => openPlanSheet()} />
      <ControlButton id="layers" symbol="square.3.layers.3d" label="Layers" hint="Choose what the map shows" onPress={() => router.push(LAYERS_ROUTE)} />
      {onLegend === undefined ? null : <ControlButton id="legend" symbol="info.circle" label="Map legend" hint="What the markers mean" onPress={onLegend} />}
      {onLocate === undefined ? null : <ControlButton id="locate" symbol="location" label="Show my location" hint="Centres the map on you" onPress={onLocate} />}
    </Glass>
  );
}

type ControlButtonProps = { readonly id: string; readonly symbol: SFSymbol; readonly label: string; readonly hint: string; readonly onPress: () => void };

/** One 44 pt control (testID `map-control-<id>`): an SF Symbol with VoiceOver words. */
function ControlButton({ id, symbol, label, hint, onPress }: ControlButtonProps) {
  invariant(/^[a-z]+$/.test(id), 'a control is identifiable');
  invariant(label.length > 0 && typeof onPress === 'function', 'a control says what it does, and does it');
  return (
    <Pressable testID={`map-control-${id}`} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} onPress={onPress} style={styles.button}>
      <SymbolView name={symbol} size={ICON_PT} tintColor={PlatformColor('label')} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { overflow: 'hidden' },
  button: { width: MIN_HIT_AREA_PT, height: MIN_HIT_AREA_PT, alignItems: 'center', justifyContent: 'center' },
});
