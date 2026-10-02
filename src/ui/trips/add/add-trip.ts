import { router } from 'expo-router';

import { EVERY_DAY, MONDAY_TO_FRIDAY, type SavedTrip, type TripReminder } from '@/data/saved-trips-repo';
import { isWalkOverride, MAX_WALK_OVERRIDE_MIN } from '@/domain/trips/walk-estimate';
import { isLatLon, type LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

import { ADD_TRIP_CONFIRM_PATH, ADD_TRIP_START_PATH, ADD_TRIP_TO_PATH } from '../trip-routes';

/**
 * Plan M7.9: the add-trip flow's state, carried step to step in the route params (so each step is a real
 * screen the back button returns to, and a station sheet can open the flow at its second step):
 *
 *   from     /trip/new/from      the boarding station                      → { from }
 *   to       /trip/new/to        a destination ONE vehicle reaches (directReachable) → { from, to }
 *   start    /trip/new/start     the walk: from wherever the phone is, from here (a fixed start), or minutes
 *   confirm  /trip/new/confirm   its name and reminders → saved through the saved-trips repo
 *
 * Route params arrive as strings (or lists, or nothing); each step reads them through `readStep`, which
 * says what is missing rather than guessing.
 */

/** The walk choice made at the start step. */
export type WalkChoice =
  /** From wherever the phone is when the trip is looked at (no fixed walk: no reminders). */
  | { readonly kind: 'here-each-time' }
  /** From a fixed point (where the phone was when the trip was saved). */
  | { readonly kind: 'start'; readonly start: LatLon }
  /** A fixed number of minutes. */
  | { readonly kind: 'minutes'; readonly minutes: number };

export type AddTripStep = { readonly from: string; readonly to: string | null; readonly walk: WalkChoice | null };

/** The reminder choices the confirm step offers: none, weekdays, every day — at a time of day. */
export type ReminderDays = 'off' | 'weekdays' | 'every-day';
export const REMINDER_DAY_MASKS: Readonly<Record<Exclude<ReminderDays, 'off'>, number>> = { weekdays: MONDAY_TO_FRIDAY, 'every-day': EVERY_DAY };

type Param = string | string[] | undefined;
export type StepParams = Readonly<Partial<Record<'from' | 'to' | 'walk' | 'startLat' | 'startLon' | 'walkMin', Param>>>;

/** The one string a param holds, or null (absent, empty or a list). */
function single(param: Param): string | null {
  invariant(param === undefined || typeof param === 'string' || Array.isArray(param), 'a route param is a string, a list or absent');
  const value = typeof param === 'string' && param.length > 0 ? param : null;
  invariant(value === null || value.length > 0, 'a present param has text');
  return value;
}

/** The flow's state from a step's route params; null when even the origin is missing. */
export function readStep(params: StepParams): AddTripStep | null {
  invariant(typeof params === 'object' && params !== null, 'a step has its params');
  const from = single(params.from);
  if (from === null || !from.includes(':')) {
    return null;
  }
  const to = single(params.to);
  const step = { from, to: to !== null && to.includes(':') && to !== from ? to : null, walk: readWalk(params) };
  invariant(step.to !== step.from, 'a trip goes between two stations');
  return step;
}

/** The walk choice carried in the params (`walk` names it; minutes or a start come with it), or null. */
function readWalk(params: StepParams): WalkChoice | null {
  const kind = single(params.walk);
  const minutes = Number(single(params.walkMin) ?? Number.NaN);
  const start = { latitude: Number(single(params.startLat) ?? Number.NaN), longitude: Number(single(params.startLon) ?? Number.NaN) };
  let walk: WalkChoice | null = null;
  if (kind === 'here') {
    walk = { kind: 'here-each-time' };
  } else if (kind === 'minutes' && isWalkOverride(minutes)) {
    walk = { kind: 'minutes', minutes };
  } else if (kind === 'start' && Number.isFinite(start.latitude) && Number.isFinite(start.longitude) && isLatLon(start)) {
    walk = { kind: 'start', start };
  }
  invariant(walk === null || walk.kind !== 'minutes' || Number.isSafeInteger(walk.minutes), 'a walk in minutes is whole');
  invariant(walk === null || kind !== null, 'a walk is read only where the start step named one');
  return walk;
}

/** The params that carry a walk choice to the next step. */
function walkParams(walk: WalkChoice): Record<string, string> {
  invariant(walk.kind !== 'minutes' || isWalkOverride(walk.minutes), `a walk is 0–${MAX_WALK_OVERRIDE_MIN} whole minutes`);
  const params: Record<string, string> =
    walk.kind === 'minutes'
      ? { walk: 'minutes', walkMin: String(walk.minutes) }
      : walk.kind === 'start'
        ? { walk: 'start', startLat: String(walk.start.latitude), startLon: String(walk.start.longitude) }
        : { walk: 'here' };
  invariant(Object.values(params).every((v) => v.length > 0), 'every param has text');
  return params;
}

/** Step 1 → 2: the origin is chosen. */
export function goToDestination(from: string): void {
  invariant(from.includes(':'), `a trip leaves from a station keyed mode:name, got "${from}"`);
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push({ pathname: ADD_TRIP_TO_PATH, params: { from } });
}

/** Step 2 → 3: the destination is chosen. */
export function goToWalk(from: string, to: string): void {
  invariant(from.includes(':') && to.includes(':') && from !== to, 'a trip joins two stations');
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push({ pathname: ADD_TRIP_START_PATH, params: { from, to } });
}

/** Step 3 → 4: the walk is chosen. */
export function goToConfirm(from: string, to: string, walk: WalkChoice): void {
  invariant(from.includes(':') && to.includes(':') && from !== to, 'a trip joins two stations');
  invariant(typeof router.push === 'function', 'expo-router pushes');
  router.push({ pathname: ADD_TRIP_CONFIRM_PATH, params: { from, to, ...walkParams(walk) } });
}

export type TripDraft = {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly walk: WalkChoice;
  readonly reminderDays: ReminderDays;
  /** Minutes after midnight of the usual departure (reminders target the first ride at or after it). */
  readonly reminderAtMin: number;
  readonly createdEpoch: number;
};

/** True when the walk is fixed, so a leave-by days ahead is known and reminders can be offered. */
export function walkIsFixed(walk: WalkChoice): boolean {
  invariant(typeof walk.kind === 'string', 'a walk choice has a kind');
  const fixed = walk.kind !== 'here-each-time';
  invariant(fixed || walk.kind === 'here-each-time', 'only the walk from wherever the phone is moves');
  return fixed;
}

/** The saved trip the confirm step writes. */
export function tripOfDraft(draft: TripDraft): SavedTrip {
  invariant(draft.reminderDays === 'off' || walkIsFixed(draft.walk), 'reminders need a fixed walk');
  const reminder: TripReminder | null = draft.reminderDays === 'off' ? null : { days: REMINDER_DAY_MASKS[draft.reminderDays], atMin: draft.reminderAtMin };
  const trip: SavedTrip = {
    id: draft.id,
    name: draft.name,
    fromStationKey: draft.from,
    toStationKey: draft.to,
    start: draft.walk.kind === 'start' ? draft.walk.start : null,
    walkOverrideMin: draft.walk.kind === 'minutes' ? draft.walk.minutes : null,
    reminder,
    createdEpoch: draft.createdEpoch,
  };
  invariant(trip.fromStationKey !== trip.toStationKey, 'a trip joins two stations');
  return trip;
}
