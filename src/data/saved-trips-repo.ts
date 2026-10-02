import { isWalkOverride } from '../domain/trips/walk-estimate';
import { isLatLon, type LatLon } from '../lib/geo';
import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';
import type { WritableSqlExecutor } from './sql-executor';
import { isCurrentUserDb, USER_DB_VERSION } from './user-db';

/**
 * Plan M7.3: saved trips in the user DB (table `saved_trip`, user-db.ts migration 1). A saved trip
 * is a station pair plus what its leave-by and reminders need:
 *   - `start`: where the walk to the boarding station starts (null = wherever the phone is);
 *   - `walkOverrideMin`: the per-trip walk override (plan R13), which beats the distance estimate;
 *   - `reminder`: the days and usual departure time the "leave now" reminders (M7.4) target.
 *
 * Every write is checked first (`checkSavedTrip`) and refused as an Err, never thrown, so a bad
 * form entry is a message on screen; the table's CHECK constraints are the second line of defence.
 */

/** Bit i of `TripReminder.days` is weekday i, Monday = 0 … Sunday = 6. */
export const MONDAY_TO_FRIDAY = 0b0011111;
export const EVERY_DAY = 0b1111111;

export type TripReminder = {
  /** Weekday bitmask (bit 0 Monday … bit 6 Sunday), at least one day. */
  readonly days: number;
  /** The usual departure, minutes after local midnight: reminders target the first ride at or after it. */
  readonly atMin: number;
};

export type SavedTrip = {
  /** Stable id, 1–64 of [A-Za-z0-9_-] (it keys reminder identifiers, src/domain/trips/notification-plan.ts). */
  readonly id: string;
  readonly name: string;
  readonly fromStationKey: string;
  readonly toStationKey: string;
  readonly start: LatLon | null;
  readonly walkOverrideMin: number | null;
  readonly reminder: TripReminder | null;
  readonly createdEpoch: number;
};

export type SavedTripError = {
  readonly kind: 'invalid-trip' | 'duplicate-trip' | 'unknown-trip';
  readonly message: string;
};

const TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 60;
const MINUTES_PER_DAY = 24 * 60;

type SavedTripRow = {
  trip_id: string;
  name: string;
  from_station_key: string;
  to_station_key: string;
  start_lat: number | null;
  start_lon: number | null;
  walk_override_min: number | null;
  remind_days: number;
  remind_at_min: number | null;
  created_epoch: number;
};

const COLUMNS =
  'trip_id, name, from_station_key, to_station_key, start_lat, start_lon, walk_override_min, remind_days, remind_at_min, created_epoch';

export class SavedTripsRepo {
  private readonly db: WritableSqlExecutor;

  constructor(db: WritableSqlExecutor) {
    invariant(typeof db.run === 'function' && typeof db.transaction === 'function', 'the saved trips need a writable executor');
    invariant(isCurrentUserDb(db), `the user DB is migrated to version ${USER_DB_VERSION} (migrateUserDb) before the saved trips are used`);
    this.db = db;
  }

  /** Every saved trip, oldest first (ties by id). */
  list(): SavedTrip[] {
    const rows = this.db.all<SavedTripRow>(`SELECT ${COLUMNS} FROM saved_trip ORDER BY created_epoch, trip_id`);
    const trips = rows.map(rowToTrip);
    invariant(trips.length === rows.length, 'every row is a trip');
    invariant(trips.every((t, i) => i === 0 || trips[i - 1]!.createdEpoch <= t.createdEpoch), 'trips come oldest first');
    return trips;
  }

  /** The trip with this id, or null. */
  get(id: string): SavedTrip | null {
    invariant(id.length > 0, 'a trip is looked up by id');
    const row = this.db.get<SavedTripRow>(`SELECT ${COLUMNS} FROM saved_trip WHERE trip_id = :id`, { id });
    const trip = row === null ? null : rowToTrip(row);
    invariant(trip === null || trip.id === id, 'the trip found is the one asked for');
    return trip;
  }

  /** Save a new trip; an invalid trip or a taken id is refused and nothing is written. */
  create(trip: SavedTrip): Result<SavedTrip, SavedTripError> {
    invariant(typeof trip === 'object' && trip !== null, 'create takes a trip');
    const checked = checkSavedTrip(trip);
    if (!checked.ok) {
      return checked;
    }
    if (this.get(trip.id) !== null) {
      return err({ kind: 'duplicate-trip', message: `a trip with id "${trip.id}" is already saved` });
    }
    const inserted = this.db.run(`INSERT INTO saved_trip (${COLUMNS}) VALUES (${placeholders()})`, tripToParams(checked.value));
    invariant(inserted === 1, 'creating a trip inserts one row');
    return this.readBack(checked.value);
  }

  /** Replace a saved trip's fields (matched by id); an invalid trip or an unknown id is refused. */
  update(trip: SavedTrip): Result<SavedTrip, SavedTripError> {
    invariant(typeof trip === 'object' && trip !== null, 'update takes a trip');
    const checked = checkSavedTrip(trip);
    if (!checked.ok) {
      return checked;
    }
    const sets = COLUMNS.split(', ')
      .filter((c) => c !== 'trip_id')
      .map((c) => `${c} = :${c}`)
      .join(', ');
    const changed = this.db.run(`UPDATE saved_trip SET ${sets} WHERE trip_id = :trip_id`, tripToParams(checked.value));
    invariant(changed === 0 || changed === 1, 'an id names at most one trip');
    return changed === 0 ? err({ kind: 'unknown-trip', message: `no saved trip has id "${trip.id}"` }) : this.readBack(checked.value);
  }

