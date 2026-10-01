import { linesOfRoute } from '../../domain/lines/line-catalog';
import { TRUNK_LINE_OF_ROUTE } from '../../domain/live/constants';
import { type LiveLineId, TRUNK_LINE_IDS } from '../../domain/live/types';
import type { Mode } from '../../domain/network/stations';
import { invariant } from '../../lib/invariant';
import { LINE_PALETTE } from '../colors';
import type { LayersState } from './layers';
import { modeOfLine } from './lineLayout';

/**
 * What the map draws, and what it draws strongly (plan M5.12). Two inputs decide it:
 *  - the LAYERS (layers.ts, the Layers sheet): a mode, the stations, the vehicles or the scheduled
 *    vehicles switched off are not drawn at all;
 *  - the FOCUS: tapping a vehicle puts its line in focus, and every other line is dimmed to 0.3 alpha
 *    (LinePolylines' dim) until the same line is tapped again. A train on the shared trunk, whose line
 *    is unknown, focuses both lines of its trunk.
 * Pure; the dimmed set keeps its identity for as long as the inputs do (memoise the call), as
 * useLineGeometry requires.
 */

export type MapFocus = { readonly kind: 'none' } | { readonly kind: 'lines'; readonly lineIds: ReadonlySet<LiveLineId> };
export const NO_FOCUS: MapFocus = Object.freeze({ kind: 'none' });

const ALL_LINES = Object.keys(LINE_PALETTE) as LiveLineId[];

/** The lines a vehicle of `lineId` may be running: itself, or for a trunk vehicle the lines of its trunk too. */
export function linesOfVehicle(lineId: LiveLineId): ReadonlySet<LiveLineId> {
  invariant(ALL_LINES.includes(lineId), `"${lineId}" is a line the map draws`);
  const route = [...TRUNK_LINE_OF_ROUTE].find(([, trunk]) => trunk === lineId)?.[0];
  const lines = new Set<LiveLineId>([lineId, ...(route === undefined ? [] : linesOfRoute(route).map((line) => line.id))]);
  invariant(!(TRUNK_LINE_IDS as readonly string[]).includes(lineId) || lines.size > 1, 'a trunk stands for more than one line');
  return lines;
}

/** The focus after tapping a vehicle of `lineId`: its line(s) in focus, or none when they already were. */
export function focusAfterTap(focus: MapFocus, lineId: LiveLineId): MapFocus {
  invariant(focus.kind === 'none' || focus.lineIds.size > 0, 'a focus names at least one line');
  const lines = linesOfVehicle(lineId);
  const same = focus.kind === 'lines' && focus.lineIds.size === lines.size && [...lines].every((id) => focus.lineIds.has(id));
  const next: MapFocus = same ? NO_FOCUS : { kind: 'lines', lineIds: lines };
  invariant(next.kind === 'none' || next.lineIds.has(lineId), 'a tapped vehicle\'s line is in focus');
  return next;
}

export type MapEmphasis = {
  /** Modes whose lines, stations and vehicles are drawn. */
  readonly modes: ReadonlySet<Mode>;
  readonly stations: boolean;
  readonly vehicles: boolean;
  /** Scheduled (hollow) vehicles are drawn — only while vehicles are. */
  readonly scheduled: boolean;
  /** Lines drawn dimmed: every line out of focus. */
  readonly dimmed: ReadonlySet<LiveLineId>;
};

export function mapEmphasis(layers: LayersState, focus: MapFocus): MapEmphasis {
  invariant(typeof layers.rail === 'boolean' && typeof layers.mover === 'boolean', 'the layers say which modes are drawn');
  const modes = new Set<Mode>([...(layers.rail ? (['rail'] as const) : []), ...(layers.mover ? (['mover'] as const) : [])]);
  const dimmed = new Set<LiveLineId>(focus.kind === 'none' ? [] : ALL_LINES.filter((id) => !focus.lineIds.has(id)));
  const emphasis: MapEmphasis = { modes, stations: layers.stations, vehicles: layers.vehicles, scheduled: layers.vehicles && layers.scheduled, dimmed };
  invariant(focus.kind === 'none' || [...focus.lineIds].every((id) => !dimmed.has(id)), 'no line in focus is dimmed');
  return emphasis;
}

/** Whether a line of `lineId` is drawn. */
export function drawsLine(emphasis: MapEmphasis, lineId: LiveLineId): boolean {
  invariant(ALL_LINES.includes(lineId), `"${lineId}" is a line the map draws`);
  const drawn = emphasis.modes.has(modeOfLine(lineId));
  invariant(typeof drawn === 'boolean', 'a line is drawn or not');
  return drawn;
}

/** Whether a station of `mode` is drawn. */
export function drawsStation(emphasis: MapEmphasis, mode: Mode): boolean {
  invariant(mode === 'rail' || mode === 'mover', `"${mode}" is a mode`);
  const drawn = emphasis.stations && emphasis.modes.has(mode);
  invariant(!drawn || emphasis.stations, 'stations are drawn only with the stations layer');
  return drawn;
}

/** Whether a vehicle is drawn: its mode, the vehicles layer, and for a scheduled one the scheduled layer. */
export function drawsVehicle(emphasis: MapEmphasis, vehicle: { readonly mode: Mode; readonly source: 'live' | 'scheduled' }): boolean {
  invariant(vehicle.source === 'live' || vehicle.source === 'scheduled', 'a vehicle is live or scheduled');
  const drawn = emphasis.vehicles && emphasis.modes.has(vehicle.mode) && (vehicle.source === 'live' || emphasis.scheduled);
  invariant(!drawn || emphasis.vehicles, 'vehicles are drawn only with the vehicles layer');
  return drawn;
}
