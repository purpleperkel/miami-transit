import type { StationRowModel } from '../station-list';

/**
 * Shared by the Stations-tab component tests (M6.5 + R7): station rows shaped as the station-list
 * selector makes them. The stations, lines and headsigns are the network's real ones; the times are
 * synthetic (Wednesday 2026-09-30 08:00 New York = 1 790 769 600), as are the rider's positions.
 */

/** 08:00 Wednesday 2026-09-30 as an epoch second, and as a second of its service day. */
export const WED_0800 = 1_790_769_600;
export const WED_0800_S = 28_800;

/** Government Center (rail): Green + Orange, one departure each way. */
export const GOVERNMENT_CENTER_ROW: StationRowModel = {
  stationKey: 'rail:government-ctr',
  name: 'Government Center',
  mode: 'rail',
  latitude: 25.7745,
  longitude: -80.1957,
  lines: ['GREEN', 'ORANGE'],
  next: [
    { directionId: 0, headsign: 'Dadeland South', lineId: 'GREEN', epoch: WED_0800 + 60, depS: WED_0800_S + 60 },
    { directionId: 1, headsign: 'Palmetto', lineId: 'GREEN', epoch: WED_0800 + 240, depS: WED_0800_S + 240 },
  ],
};
