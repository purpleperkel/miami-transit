import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { PlatformColor, Pressable, StyleSheet } from 'react-native';

import { invariant } from '@/lib/invariant';

import { MIN_HIT_AREA_PT } from './vehicleVisual';
import { Glass } from '../primitives/Glass';

/** The Layers sheet's route (src/app/layers.tsx, a formSheet over the map). */
export const LAYERS_ROUTE = '/layers';
const ICON_PT = 20;

/**
 * The map's floating control stack (plan §4: glass only on floating chrome, M5.11). It holds the
 * Layers button, which opens the Layers sheet — the one way to reach the sheet the plan names no
 * other door for. Each button is a 44 pt square.
 */
export function MapControlStack() {
  invariant(LAYERS_ROUTE.startsWith('/'), 'the Layers sheet has an absolute route');
  invariant(MIN_HIT_AREA_PT === 44, 'controls are 44 pt squares');
  return (
    <Glass style={styles.stack}>
      <Pressable
        testID="map-control-layers"
        accessibilityRole="button"
        accessibilityLabel="Layers"
        accessibilityHint="Choose what the map shows"
        onPress={() => router.push(LAYERS_ROUTE)}
        style={styles.button}>
        <SymbolView name="square.3.layers.3d" size={ICON_PT} tintColor={PlatformColor('label')} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  stack: { overflow: 'hidden' },
  button: { width: MIN_HIT_AREA_PT, height: MIN_HIT_AREA_PT, alignItems: 'center', justifyContent: 'center' },
});
