import { invariant } from '../../lib/invariant';
import type { DepartureRow } from '../live/merge-departures';
import type { HurryDeparture } from './verdict';

/**
 * Plan M7c.3 "departures come from schedule + live merge": the departures the verdict weighs, from m4a's
 * merged board (src/domain/live/merge-departures.ts) at the platforms the rider is walking to.
 *
 * The merged board keeps rows a rider cannot board, and every one of them is dropped here, or it would
 * use up one of the verdict's three judged departures (verdict.ts MAX_JUDGED):
 *  - CANCELED rows — merge rule 6 keeps them, struck through, so the rider sees the train is not coming;
 *  - rows at OTHER platforms of the station (the other direction, or the other Mover loop);
 *  - rows already gone (epoch before now).
 * What stays is mapped to the engine's departure: live rows are `stale` when the caller says the live
 * data is past its provider's fresh limit (providerConfig(provider).freshS). Pure.
 */

export type HurryBoardOptions = {
  /** The platforms (stop_ids) the rider is walking to. */
  readonly stopIds: readonly string[];
  /** Now, epoch s. */
  readonly now: number;
  /** The live predictions behind the board are older than their provider's fresh limit. */
  readonly liveStale: boolean;
};

export function hurryDepartures(rows: readonly DepartureRow[], opts: HurryBoardOptions): HurryDeparture[] {
  invariant(Number.isFinite(opts.now), 'the board is read at an instant');
  invariant(opts.stopIds.every((stopId) => stopId.length > 0), 'every platform is a stop_id');
  const stops = new Set(opts.stopIds);
  const boardable = rows.filter((row) => !row.canceled && row.stopId !== null && stops.has(row.stopId) && row.epoch >= opts.now);
  const sorted = [...boardable].sort((a, b) => a.epoch - b.epoch);
  const departures = sorted.map((row) => toHurryDeparture(row, opts.liveStale));
  invariant(departures.every((d, i) => d.epoch >= opts.now && (i === 0 || (departures[i - 1] as HurryDeparture).epoch <= d.epoch)), 'departures are still to leave, earliest first');
  invariant(departures.every((d) => !d.stale || d.live), 'only live data is ever stale');
  return departures;
}

/** A boardable row as the engine weighs it: live rows are stale exactly when the live data is. */
function toHurryDeparture(row: DepartureRow, liveStale: boolean): HurryDeparture {
  invariant(!row.canceled && Number.isFinite(row.epoch), 'only a boardable row becomes a departure');
  const departure = { key: row.key, epoch: row.epoch, live: row.live, lineId: row.lineId, headsign: row.destName, stale: row.live && liveStale };
  invariant(departure.stale === (row.live && liveStale), 'a departure is stale only on stale live data');
  return departure;
}
