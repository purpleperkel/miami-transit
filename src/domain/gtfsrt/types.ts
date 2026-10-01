/**
 * The decoded GTFS-realtime model (gtfs-realtime.proto, proto2).
 *
 * - Field names are the proto's lowerCamelCase names, so a decoded message reads like the spec.
 *   Repeated fields keep the proto's singular names (`entity`, `stopTimeUpdate`) and are arrays.
 * - Presence is kept: an optional field absent on the wire is `null`. Proto defaults are NOT
 *   applied (an absent `currentStatus` is null, not IN_TRANSIT_TO); consumers decide.
 * - Enums are their wire numbers (unknown future values pass through); the tables below name them.
 * - Only the fields this app uses are modelled. Everything else (alerts, shapes, occupancy,
 *   carriage details, trip properties, experimental fields) is skipped by the decoder.
 */

export type FeedMessage = {
  readonly header: FeedHeader;
  readonly entity: readonly FeedEntity[];
};

export type FeedHeader = {
  readonly gtfsRealtimeVersion: string;
  readonly incrementality: number | null;
  /** POSIX seconds (uint64). */
  readonly timestamp: number | null;
};

export type FeedEntity = {
  readonly id: string;
  readonly isDeleted: boolean | null;
  readonly tripUpdate: TripUpdate | null;
  readonly vehicle: VehiclePosition | null;
};

export type TripDescriptor = {
  readonly tripId: string | null;
  readonly routeId: string | null;
  readonly directionId: number | null;
  readonly startTime: string | null;
  readonly startDate: string | null;
  readonly scheduleRelationship: number | null;
};

export type VehicleDescriptor = {
  readonly id: string | null;
  readonly label: string | null;
  readonly licensePlate: string | null;
};

export type Position = {
  /** Degrees, WGS-84 (float). */
  readonly latitude: number;
  readonly longitude: number;
  /** Degrees clockwise from true north (float). */
  readonly bearing: number | null;
  /** Metres per second (float). */
  readonly speed: number | null;
};

export type VehiclePosition = {
  readonly trip: TripDescriptor | null;
  readonly vehicle: VehicleDescriptor | null;
  readonly position: Position | null;
  readonly currentStopSequence: number | null;
  readonly stopId: string | null;
  readonly currentStatus: number | null;
  /** POSIX seconds (uint64) when the position was measured. */
  readonly timestamp: number | null;
};

export type StopTimeEvent = {
  /** Seconds late (negative = early), int32. */
  readonly delay: number | null;
  /** POSIX seconds (int64). */
  readonly time: number | null;
  readonly uncertainty: number | null;
};

export type StopTimeUpdate = {
  readonly stopSequence: number | null;
  readonly stopId: string | null;
  readonly arrival: StopTimeEvent | null;
  readonly departure: StopTimeEvent | null;
  readonly scheduleRelationship: number | null;
};

export type TripUpdate = {
  readonly trip: TripDescriptor;
  readonly vehicle: VehicleDescriptor | null;
  readonly stopTimeUpdate: readonly StopTimeUpdate[];
  /** POSIX seconds (uint64) of the prediction. */
  readonly timestamp: number | null;
  readonly delay: number | null;
};

/** FeedHeader.Incrementality */
export const Incrementality = { FULL_DATASET: 0, DIFFERENTIAL: 1 } as const;

/** TripDescriptor.ScheduleRelationship */
export const TripScheduleRelationship = {
  SCHEDULED: 0,
  ADDED: 1,
  UNSCHEDULED: 2,
  CANCELED: 3,
  REPLACEMENT: 5,
  DUPLICATED: 6,
  DELETED: 7,
  NEW: 8,
} as const;

/** TripUpdate.StopTimeUpdate.ScheduleRelationship */
export const StopTimeScheduleRelationship = { SCHEDULED: 0, SKIPPED: 1, NO_DATA: 2, UNSCHEDULED: 3 } as const;

/** VehiclePosition.VehicleStopStatus */
export const VehicleStopStatus = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 } as const;

/** A message under construction: every field writable (merging re-opens a decoded message). */
export type Draft<T> = { -readonly [K in keyof T]: T[K] };
