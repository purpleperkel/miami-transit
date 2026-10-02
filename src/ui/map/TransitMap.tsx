import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { type Region } from 'react-native-maps';

import type { StationListing } from '@/data/schedule-queries';
import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';

import type { ColorScheme } from '../colors';
import { SPACING } from '../tokens';
import { drawsLine, drawsStation, drawsVehicle, type MapEmphasis } from './emphasis';
import { useFollowCamera } from './follow';
import type { LineSegment } from './lineLayout';
import { LinePolylines } from './LinePolylines';
import { MapCaption } from './MapCaption';
import { MapControlStack } from './MapControlStack';
import type { MapRegion, ZoomBucket } from './mapGeometry';
import { MapLegend } from './MapLegend';
import { captionText } from './mapTaps';
import { ModeStatusChip } from './ModeStatusChip';
import { StationMarker } from './StationMarker';
import { useMapTaps } from './use-map-taps';
import { type UserLocation, useUserLocation } from './use-user-location';
import type { VehicleFrame } from './vehicleFrames';
import { VehicleMarker } from './VehicleMarker';
import { MIN_HIT_AREA_PT } from './vehicleVisual';

/**
 * The map is the app (plan §4 "UX system", M5.12): full-bleed MapKit in `mutedStandard`, with points
 * of interest, buildings and pitch off, drawing the lines (LinePolylines), the stations
 * (StationMarker) and the moving vehicles (VehicleMarker) — each filtered and dimmed by the emphasis
 * (layers + focus). Every piece of schedule and live data arrives as a prop; use-live-map.ts reads the
 * schedule DB and the live context and wires them in — all but the mode-status chip (mfix4), which reads
 * its own. `pointsOfInterestFilter` is never set, because it overrides `showsPointsOfInterests`.
 *
 * The map's own interactions live here too (mfix3 §5): a caption naming what a tap hit (use-map-taps),
 * the floating control stack with the legend (ⓘ) and locate-me buttons, the legend sheet, and
 * you-are-here — the blue dot once location is granted (use-user-location). Every marker tap still
 * reaches the caller's handler (use-live-map opens the station / vehicle sheet, M6.4 / M6.6), and the
 * camera follows the vehicle the vehicle sheet asked for (follow.ts) until the rider moves the map.
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
  /** Each vehicle as drawn: in its line's lane at this bucket (markerLanes.ts). */
  readonly vehicles: readonly VehicleFrame[];
  readonly emphasis: MapEmphasis;
  readonly selectedStationKey: string | null;
  readonly onRegionChange: (region: MapRegion) => void;
  readonly onStationPress: (stationKey: string) => void;
  /** A tap on a vehicle: its key, and the line it runs. */
  readonly onVehiclePress: (vehicleKey: string, lineId: LiveLineId) => void;
  /** A tap on the map itself (not on a marker). */
  readonly onMapPress: () => void;
  /** trip id → the station key of its last stop, so a tapped vehicle says where it is going; absent, it does not. */
  readonly tripDestinations?: ReadonlyMap<string, string>;
  /** How far below the top of the map the floating controls start (the safe-area inset and a margin); 0 when absent. */
  readonly controlsTopPt?: number;
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
  // ONE MapView ref: locate-me (mfix3 §5) and follow mode (M6.6) both move this camera.
  const mapRef = useRef<MapView>(null);
  const { location, locate } = useUserLocation();
  const taps = useMapTaps({ segments, bucket, onStationPress: props.onStationPress, onVehiclePress: props.onVehiclePress, onMapPress: props.onMapPress, location, locate, mapRef });
  // Follow mode: the camera glides to the followed vehicle each frame; the rider's own gesture — a pan, a
  // double-tap zoom, or locate-me, which moves the camera elsewhere — ends it.
  const { onUserGesture } = useFollowCamera(mapRef, vehicles);
  const { onLocate: locateMe } = taps;
  const onLocate = useCallback(() => {
    onUserGesture();
    locateMe();
  }, [onUserGesture, locateMe]);
  return (
    <>
      <MapView
        ref={mapRef}
        testID="transit-map"
        style={StyleSheet.absoluteFill}
        initialRegion={props.initialRegion}
        {...MAP_RENDER_PROPS}
        showsUserLocation={location.kind === 'granted'}
        onRegionChangeComplete={(region: Region) => props.onRegionChange(region)}
        onPanDrag={onUserGesture}
        onDoublePress={onUserGesture}
        onPress={taps.onMapPress}>
        {lines}
        {stations.map((station) => (
          <StationMarker key={station.stationKey} station={station} selected={station.stationKey === props.selectedStationKey} bucket={bucket} scheme={scheme} onPress={taps.onStationPress} />
        ))}
        {vehicles.map((vehicle) => (
          <VehicleMarker key={vehicle.key} vehicle={vehicle} scheme={scheme} onPress={taps.onVehiclePress} />
        ))}
      </MapView>
      <MapChrome
        props={props}
        location={location}
        caption={taps.caption === null ? null : captionText(taps.caption, { stations: props.stations, vehicles: props.vehicles, tripDestinations: props.tripDestinations })}
        onLocate={onLocate}
        onDismiss={taps.dismiss}
      />
    </>
  );
}

type MapChromeProps = {
  readonly props: TransitMapProps;
  readonly location: UserLocation;
  readonly caption: string | null;
  readonly onLocate: () => void;
  readonly onDismiss: () => void;
};

/**
 * What floats over the map: the control stack (top right); below the status pill, the caption — or, with
 * no caption up, the mode-status chip (mfix4); and the legend sheet when open.
 */
function MapChrome({ props, location, caption, onLocate, onDismiss }: MapChromeProps) {
  const [legendOpen, setLegendOpen] = useState(false);
  const openLegend = useCallback(() => setLegendOpen(true), []);
  const closeLegend = useCallback(() => setLegendOpen(false), []);
  const topPt = props.controlsTopPt ?? 0;
  invariant(Number.isFinite(topPt) && topPt >= 0, 'the controls sit on the map');
  invariant(caption === null || caption.length > 0, 'a caption says something');
  return (
    <>
      <View pointerEvents="box-none" style={[styles.controls, { top: topPt }]}>
        <MapControlStack onLegend={openLegend} onLocate={onLocate} />
      </View>
      {caption === null ? null : <MapCaption text={caption} topPt={topPt + MIN_HIT_AREA_PT + SPACING.xs} onDismiss={onDismiss} />}
      {caption === null ? <ModeStatusChip topPt={topPt + MIN_HIT_AREA_PT + SPACING.xs} /> : null}
      {legendOpen ? <MapLegend scheme={props.scheme} location={location} onClose={closeLegend} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  controls: { position: 'absolute', right: SPACING.md },
});
