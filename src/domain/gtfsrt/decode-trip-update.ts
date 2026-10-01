import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { decodeTripDescriptor, decodeVehicleDescriptor } from './decode-descriptors';
import type { Draft, StopTimeEvent, StopTimeUpdate, TripDescriptor, TripUpdate } from './types';
import {
  type DecodeError,
  decodeError,
  type Field,
  fieldInt32,
  fieldInt64,
  fieldKey,
  fieldMessage,
  fieldString,
  fieldUint32,
  fieldUint64,
  type Reader,
  readMessage,
  settle,
  WireType,
} from './wire';

/**
 * TripUpdate → StopTimeUpdate → StopTimeEvent. Delays are int32 (a negative delay arrives as a
 * sign-extended 10-byte varint); event times are int64 POSIX seconds. Repeated message fields
 * merge (see decode-descriptors.ts); `stop_time_update` is a repeated field and accumulates.
 */

const EVENT_DELAY = fieldKey(1, WireType.VARINT);
const EVENT_TIME = fieldKey(2, WireType.VARINT);
const EVENT_UNCERTAINTY = fieldKey(3, WireType.VARINT);

const STOP_SEQUENCE = fieldKey(1, WireType.VARINT);
const ARRIVAL = fieldKey(2, WireType.LEN);
const DEPARTURE = fieldKey(3, WireType.LEN);
const STOP_ID = fieldKey(4, WireType.LEN);
const STOP_SCHEDULE_RELATIONSHIP = fieldKey(5, WireType.VARINT);

const TRIP = fieldKey(1, WireType.LEN);
const STOP_TIME_UPDATE = fieldKey(2, WireType.LEN);
const VEHICLE = fieldKey(3, WireType.LEN);
const TIMESTAMP = fieldKey(4, WireType.VARINT);
const TRIP_DELAY = fieldKey(5, WireType.VARINT);

const EMPTY_EVENT: StopTimeEvent = Object.freeze({ delay: null, time: null, uncertainty: null });

const EMPTY_STOP_TIME_UPDATE: StopTimeUpdate = Object.freeze({
  stopSequence: null,
  stopId: null,
  arrival: null,
  departure: null,
  scheduleRelationship: null,
});

/** `trip` is `required` in the proto; it may only be missing mid-decode. */
type TripUpdateDraft = Draft<Omit<TripUpdate, 'trip' | 'stopTimeUpdate'>> & {
  trip: TripDescriptor | null;
  stopTimeUpdate: StopTimeUpdate[];
};

export function decodeStopTimeEvent(reader: Reader, base: StopTimeEvent | null): Result<StopTimeEvent, DecodeError> {
  invariant(reader.pos === reader.start, 'a StopTimeEvent is decoded from the start of its payload');
  const draft: Draft<StopTimeEvent> = { ...(base ?? EMPTY_EVENT) };
  const failure = readMessage(reader, (field) => applyEventField(draft, field));
  invariant(failure !== null || reader.pos === reader.end, 'a decoded StopTimeEvent consumed its payload');
  return failure === null ? ok(draft) : err(failure);
}

function applyEventField(draft: Draft<StopTimeEvent>, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case EVENT_DELAY:
      draft.delay = fieldInt32(field);
      return null;
    case EVENT_TIME:
      return settle(fieldInt64(field), (time) => {
        draft.time = time;
      });
    case EVENT_UNCERTAINTY:
      draft.uncertainty = fieldInt32(field);
      return null;
    default:
      return null; // not modelled (scheduled_time, experimental) or an unexpected wire type: skipped
  }
}

export function decodeStopTimeUpdate(reader: Reader, base: StopTimeUpdate | null): Result<StopTimeUpdate, DecodeError> {
  invariant(reader.pos === reader.start, 'a StopTimeUpdate is decoded from the start of its payload');
  const draft: Draft<StopTimeUpdate> = { ...(base ?? EMPTY_STOP_TIME_UPDATE) };
  const failure = readMessage(reader, (field) => applyStopTimeUpdateField(draft, field));
  invariant(failure !== null || reader.pos === reader.end, 'a decoded StopTimeUpdate consumed its payload');
  return failure === null ? ok(draft) : err(failure);
}

function applyStopTimeUpdateField(draft: Draft<StopTimeUpdate>, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case STOP_SEQUENCE:
      draft.stopSequence = fieldUint32(field);
      return null;
    case STOP_ID:
      draft.stopId = fieldString(field);
      return null;
    case ARRIVAL:
      return settle(decodeStopTimeEvent(fieldMessage(field), draft.arrival), (arrival) => {
        draft.arrival = arrival;
      });
    case DEPARTURE:
      return settle(decodeStopTimeEvent(fieldMessage(field), draft.departure), (departure) => {
        draft.departure = departure;
      });
    case STOP_SCHEDULE_RELATIONSHIP:
      draft.scheduleRelationship = fieldInt32(field);
      return null;
    default:
      return null; // not modelled (stop_time_properties, occupancy) or an unexpected wire type: skipped
  }
}

export function decodeTripUpdate(reader: Reader, base: TripUpdate | null): Result<TripUpdate, DecodeError> {
  invariant(reader.pos === reader.start, 'a TripUpdate is decoded from the start of its payload');
  const draft: TripUpdateDraft = {
    trip: base?.trip ?? null,
    vehicle: base?.vehicle ?? null,
    stopTimeUpdate: [...(base?.stopTimeUpdate ?? [])],
    timestamp: base?.timestamp ?? null,
    delay: base?.delay ?? null,
  };
  const failure = readMessage(reader, (field) => applyTripUpdateField(draft, field));
  if (failure !== null) {
    return err(failure);
  }
  const { trip } = draft;
  if (trip === null) {
    return err(decodeError('missing-required-field', reader.start, 'TripUpdate.trip is required'));
  }
  invariant(reader.pos === reader.end, 'a decoded TripUpdate consumed its payload');
  return ok({ ...draft, trip });
}

function applyTripUpdateField(draft: TripUpdateDraft, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case TRIP:
      return settle(decodeTripDescriptor(fieldMessage(field), draft.trip), (trip) => {
        draft.trip = trip;
      });
    case VEHICLE:
      return settle(decodeVehicleDescriptor(fieldMessage(field), draft.vehicle), (vehicle) => {
        draft.vehicle = vehicle;
      });
    case STOP_TIME_UPDATE:
      return settle(decodeStopTimeUpdate(fieldMessage(field), null), (update) => {
        draft.stopTimeUpdate.push(update);
      });
    case TIMESTAMP:
      return settle(fieldUint64(field), (timestamp) => {
        draft.timestamp = timestamp;
      });
    case TRIP_DELAY:
      draft.delay = fieldInt32(field);
      return null;
    default:
      return null; // not modelled (trip_properties) or an unexpected wire type: skipped
  }
}
