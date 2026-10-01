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
