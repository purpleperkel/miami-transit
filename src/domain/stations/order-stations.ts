import { haversineMeters, isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';

/**
 * R7 (the useful Stations tab): which station to show first. With the rider's location, nearest
 * first, each with its walking distance; without one, the order the stations came in (the list's
 * line-then-name order), identical on every call, with no distance.
 *
 * `walkingMeters` is the STRAIGHT-LINE distance to the station — the same walkMeters the hurry engine
 * takes (plan M7c.1), which applies its own detour factor to turn it into a walk time. Ties keep the
 * input order (a stable sort), so equal distances never reshuffle between calls.
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
