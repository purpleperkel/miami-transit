import type { CalendarGap, DeparturesOutcome, UnknownStation } from '../../data/schedule-repo';
import type { StationListing } from '../../data/schedule-queries';
import { type TimeWindow, windowFrom } from '../../domain/gtfs/service-day';
import { LINE_IDS, type LineId } from '../../domain/lines/line-catalog';
import type { Departure } from '../../domain/schedule/departures';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import { copy } from '../copy';

/**
 * The station sheet's model (plan M6.4): the station, the lines that stop there, and its scheduled
 * departures in one group per DIRECTION (GTFS direction_id) — not per terminus, because one direction
 * can mix destinations: northbound at Government Center runs to Palmetto (Green) AND to the Airport
 * (Orange). A train that ends at the station is not a departure, so a terminus such as Palmetto has
 * one group. The live predictions are merged in later, by each DirectionGroup (m6a).
 *
 * The window starts SHEET_LEAD_S before now (m6a): a train due a minute ago whose prediction says it
 * leaves now still has its timetable slot to merge into; the group hides rows 30 s after they leave.
 *
 * A selector over the schedule repo, with relative imports only (no React, no Expo), so the node:test
 * suite runs this exact module against the real assets/db/schedule.db.
 */

/** The sheet's window opens this long before now. */
export const SHEET_LEAD_S = 5 * 60;
/** ...and looks this far ahead of now. */
export const SHEET_HORIZON_S = 2 * 3600;

/** What the sheet reads from the schedule repo (ScheduleRepo). */
export type StationSheetSource = {
  stations(): readonly StationListing[];
  stationLines(): ReadonlyMap<string, readonly LineId[]>;
  departures(stationKey: string, window: TimeWindow): Result<DeparturesOutcome, UnknownStation>;
};

/** One direction's scheduled departures, earliest first, under a heading naming where they go. */
export type DirectionGroupModel = { readonly directionId: number; readonly title: string; readonly departures: readonly Departure[] };

export type StationSheetModel =
  | {
      readonly kind: 'sheet';
      readonly station: StationListing;
      readonly lines: readonly LineId[];
      /** The window the departures were read for (DirectionGroup merges predictions against it). */
      readonly window: TimeWindow;
      /** One group per direction with a departure in the window, in direction order. */
      readonly groups: readonly DirectionGroupModel[];
    }
  | { readonly kind: 'gap'; readonly station: StationListing; readonly lines: readonly LineId[]; readonly gap: CalendarGap }
  | { readonly kind: 'unknown-station'; readonly stationKey: string };

/** The sheet for `stationKey` at `nowS`. */
export function stationSheet(source: StationSheetSource, stationKey: string, nowS: number): StationSheetModel {
  invariant(stationKey.length > 0, 'a sheet belongs to a station');
  invariant(Number.isSafeInteger(nowS), `a sheet is read at a whole epoch second, got ${nowS}`);
  const station = source.stations().find((candidate) => candidate.stationKey === stationKey);
  const window = windowFrom(nowS - SHEET_LEAD_S, SHEET_LEAD_S + SHEET_HORIZON_S);
  const read = station === undefined ? null : source.departures(stationKey, window);
  if (station === undefined || read === null || !read.ok) {
    return { kind: 'unknown-station', stationKey };
  }
  const lines = source.stationLines().get(stationKey) ?? [];
  if (read.value.kind !== 'departures') {
    return { kind: 'gap', station, lines, gap: read.value };
  }
  return { kind: 'sheet', station, lines, window, groups: groupByDirection(read.value.departures) };
}

/** Departures grouped by direction_id, each group titled by its destinations (directionTitle). */
export function groupByDirection(departures: readonly Departure[]): DirectionGroupModel[] {
  invariant(departures.every((d, i) => i === 0 || (departures[i - 1] as Departure).epoch <= d.epoch), 'departures come in time order');
  const byDirection = new Map<number, Departure[]>();
  for (const departure of departures) {
    byDirection.set(departure.directionId, [...(byDirection.get(departure.directionId) ?? []), departure]);
  }
  const groups = [...byDirection].sort(([a], [b]) => a - b).map(([directionId, list]) => ({ directionId, title: directionTitle(list), departures: list }));
  invariant(groups.reduce((n, group) => n + group.departures.length, 0) === departures.length, 'every departure is in its direction\'s group');
  return groups;
}

/**
 * A direction's heading names every destination in it, in LINE order (then by name) — not in the
 * order trains happen to leave, so the heading holds still as trains go: "To Palmetto or Miami
 * International Airport" (Green before Orange) at every minute of the day.
 */
export function directionTitle(departures: readonly Departure[]): string {
  invariant(departures.length > 0, 'a direction group has departures');
  const firstLine = new Map<string, number>();
  for (const d of departures) {
    firstLine.set(d.destName, Math.min(firstLine.get(d.destName) ?? Infinity, lineRank(d.lineId)));
  }
  const names = [...firstLine].sort(([a, ra], [b, rb]) => ra - rb || (a < b ? -1 : a > b ? 1 : 0)).map(([name]) => name);
  invariant(names.length === new Set(departures.map((d) => d.destName)).size, 'every destination is named once');
  return copy.toward(names);
}

/** A line's place in the catalog's order; a line the catalog does not know sorts last. */
function lineRank(lineId: string): number {
  invariant(lineId.length > 0, 'a departure runs a line');
  const rank = LINE_IDS.findIndex((id) => id === lineId);
  invariant(rank < LINE_IDS.length, 'a rank is a catalog position');
  return rank === -1 ? LINE_IDS.length : rank;
}
