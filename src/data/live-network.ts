import type { LiveNetwork } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { readLineTracks, readStopStations, readTripLines } from './schedule-queries';
import type { SqlExecutor } from './sql-executor';

/**
 * Plan M4.9 (arbiter wiring note 2, 2026-10-01): the schedule facts the pure live mappers take as an
 * injected LiveNetwork, read ONCE from schedule.db through the synchronous SqlExecutor —
 *   lineOfTrip     trip_id → pattern.line_id      (5,137 trips)
 *   stationOfStop  stop_id → station.station_key  (89 stops)
 *   tracks         line_shape → shape_point       (one polyline per line and shape)
 * — plus what only the runtime needs: each station's stops, because Transitland's departures are
 * asked for stop by stop (Government Center rail = stops 9512 and 9513).
 */

export type RuntimeNetwork = LiveNetwork & {
  /** The station's stop_ids, sorted; empty for a station the schedule does not have. */
  readonly stopsOfStation: (stationKey: string) => readonly string[];
};

const NO_STOPS: readonly string[] = Object.freeze([]);

/** The live runtime's network, from the schedule DB. */
export function readRuntimeNetwork(db: SqlExecutor): RuntimeNetwork {
  invariant(typeof db.all === 'function', 'the network is read through a SqlExecutor');
  const tripLines = readTripLines(db);
  const { stationOfStop, stopsOfStation } = readStopStations(db);
  const network: RuntimeNetwork = Object.freeze({
    lineOfTrip: (tripId: string) => tripLines.get(tripId) ?? null,
    stationOfStop: (stopId: string) => stationOfStop.get(stopId) ?? null,
    stopsOfStation: (stationKey: string) => stopsOfStation.get(stationKey) ?? NO_STOPS,
    tracks: Object.freeze(readLineTracks(db)),
  });
  invariant(network.tracks.length > 0 && tripLines.size > 0, 'the network knows trips and tracks');
  return network;
}
