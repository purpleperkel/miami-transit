import type { CalendarGap, NextDeparturesOutcome } from '../../data/schedule-repo';
import type { StationListing } from '../../data/schedule-queries';
import { windowFrom } from '../../domain/gtfs/service-day';
import { LINE_IDS, type LineId } from '../../domain/lines/line-catalog';
import type { Mode } from '../../domain/network/stations';
import type { Departure } from '../../domain/schedule/departures';
import { invariant } from '../../lib/invariant';
import { MODE_NAMES } from '../a11y';

/**
 * The Stations tab's model (plan M6.5 + R7): every station of the bundled schedule, in two sections —
 * Metrorail, then Metromover — each row with the lines that stop there (its line strip) and its next
 * SCHEDULED departure in each direction, from the local DB. No live prediction is ever asked for here:
 * live predictions cost one Transitland call per station per refresh, and only the open station sheet
 * makes them.
 *
 * A selector over the schedule repo, with relative imports only (no React, no Expo), so the node:test
 * suite runs this exact module against the real assets/db/schedule.db.
 */

/** How far ahead a row looks for its next departure: past the longest overnight gap in a direction is "none soon". */
export const NEXT_DEPARTURE_HORIZON_S = 3 * 3600;

/** What the list reads from the schedule repo (ScheduleRepo). */
export type StationListSource = {
  stations(): readonly StationListing[];
  stationLines(): ReadonlyMap<string, readonly LineId[]>;
  nextDepartures(window: { readonly fromEpoch: number; readonly toEpoch: number }): NextDeparturesOutcome;
};

/** A row's next departure in one direction: where it goes (the headsign) and when. */
export type NextDeparture = {
  readonly directionId: number;
  readonly headsign: string;
  /** The line it runs, when the catalog draws it. */
  readonly lineId: LineId | null;
  readonly epoch: number;
  /** The same instant as a service-day second, for its clock time beyond the hour. */
  readonly depS: number;
};

/** One row: a station (flat latitude/longitude, so orderStations can measure it), its lines, its next departures. */
export type StationRowModel = {
  readonly stationKey: string;
  readonly name: string;
  readonly mode: Mode;
  readonly latitude: number;
  readonly longitude: number;
  /** The lines stopping here, in line order: one strip segment each. */
  readonly lines: readonly LineId[];
  /** The next scheduled departure per direction, in direction order; empty when nothing leaves within the horizon. */
  readonly next: readonly NextDeparture[];
};

export type StationSection = { readonly mode: Mode; readonly title: string; readonly rows: readonly StationRowModel[] };

export type StationList = {
  readonly sections: readonly StationSection[];
  /** Why no row has a departure — the timetable has expired or not started — or null when it covers now. */
  readonly gap: CalendarGap | null;
};

const SECTION_MODES: readonly Mode[] = ['rail', 'mover'];

/** The list at `nowS`: the two sections in the repo's line-then-name order (orderStations reorders by distance). */
export function stationList(source: StationListSource, nowS: number): StationList {
  invariant(Number.isSafeInteger(nowS), `the list is read at a whole epoch second, got ${nowS}`);
  const outcome = source.nextDepartures(windowFrom(nowS, NEXT_DEPARTURE_HORIZON_S));
  const byStation = outcome.kind === 'next-departures' ? outcome.byStation : new Map<string, readonly Departure[]>();
  const lines = source.stationLines();
  const rows = source.stations().map((station) => toRow(station, lines.get(station.stationKey) ?? [], byStation.get(station.stationKey) ?? []));
  const sections = SECTION_MODES.map((mode) => ({ mode, title: MODE_NAMES[mode], rows: rows.filter((row) => row.mode === mode) }));
  invariant(sections.reduce((n, section) => n + section.rows.length, 0) === rows.length, 'every station is in its mode\'s section');
  return { sections, gap: outcome.kind === 'next-departures' ? null : outcome };
}

function toRow(station: StationListing, lines: readonly LineId[], departures: readonly Departure[]): StationRowModel {
  invariant(new Set(departures.map((d) => d.directionId)).size === departures.length, `${station.stationKey}: one departure per direction`);
  invariant(lines.length > 0, `${station.stationKey} is served by a line`);
  const next = departures.map((d) => ({ directionId: d.directionId, headsign: d.destName, lineId: LINE_IDS.find((id) => id === d.lineId) ?? null, epoch: d.epoch, depS: d.depS }));
  const { stationKey, name, mode, coordinate } = station;
  return { stationKey, name, mode, latitude: coordinate.latitude, longitude: coordinate.longitude, lines, next };
}
