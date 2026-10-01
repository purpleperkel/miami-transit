import { lineById } from '../domain/lines/line-catalog';
import type { LiveLineId } from '../domain/live/types';
import type { Mode } from '../domain/network/stations';
import { invariant } from '../lib/invariant';

/**
 * Words VoiceOver reads for map and list facts (plan §4 accessibility: every map fact is also
 * reachable from the Stations tab, and never by colour alone). The list row and the map marker of a
 * station say the same thing.
 */

/** The system a mode belongs to, as riders name it. */
export const MODE_NAMES: Readonly<Record<Mode, string>> = { rail: 'Metrorail', mover: 'Metromover' };

/** "Government Center, Metrorail": the name alone is ambiguous (two stations are named Government Center, two Brickell). */
export function stationLabel(station: { readonly name: string; readonly mode: Mode }): string {
  invariant(station.name.trim().length > 0, 'a station has a display name');
  const system = MODE_NAMES[station.mode];
  invariant(system !== undefined, `"${station.mode}" is a mode riders have a name for`);
  return `${station.name}, ${system}`;
}

/** The words for a timetable position: a hollow marker is the schedule's guess, never a sighting. */
export const SCHEDULED_POSITION = 'Scheduled position';
export const LIVE_POSITION = 'live position';

/** The eight compass directions, clockwise from north (a vehicle's heading octant names one). */
export const COMPASS_WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** What riders call a vehicle of a line: "Green Line train", "Omni Metromover"; a train on the shared trunk is a "Metrorail train". */
export function vehicleName(lineId: LiveLineId): string {
  invariant(typeof lineId === 'string' && lineId.length > 0, 'a vehicle runs a named line');
  const name =
    lineId === 'RAIL_TRUNK'
      ? `${MODE_NAMES.rail} train`
      : lineId === 'MM_TRUNK'
        ? MODE_NAMES.mover
        : `${lineById(lineId).name} ${lineById(lineId).mode === 'rail' ? 'train' : MODE_NAMES.mover}`;
  invariant(name.length > 0, 'a vehicle name is never empty');
  return name;
}

/** An age in whole minutes, at least one: "2 min old" (the pill and a stale vehicle read the same words). */
export function minutesOld(ageS: number): string {
  invariant(Number.isFinite(ageS) && ageS >= 0, `an age is a non-negative number of seconds, got ${ageS}`);
  const minutes = Math.max(1, Math.floor(ageS / 60));
  invariant(Number.isSafeInteger(minutes), 'minutes are whole');
  return `${minutes} min old`;
}

export type VehicleLabelInput = {
  readonly lineId: LiveLineId;
  readonly source: 'live' | 'scheduled';
  /** The live fix's age when it is stale; null when fresh or scheduled. */
  readonly staleAgeS: number | null;
  /** Compass octant 0–7 (0 north), or null when the heading is unknown. */
  readonly octant: number | null;
};

/**
 * VoiceOver's words for a vehicle marker — never colour alone (§4): its line, whether it is a live
 * sighting or a "Scheduled position", how old a stale sighting is, and where it is heading.
 * "Orange Line train, Scheduled position, heading south"; "Inner Loop Metromover, live position, 2 min old".
 */
export function vehicleLabel(input: VehicleLabelInput): string {
  invariant(input.source === 'live' || input.staleAgeS === null, 'only a live sighting is stale');
  const heading = input.octant === null ? null : COMPASS_WORDS[input.octant];
  invariant(input.octant === null || heading !== undefined, `octant ${input.octant} is a compass direction`);
  const parts = [
    vehicleName(input.lineId),
    input.source === 'scheduled' ? SCHEDULED_POSITION : LIVE_POSITION,
    input.staleAgeS === null ? null : minutesOld(input.staleAgeS),
    heading === null || heading === undefined ? null : `heading ${heading}`,
  ];
  return parts.filter((part): part is string => part !== null).join(', ');
}
