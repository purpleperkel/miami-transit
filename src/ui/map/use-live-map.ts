import { useCallback, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import scheduleManifest from '@/assets/db/manifest.json';
import { useScheduleDb } from '@/data/schedule-db-provider';
import type { LiveLineId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import { useLive } from '@/live/live-context';

import type { ColorScheme } from '../colors';
import { type DataStatus, dataStatus, statusConditions } from '../dataStatus';
import { focusAfterTap, type MapFocus, mapEmphasis, NO_FOCUS } from './emphasis';
import { useLayers } from './layers-store';
import { type MapRegion, zoomBucket } from './mapGeometry';
import { framesInLanes, markerLanes, NO_LANES } from './markerLanes';
import type { TransitMapProps } from './TransitMap';
import { useLineGeometry } from './use-line-geometry';
import { useFrameTick, useVehicleFrames } from './useVehicleFrames';

/**
 * The Map tab's wiring (plan M5.12): everything TransitMap and the status pill show, read from the
 * app's contexts — the bundled schedule DB (useScheduleDb: lines, stations, the timetable behind the
 * scheduled vehicles, each trip's destination), the live runtime (useLive: live vehicles and the
 * chain's status), the layers store, the Map tab's focus and Reduce Motion. The zoom bucket lives
 * here, so each frame's markers are shifted into their line's lane here (mfix3 §3, markerLanes.ts).
 */

export type LiveMap = {
  readonly map: TransitMapProps;
  /** The data status at the latest frame; null until the first frame is drawn. */
  readonly status: DataStatus | null;
  readonly reduceMotion: boolean;
};

export function useLiveMap(initialRegion: MapRegion): LiveMap {
  const db = useScheduleDb();
  const repo = db.kind === 'ready' ? db.repo : null;
  const live = useLive().state;
  const { tickMs, reduceMotion } = useFrameTick();
  // Markers take their lanes from the lines as drawn (markerLanes.ts), laid once per schedule DB.
  const lanes = useMemo(() => (repo === null ? NO_LANES : markerLanes(repo.liveNetwork().tracks)), [repo]);
  const frames = useVehicleFrames(repo, live?.vehicles ?? null, tickMs, Date.now, lanes);
  const [bucket, setBucket] = useState(() => zoomBucket(initialRegion.latitudeDelta));
  const vehicles = useMemo(() => framesInLanes(frames.vehicles, bucket), [frames.vehicles, bucket]);
  const tripDestinations = useMemo(() => repo?.tripDestinations(), [repo]);
  const [focus, setFocus] = useState<MapFocus>(NO_FOCUS);
  const [selectedStationKey, setSelectedStationKey] = useState<string | null>(null);
  const { layers } = useLayers();
  const emphasis = useMemo(() => mapEmphasis(layers, focus), [layers, focus]);
  const segments = useLineGeometry(bucket, emphasis.dimmed);
  const stations = useMemo(() => repo?.stations() ?? [], [repo]);
  const handlers = useMapHandlers(setFocus, setSelectedStationKey);
  const scheme = useMapScheme();
  // Judged at the latest frame's instant; before the first frame there is no status to claim.
  const status =
    frames.atS === null
      ? null
      : dataStatus(
          statusConditions({ serviceEnds: scheduleManifest.serviceEnd, vehicles: live?.vehicles ?? null, vehiclesStatus: live?.status.vehicles ?? null, nowS: frames.atS }),
        );
  invariant(segments === null || segments.length > 0, 'an open schedule has lines to draw');
  const map: TransitMapProps = {
    scheme,
    initialRegion,
    bucket,
    segments,
    stations,
    vehicles,
    emphasis,
    selectedStationKey,
    onRegionChange: (region: MapRegion) => setBucket(zoomBucket(region.latitudeDelta)),
    ...handlers,
    tripDestinations,
  };
  invariant(map.vehicles.length === frames.vehicles.length, 'the map draws every vehicle of the latest frame, each in its lane');
  return { map, status, reduceMotion };
}

type MapHandlers = Pick<TransitMapProps, 'onStationPress' | 'onVehiclePress' | 'onMapPress'>;

/**
 * Taps: a vehicle puts its line in focus (again: out of focus), a station is selected (again:
 * deselected), the map itself clears both. Stable handlers, so markers do not re-render for them.
 */
function useMapHandlers(
  setFocus: (update: (focus: MapFocus) => MapFocus) => void,
  setSelected: (update: (key: string | null) => string | null) => void,
): MapHandlers {
  invariant(typeof setFocus === 'function' && typeof setSelected === 'function', 'taps change the focus and the selection');
  const onVehiclePress = useCallback((_vehicleKey: string, lineId: LiveLineId) => setFocus((focus) => focusAfterTap(focus, lineId)), [setFocus]);
  const onStationPress = useCallback((stationKey: string) => setSelected((key) => (key === stationKey ? null : stationKey)), [setSelected]);
  const onMapPress = useCallback(() => {
    setFocus(() => NO_FOCUS);
    setSelected(() => null);
  }, [setFocus, setSelected]);
  invariant(typeof onVehiclePress === 'function' && typeof onMapPress === 'function', 'every tap has a handler');
  return { onVehiclePress, onStationPress, onMapPress };
}

/** The colour scheme the map is drawn in: the system's, light when it says nothing. */
function useMapScheme(): ColorScheme {
  const system = useColorScheme();
  const scheme: ColorScheme = system === 'dark' ? 'dark' : 'light';
  invariant(scheme === 'light' || scheme === 'dark', 'the map is drawn light or dark');
  invariant(system !== 'dark' || scheme === 'dark', 'a dark system gets a dark map');
  return scheme;
}
