import { type RefObject, useCallback, useRef, useState } from 'react';
import type MapView from 'react-native-maps';
import type { MapPressEvent } from 'react-native-maps';

import type { LiveLineId } from '@/domain/live/types';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';
import type { Result } from '@/lib/result';
import { detach } from '@/live/detach';

import type { LineSegment } from './lineLayout';
import type { ZoomBucket } from './mapGeometry';
import { locationLine } from './MapLegend';
import { type Caption, linesNear } from './mapTaps';
import type { UserLocation } from './use-user-location';

/**
 * The map's taps (mfix3 §5): each tap still reports what it hit — the station key, the vehicle and its
 * line, a press on the map — exactly as before (focus, selection and m6b's sheets hang off those), and
 * now also puts a CAPTION up naming it: the station, the vehicle, or every line drawn within the tap
 * tolerance of a map press (mapTaps.ts linesNear). A press that names nothing clears the caption.
 *
 * On Apple Maps the map's own tap recognizer also fires for a tap on a marker (react-native-maps 1.27.2
 * ios/AirMaps/AIRMapManager.m: a UITapGestureRecognizer on the whole map, `cancelsTouchesInView = NO`,
 * its event without the Android-only `action`), so a map press within MARKER_ECHO_MS of a marker press
 * is that same tap and is ignored — it must not replace the marker's caption or clear its selection.
 */

/** A map press this soon after a marker press is the same tap, seen by the map. */
export const MARKER_ECHO_MS = 400;
/** Locate-me frames the user at street zoom (about 1 km tall). */
export const LOCATE_DELTA = 0.01;
const LOCATE_ANIMATION_MS = 600;

export type MapTapInputs = {
  readonly segments: readonly LineSegment[];
  readonly bucket: ZoomBucket;
  readonly onStationPress: (stationKey: string) => void;
  readonly onVehiclePress: (vehicleKey: string, lineId: LiveLineId) => void;
  readonly onMapPress: () => void;
  readonly location: UserLocation;
  readonly locate: () => Promise<Result<LatLon, string>>;
  readonly mapRef: RefObject<MapView | null>;
};

export type MapTaps = {
  readonly caption: Caption | null;
  readonly onStationPress: (stationKey: string) => void;
  readonly onVehiclePress: (vehicleKey: string, lineId: LiveLineId) => void;
  readonly onMapPress: (event: MapPressEvent) => void;
  readonly onLocate: () => void;
  readonly dismiss: () => void;
};

export function useMapTaps(inputs: MapTapInputs): MapTaps {
  const { segments, bucket, onStationPress: reportStation, onVehiclePress: reportVehicle, onMapPress: reportMap, location, locate, mapRef } = inputs;
  const [caption, setCaption] = useState<Caption | null>(null);
  const lastMarkerMs = useRef(Number.NEGATIVE_INFINITY);
  const onStationPress = useCallback((stationKey: string) => {
    lastMarkerMs.current = Date.now();
    setCaption({ kind: 'station', stationKey });
    reportStation(stationKey);
  }, [reportStation]);
  const onVehiclePress = useCallback((vehicleKey: string, lineId: LiveLineId) => {
    lastMarkerMs.current = Date.now();
    setCaption({ kind: 'vehicle', vehicleKey });
    reportVehicle(vehicleKey, lineId);
  }, [reportVehicle]);
  const onMapPress = useCallback(
    (event: MapPressEvent) => pressMap(event, { segments, bucket, lastMarkerMs: lastMarkerMs.current, setCaption, reportMap }),
    [segments, bucket, reportMap],
  );
  const onLocate = useCallback(() => locateUser(location, locate, mapRef, setCaption), [location, locate, mapRef]);
  const dismiss = useCallback(() => setCaption(null), []);
  invariant(typeof reportStation === 'function' && typeof reportVehicle === 'function' && typeof reportMap === 'function', 'every tap is still reported');
  invariant(caption === null || typeof caption.kind === 'string', 'a caption has a kind');
  return { caption, onStationPress, onVehiclePress, onMapPress, onLocate, dismiss };
}

type PressContext = {
  readonly segments: readonly LineSegment[];
  readonly bucket: ZoomBucket;
  readonly lastMarkerMs: number;
  readonly setCaption: (caption: Caption | null) => void;
  readonly reportMap: () => void;
};

/**
 * A press on the map itself: names every line drawn within the tap tolerance (none: no caption) and
 * reports the press. A press on a marker (Android's `marker-press`, or Apple Maps' echo of a marker tap)
 * is not a press on the map. A press without a coordinate names no line.
 */
function pressMap(event: MapPressEvent, context: PressContext): void {
  invariant(event.nativeEvent !== undefined, 'a map press carries its native event');
  invariant(typeof context.reportMap === 'function', 'a map press is reported');
  if (event.nativeEvent.action === 'marker-press' || Date.now() - context.lastMarkerMs < MARKER_ECHO_MS) {
    return;
  }
  const { coordinate } = event.nativeEvent as { readonly coordinate?: LatLon };
  const lineIds = coordinate !== undefined && isLatLon(coordinate) ? linesNear(context.segments, coordinate, context.bucket) : [];
  context.setCaption(lineIds.length === 0 ? null : { kind: 'lines', lineIds });
  context.reportMap();
}

/**
 * Locate-me: with location granted, reads the user's position and moves the camera there; otherwise —
 * or when the position cannot be read — says why in the caption.
 */
function locateUser(location: UserLocation, locate: () => Promise<Result<LatLon, string>>, mapRef: RefObject<MapView | null>, setCaption: (caption: Caption | null) => void): void {
  invariant(typeof locate === 'function', 'the map can read the position');
  invariant(typeof setCaption === 'function', 'locate-me can explain itself');
  if (location.kind !== 'granted') {
    setCaption({ kind: 'note', text: locationLine(location) });
    return;
  }
  detach(
    locate().then((fix) => (fix.ok ? centreOn(mapRef.current, fix.value) : cannotLocate(setCaption, fix.error))),
    (why) => cannotLocate(setCaption, why),
  );
}

/** Why the user could not be located, in the caption. */
function cannotLocate(setCaption: (caption: Caption | null) => void, why: string): void {
  invariant(typeof setCaption === 'function', 'the caption can say why');
  invariant(why.trim().length > 0, 'a failure says why');
  setCaption({ kind: 'note', text: `Can't find you — ${why}` });
}

/** Moves the camera to street zoom over `at`. */
function centreOn(map: MapView | null, at: LatLon): void {
  invariant(map !== null, 'the map is mounted when its locate button is pressed');
  invariant(isLatLon(at), 'the camera moves to a real coordinate');
  map.animateToRegion({ latitude: at.latitude, longitude: at.longitude, latitudeDelta: LOCATE_DELTA, longitudeDelta: LOCATE_DELTA }, LOCATE_ANIMATION_MS);
}
