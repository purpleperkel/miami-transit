import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import MapView, { type MapPressEvent, type Region } from 'react-native-maps';

import type { StationListing } from '@/data/schedule-queries';
import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import type { ColorScheme } from '../colors';
import { drawsLine, drawsStation, drawsVehicle, type MapEmphasis } from './emphasis';
import type { LineSegment } from './lineLayout';
import { LinePolylines } from './LinePolylines';
import type { MapRegion, ZoomBucket } from './mapGeometry';
import { StationMarker } from './StationMarker';
import type { VehicleFrame } from './vehicleFrames';
import { VehicleMarker } from './VehicleMarker';

/**
 * The map is the app (plan §4 "UX system", M5.12): full-bleed MapKit in `mutedStandard`, with points
 * of interest, buildings and pitch off, drawing the lines (LinePolylines), the stations
 * (StationMarker) and the moving vehicles (VehicleMarker) — each filtered and dimmed by the emphasis
 * (layers + focus). PRESENTATIONAL: every piece of data arrives as a prop; use-live-map.ts reads the
 * schedule DB and the live context and wires them in. `pointsOfInterestFilter` is never set, because
 * it overrides `showsPointsOfInterests`.
 */

/** The four render props the plan fixes for the map (M5.12 A). */
export const MAP_RENDER_PROPS = Object.freeze({
  mapType: 'mutedStandard',
  showsPointsOfInterests: false,
  pitchEnabled: false,
  showsBuildings: false,
} as const);

export type TransitMapProps = {
  readonly scheme: ColorScheme;
  readonly initialRegion: MapRegion;
  readonly bucket: ZoomBucket;
  /** The lines at this zoom bucket, or null while the schedule DB is opening (or failed). */
  readonly segments: readonly LineSegment[] | null;
  readonly stations: readonly StationListing[];
  readonly vehicles: readonly VehicleFrame[];
  readonly emphasis: MapEmphasis;
  readonly selectedStationKey: string | null;
  readonly onRegionChange: (region: MapRegion) => void;
  readonly onStationPress: (stationKey: string) => void;
  /** A tap on a vehicle: its key, and the line it runs. */
  readonly onVehiclePress: (vehicleKey: string, lineId: LiveLineId) => void;
  /** A tap on the map itself (not on a marker). */
  readonly onMapPress: () => void;
};

export function TransitMap(props: TransitMapProps) {
  const { scheme, bucket, emphasis } = props;
  invariant(props.initialRegion.latitudeDelta > 0 && props.initialRegion.longitudeDelta > 0, 'the map opens on a visible area');
  // The lines change with the zoom bucket, the layers and the focus — never with a frame tick — so
  // their element is kept between frames and the polylines' coordinates are not sent again 4× a second.
  const segments = useMemo(() => (props.segments ?? []).filter((segment) => drawsLine(emphasis, segment.lineId)), [props.segments, emphasis]);
  const lines = useMemo(() => <LinePolylines segments={segments} scheme={scheme} />, [segments, scheme]);
  const stations = props.stations.filter((station) => drawsStation(emphasis, station.mode));
  // Scheduled first, so a live vehicle is drawn above a hollow one where they meet.
  const vehicles = props.vehicles
    .filter((vehicle) => drawsVehicle(emphasis, vehicle))
    .sort((a, b) => (a.source === b.source ? 0 : a.source === 'scheduled' ? -1 : 1));
  invariant(vehicles.length <= props.vehicles.length && stations.length <= props.stations.length, 'the emphasis only ever hides');
  return (
    <MapView
      testID="transit-map"
      style={StyleSheet.absoluteFill}
      initialRegion={props.initialRegion}
      {...MAP_RENDER_PROPS}
      onRegionChangeComplete={(region: Region) => props.onRegionChange(region)}
      onPress={(event: MapPressEvent) => onMapTap(event, props.onMapPress)}>
      {lines}
      {stations.map((station) => (
        <StationMarker key={station.stationKey} station={station} selected={station.stationKey === props.selectedStationKey} bucket={bucket} scheme={scheme} onPress={props.onStationPress} />
      ))}
      {vehicles.map((vehicle) => (
        <VehicleMarker key={vehicle.key} vehicle={vehicle} scheme={scheme} onPress={props.onVehiclePress} />
      ))}
    </MapView>
  );
}

/** A tap on the map: MapKit also reports taps that landed on a marker; only a tap on the map itself counts. */
function onMapTap(event: MapPressEvent, onMapPress: () => void): void {
  invariant(typeof onMapPress === 'function', 'a map tap has a handler');
  invariant(event.nativeEvent !== undefined, 'a map tap carries its native event');
  if (event.nativeEvent.action !== 'marker-press') {
    onMapPress();
  }
}