  /** Delete a saved trip; true if it existed. */
  remove(id: string): boolean {
    invariant(id.length > 0, 'a trip is removed by id');
    const removed = this.db.run('DELETE FROM saved_trip WHERE trip_id = :id', { id });
    invariant(removed === 0 || removed === 1, 'an id names at most one trip');
    return removed === 1;
  }

  /** The stored copy of a trip just written — it must read back field for field. */
  private readBack(written: SavedTrip): Result<SavedTrip, SavedTripError> {
    const stored = this.get(written.id);
    invariant(stored !== null, `trip "${written.id}" was just written`);
    invariant(JSON.stringify(stored) === JSON.stringify(written), `trip "${written.id}" reads back as written`);
    return ok(stored);
  }
}

/** `trip`, trimmed and frozen, if every field is usable; otherwise why not. */
export function checkSavedTrip(trip: SavedTrip): Result<SavedTrip, SavedTripError> {
  invariant(typeof trip === 'object' && trip !== null, 'a saved trip is an object');
  const name = trip.name.trim();
  const problem = savedTripProblem({ ...trip, name });
  if (problem !== null) {
    return err({ kind: 'invalid-trip', message: problem });
  }
  const checked: SavedTrip = Object.freeze({
    id: trip.id,
    name,
    fromStationKey: trip.fromStationKey,
    toStationKey: trip.toStationKey,
    start: trip.start === null ? null : Object.freeze({ latitude: trip.start.latitude, longitude: trip.start.longitude }),
    walkOverrideMin: trip.walkOverrideMin,
    reminder: trip.reminder === null ? null : Object.freeze({ days: trip.reminder.days, atMin: trip.reminder.atMin }),
    createdEpoch: trip.createdEpoch,
  });
  invariant(savedTripProblem(checked) === null, 'a checked trip passes its own check');
  return ok(checked);
}

/** The first thing wrong with a trip, in words, or null. */
function savedTripProblem(trip: SavedTrip): string | null {
  invariant(typeof trip.name === 'string', 'a trip has a name');
  invariant(typeof trip.fromStationKey === 'string' && typeof trip.toStationKey === 'string', 'a trip names two stations');
  const checks: readonly [boolean, string][] = [
    [TRIP_ID.test(trip.id), 'a trip id is 1–64 letters, digits, "-" or "_"'],
    [trip.name.length > 0 && trip.name.length <= MAX_NAME_LENGTH, `a trip name is 1–${MAX_NAME_LENGTH} characters`],
    [trip.fromStationKey.length > 0 && trip.toStationKey.length > 0, 'a trip names its two stations'],
    [trip.fromStationKey !== trip.toStationKey, 'a trip goes between two different stations'],
    [trip.start === null || isLatLon(trip.start), 'the start is a valid coordinate'],
    [trip.walkOverrideMin === null || isWalkOverride(trip.walkOverrideMin), 'the walk override is 0–180 whole minutes'],
    [trip.reminder === null || isTripReminder(trip.reminder), 'reminders need at least one weekday and a time of day'],
    [Number.isSafeInteger(trip.createdEpoch) && trip.createdEpoch >= 0, 'the creation time is a whole epoch second'],
  ];
  return checks.find(([valid]) => !valid)?.[1] ?? null;
}

function isTripReminder(reminder: TripReminder): boolean {
  invariant(typeof reminder === 'object' && reminder !== null, 'a reminder schedule is an object');
  const { days, atMin } = reminder;
  const valid = Number.isSafeInteger(days) && days >= 1 && days <= EVERY_DAY && Number.isSafeInteger(atMin) && atMin >= 0 && atMin < MINUTES_PER_DAY;
  invariant(!valid || (days & EVERY_DAY) === days, 'a valid weekday mask uses only the seven day bits');
  return valid;
}

function placeholders(): string {
  const names = COLUMNS.split(', ').map((c) => `:${c}`);
  invariant(names.length === 10, 'one placeholder per saved_trip column');
  invariant(names.every((n) => /^:[a-z_]+$/.test(n)), 'placeholders are bare column names');
  return names.join(', ');
}

function tripToParams(trip: SavedTrip): Record<string, number | string | null> {
  invariant(trip.reminder === null || trip.reminder.days > 0, 'a stored reminder has a day');
  const params = {
    trip_id: trip.id,
    name: trip.name,
    from_station_key: trip.fromStationKey,
    to_station_key: trip.toStationKey,
    start_lat: trip.start?.latitude ?? null,
    start_lon: trip.start?.longitude ?? null,
    walk_override_min: trip.walkOverrideMin,
    remind_days: trip.reminder?.days ?? 0,
    remind_at_min: trip.reminder?.atMin ?? null,
    created_epoch: trip.createdEpoch,
  };
  invariant(Object.keys(params).join(', ') === COLUMNS, 'the parameters bind every column, in order');
  return params;
}

function rowToTrip(row: SavedTripRow): SavedTrip {
  invariant((row.start_lat === null) === (row.start_lon === null), 'a stored start has both coordinates or neither');
  invariant((row.remind_days === 0) === (row.remind_at_min === null), 'a stored reminder has days and a time, or neither');
  return Object.freeze({
    id: row.trip_id,
    name: row.name,
    fromStationKey: row.from_station_key,
    toStationKey: row.to_station_key,
    start: row.start_lat === null || row.start_lon === null ? null : Object.freeze({ latitude: row.start_lat, longitude: row.start_lon }),
    walkOverrideMin: row.walk_override_min,
    reminder: row.remind_at_min === null ? null : Object.freeze({ days: row.remind_days, atMin: row.remind_at_min }),
    createdEpoch: row.created_epoch,
  });
}
