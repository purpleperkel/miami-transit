import { invariant } from '../../lib/invariant';

/**
 * Plan M7.1 "Walk estimate": how long the walk to the boarding station takes, for a trip's leave-by.
 *
 * The estimate is the straight-line (haversine) distance × a street detour, at a walking pace
 * (plan R13: "Haversine × 1.3 walk estimate"). The defaults — a 1.3× detour at 1.3 m/s — come to
 * one second per straight-line metre, deliberately a little slower than the hurry-or-chill walk
 * (1.35 m/s, src/ui/settings/walking-pace.ts): leave-by plans ahead, where leaving late costs a train.
 * A caller may pass Jamie's own pace instead.
 *
 * When the estimate is wrong for a trip (R13's falsifier: off by > 30 %), a per-trip override in
 * whole minutes wins outright.
 */

/** Streets run about 1.3× the straight line (plan R13). */
export const WALK_DETOUR = 1.3;
/** The planning pace, metres per second: with WALK_DETOUR, one second per straight-line metre. */
export const PLANNING_WALK_MPS = 1.3;
/** A per-trip override longer than this is a typo, not a walk to a station. */
export const MAX_WALK_OVERRIDE_MIN = 180;

export type WalkInput = {
  /** Straight-line metres from the start to the boarding station; null when no start is known. */
  readonly straightMeters: number | null;
  /** The trip's walk override in whole minutes (plan R13); null or absent = estimate from the distance. */
  readonly overrideMin?: number | null;
  /** Walking pace in m/s; defaults to PLANNING_WALK_MPS. */
  readonly paceMps?: number;
  /** Street detour factor; defaults to WALK_DETOUR. */
  readonly detour?: number;
};

export type WalkEstimate = {
  /** Whole seconds of walking. */
  readonly walkS: number;
  /** Where the number came from: the trip's override, or the distance estimate. */
  readonly source: 'override' | 'distance';
};

/** The walk in whole seconds — the override if the trip has one, else the distance estimate; null when neither is known. */
export function estimateWalk(input: WalkInput): WalkEstimate | null {
  const override = input.overrideMin ?? null;
  invariant(override === null || isWalkOverride(override), `a walk override is 0–${MAX_WALK_OVERRIDE_MIN} whole minutes, got ${override}`);
  invariant(input.straightMeters === null || (Number.isFinite(input.straightMeters) && input.straightMeters >= 0), 'a distance is finite metres');
  if (override !== null) {
    return { walkS: override * 60, source: 'override' };
  }
  if (input.straightMeters === null) {
    return null;
  }
  const walkS = walkSeconds(input.straightMeters, input.paceMps ?? PLANNING_WALK_MPS, input.detour ?? WALK_DETOUR);
  return { walkS, source: 'distance' };
}

/** Seconds to walk `straightMeters` of straight line along streets `detour`× as long, at `paceMps`, rounded to whole seconds. */
export function walkSeconds(straightMeters: number, paceMps: number, detour: number): number {
  invariant(Number.isFinite(straightMeters) && straightMeters >= 0, `a distance is finite metres, got ${straightMeters}`);
  invariant(Number.isFinite(paceMps) && paceMps > 0, `a walking pace is positive, got ${paceMps}`);
  invariant(Number.isFinite(detour) && detour >= 1, `a detour never shortens the walk, got ${detour}`);
  const walkS = Math.round((straightMeters * detour) / paceMps);
  invariant(Number.isSafeInteger(walkS) && walkS >= 0, 'a walk is whole seconds');
  return walkS;
}

/** Whole minutes, 0 up to MAX_WALK_OVERRIDE_MIN. */
export function isWalkOverride(minutes: number): boolean {
  invariant(typeof minutes === 'number', 'an override is a number of minutes');
  const valid = Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= MAX_WALK_OVERRIDE_MIN;
  invariant(!valid || Number.isSafeInteger(minutes * 60), 'a valid override converts to whole seconds');
  return valid;
}
