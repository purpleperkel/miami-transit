import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';

import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import { vehicleLabel } from '../a11y';
import type { ColorScheme } from '../colors';
import type { VehicleFrame } from './vehicleFrames';
import { type VehicleVisual, vehicleVisual } from './vehicleVisual';

export type VehicleMarkerProps = {
  readonly vehicle: VehicleFrame;
  readonly scheme: ColorScheme;
  /** A tap: the vehicle's key, and the line it runs. */
  readonly onPress: (vehicleKey: string, lineId: LiveLineId) => void;
};

const CENTRE = { x: 0.5, y: 0.5 } as const;
/** The heading nose: a 6 pt triangle just outside the body, pointing along the vehicle's octant. */
const NOSE_PT = 6;
const NOSE_HALF_WIDTH_PT = 4;
const BADGE_PT = 14;
const BADGE_SYMBOL_PT = 10;

/**
 * A vehicle on the map (plan §4 "Vehicles", M5.9): live = solid, scheduled = hollow, stale = half
 * opacity with a clock badge, a nose pointing along its heading, and a 44 pt hit area. VoiceOver
 * reads its line, "live position" or "Scheduled position", a stale sighting's age and its heading.
 * The Marker is keyed on the visual key, so a new look is a new native view while each frame tick
 * only moves the coordinate.
 */
function VehicleMarkerView({ vehicle, scheme, onPress }: VehicleMarkerProps) {
  const { visual, label } = markerLook(vehicle, scheme);
  invariant(typeof onPress === 'function', 'a vehicle marker opens its vehicle');
  invariant(visual.hitPt >= visual.sizePt, 'the body sits inside its hit area');
  return (
    <Marker key={visual.key} coordinate={vehicle.coordinate} anchor={CENTRE} onPress={() => onPress(vehicle.key, vehicle.lineId)}>
      <View
        testID={`vehicle-marker-${vehicle.key}`}
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.centred, { width: visual.hitPt, height: visual.hitPt }]}>
        <View testID={`vehicle-body-${vehicle.key}`} style={[styles.centred, { opacity: visual.opacity }]}>
          {visual.octant === null ? null : <Nose visual={visual} />}
          <View style={bodyStyle(visual)}>
            {visual.letter === null ? null : (
              <Text allowFontScaling={false} style={[styles.letter, { color: visual.letterColor }]}>
                {visual.letter}
              </Text>
            )}
          </View>
        </View>
        {visual.stale ? <ClockBadge testID={`vehicle-stale-badge-${vehicle.key}`} /> : null}
      </View>
    </Marker>
  );
}

/** The marker's look and VoiceOver words, from its frame. */
function markerLook(vehicle: VehicleFrame, scheme: ColorScheme): { readonly visual: VehicleVisual; readonly label: string } {
  invariant(vehicle.key.length > 0, 'a marker belongs to a vehicle');
  const visual = vehicleVisual({
    vehicleKey: vehicle.key,
    mode: vehicle.mode,
    lineId: vehicle.lineId,
    source: vehicle.source,
    live: vehicle.live,
    bearing: vehicle.bearing,
    scheme,
  });
  const staleAgeS = visual.stale && vehicle.live !== null ? vehicle.live.ageS : null;
  const label = vehicleLabel({ lineId: vehicle.lineId, source: vehicle.source, staleAgeS, octant: visual.octant });
  invariant(visual.key.includes(vehicle.key) && label.length > 0, 'the look names its vehicle, and VoiceOver has words for it');
  return { visual, label };
}

function bodyStyle(visual: VehicleVisual) {
  invariant(visual.sizePt > 2 * visual.ringPt, 'the body shows its fill inside its ring');
  const style = {
    width: visual.sizePt,
    height: visual.sizePt,
    borderRadius: visual.cornerPt,
    borderWidth: visual.ringPt,
    borderColor: visual.ring,
    backgroundColor: visual.fill,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  invariant(style.borderRadius <= style.width / 2, 'the corner radius fits the body');
  return style;
}

/** The heading nose: a square around the body, turned to the octant, with a triangle at its top edge. */
function Nose({ visual }: { readonly visual: VehicleVisual }) {
  invariant(visual.octant !== null, 'a nose needs a heading');
  const span = visual.sizePt + 2 * NOSE_PT;
  invariant(span <= visual.hitPt, 'the nose stays inside the hit area');
  return (
    <View pointerEvents="none" style={[styles.nose, { width: span, height: span, transform: [{ rotate: `${visual.octant * 45}deg` }] }]}>
      <View style={[styles.triangle, { borderBottomColor: visual.ring }]} />
    </View>
  );
}

/** The stale badge: a clock on a white disc at the body's top right. */
function ClockBadge({ testID }: { readonly testID: string }) {
  invariant(testID.length > 0, 'the badge is identifiable');
  invariant(BADGE_SYMBOL_PT < BADGE_PT, 'the clock fits its disc');
  return (
    <View testID={testID} pointerEvents="none" style={styles.badge}>
      <SymbolView name="clock.fill" size={BADGE_SYMBOL_PT} tintColor="#000000" />
    </View>
  );
}

/** Re-render for a new look, place, label or handler — never because the map around it re-rendered. */
function sameVehicle(a: VehicleMarkerProps, b: VehicleMarkerProps): boolean {
  invariant(a.vehicle.key === b.vehicle.key, 'a marker keeps its vehicle');
  if (a.vehicle === b.vehicle) {
    return a.scheme === b.scheme && a.onPress === b.onPress;
  }
  const [lookA, lookB] = [markerLook(a.vehicle, a.scheme), markerLook(b.vehicle, b.scheme)];
  const same =
    lookA.visual.key === lookB.visual.key &&
    lookA.label === lookB.label &&
    a.vehicle.coordinate.latitude === b.vehicle.coordinate.latitude &&
    a.vehicle.coordinate.longitude === b.vehicle.coordinate.longitude &&
    a.onPress === b.onPress;
  invariant(!same || lookA.visual.opacity === lookB.visual.opacity, 'equal markers look the same');
  return same;
}

export const VehicleMarker = memo(VehicleMarkerView, sameVehicle);

const styles = StyleSheet.create({
  centred: { alignItems: 'center', justifyContent: 'center' },
  letter: { fontSize: 13, fontWeight: '700' },
  nose: { position: 'absolute', alignItems: 'center' },
  triangle: {
    width: 0,
    height: 0,
    borderLeftWidth: NOSE_HALF_WIDTH_PT,
    borderRightWidth: NOSE_HALF_WIDTH_PT,
    borderBottomWidth: NOSE_PT,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: BADGE_PT,
    height: BADGE_PT,
    borderRadius: BADGE_PT / 2,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
