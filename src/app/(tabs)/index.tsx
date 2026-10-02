import { StyleSheet, View } from 'react-native';
import type { Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { invariant } from '@/lib/invariant';
import { StatusPill } from '@/ui/map/StatusPill';
import { TransitMap } from '@/ui/map/TransitMap';
import { useLiveMap } from '@/ui/map/use-live-map';
import { MIN_HIT_AREA_PT } from '@/ui/map/vehicleVisual';
import { SPACING } from '@/ui/tokens';

// Downtown Miami: Government Center sits roughly at the centre of the rail + Mover network.
const DOWNTOWN_MIAMI: Region = {
  latitude: 25.7743,
  longitude: -80.1937,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

/**
 * The Map tab (plan M5.12): the live map — lines, stations and vehicles moving along the track —
 * with the floating chrome over it: the status pill (top left) and, drawn by TransitMap with the map's
 * own interactions, the control stack (top right: layers, legend, locate-me) and the tap caption.
 * TransitMap draws react-native-maps' MapView; use-live-map.ts wires in the schedule DB, the live
 * runtime and the layers.
 */
export default function MapScreen() {
  // MKMapView throws on an invalid region, so the initial region's contract is checked first.
  invariant(
    Math.abs(DOWNTOWN_MIAMI.latitude) <= 90 && Math.abs(DOWNTOWN_MIAMI.longitude) <= 180,
    'the initial region centres on a real coordinate',
  );
  invariant(
    DOWNTOWN_MIAMI.latitudeDelta > 0 && DOWNTOWN_MIAMI.longitudeDelta > 0,
    'the initial region spans a visible area',
  );
  const { map, status, reduceMotion } = useLiveMap(DOWNTOWN_MIAMI);
  const insets = useSafeAreaInsets();
  const chromeTop = insets.top + SPACING.xs;
  return (
    <View style={styles.screen}>
      <TransitMap {...map} controlsTopPt={chromeTop} />
      <View pointerEvents="box-none" style={[styles.chrome, { top: chromeTop }]}>
        <View style={styles.pillSlot}>{status === null ? null : <StatusPill status={status} reduceMotion={reduceMotion} />}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  chrome: {
    position: 'absolute',
    left: SPACING.md,
    // Clear of the control stack's 44 pt column, which TransitMap floats at the top right.
    right: SPACING.md + MIN_HIT_AREA_PT + SPACING.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  pillSlot: { flex: 1, alignItems: 'flex-start' },
});
