import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Marker } from 'react-native-maps';

import type { StationListing } from '@/data/schedule-queries';
import { invariant } from '@/lib/invariant';

import { stationLabel } from '../a11y';
import type { ColorScheme } from '../colors';
import type { ZoomBucket } from './mapGeometry';
import { stationVisual } from './vehicleVisual';

export type StationMarkerProps = {
  readonly station: StationListing;
  readonly selected: boolean;
  readonly bucket: ZoomBucket;
  readonly scheme: ColorScheme;
  readonly onPress: (stationKey: string) => void;
};

const CENTRE = { x: 0.5, y: 0.5 } as const;

/**
 * A station on the map (plan M5.8): a dot sized for the zoom bucket inside a 44 pt square, so a tap
 * anywhere near it lands (the marker's view is the hit area). VoiceOver reads the station and its
 * system. The Marker is keyed on the visual key: a new look is a new native view.
 */
function StationMarkerView({ station, selected, bucket, scheme, onPress }: StationMarkerProps) {
  const visual = stationVisual({ stationKey: station.stationKey, mode: station.mode, selected, bucket, scheme });
  invariant(typeof onPress === 'function', 'a station marker opens its station');
  invariant(visual.hitPt >= visual.diameterPt, 'the dot sits inside its hit area');
  const dot = {
    width: visual.diameterPt,
    height: visual.diameterPt,
    borderRadius: visual.diameterPt / 2,
    borderWidth: visual.ringPt,
    borderColor: visual.ring,
    backgroundColor: visual.fill,
  };
  return (
    <Marker key={visual.key} coordinate={station.coordinate} anchor={CENTRE} onPress={() => onPress(station.stationKey)}>
      <View
        testID={`station-marker-${station.stationKey}`}
        accessible
        accessibilityRole="button"
        accessibilityLabel={stationLabel(station)}
        accessibilityState={{ selected }}
        style={[styles.hitArea, { width: visual.hitPt, height: visual.hitPt }]}>
        <View style={dot} />
      </View>
    </Marker>
  );
}

/** The marker's visual key: what it looks like, from its props. */
function lookOf(props: StationMarkerProps): string {
  const { station, selected, bucket, scheme } = props;
  invariant(station.stationKey.length > 0, 'a marker belongs to a station');
  const key = stationVisual({ stationKey: station.stationKey, mode: station.mode, selected, bucket, scheme }).key;
  invariant(key.includes(station.stationKey), 'the visual key names its station');
  return key;
}

/** Re-render only for a new look, place, label or handler — not because the map around it re-rendered. */
function sameMarker(a: StationMarkerProps, b: StationMarkerProps): boolean {
  const same = lookOf(a) === lookOf(b) && a.station.coordinate === b.station.coordinate && a.station.name === b.station.name && a.onPress === b.onPress;
  invariant(typeof same === 'boolean', 'markers compare equal or not');
  invariant(!same || a.station.stationKey === b.station.stationKey, 'equal markers show the same station');
  return same;
}

export const StationMarker = memo(StationMarkerView, sameMarker);

const styles = StyleSheet.create({
  hitArea: { alignItems: 'center', justifyContent: 'center' },
});
