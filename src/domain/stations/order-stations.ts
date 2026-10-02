import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';

/**
 * R7 (the useful Stations tab): which station to show first. With the rider's location, nearest
 * first, each with its walking distance; without one, the order the stations came in (the list's
 * line-then-name order), identical on every call, with no distance.
 *
 * `walkingMeters` is the STRAIGHT-LINE distance to the station: it orders the list and is never a walk time
 * (the hurry engine walks street-routed metres when the app knows them, mfix9, else the straight line with its
 * own detour factor). Ties keep the input order (a stable sort), so equal distances never reshuffle between calls.
 */

export type OrderedStation<S> = { readonly station: S; readonly walkingMeters: number | null };

export function orderStations<S extends LatLon>(stations: readonly S[], location: LatLon | null): readonly OrderedStation<S>[] {
  invariant(stations.every((station) => isLatLon(station)), 'every station sits on a real coordinate');
  invariant(location === null || isLatLon(location), 'a location is a real coordinate, or none');
  const rows = stations.map((station) => ({ station, walkingMeters: location === null ? null : haversineMeters(location, station) }));
  if (location !== null) {
    rows.sort((a, b) => (a.walkingMeters as number) - (b.walkingMeters as number));
  }
  invariant(rows.length === stations.length, 'every station is listed exactly once');
  invariant(rows.every((row, i) => i === 0 || location === null || (row.walkingMeters as number) >= (rows[i - 1]?.walkingMeters as number)), 'nearest first');
  return rows;
}
