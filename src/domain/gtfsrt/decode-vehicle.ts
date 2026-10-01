import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { decodeTripDescriptor, decodeVehicleDescriptor } from './decode-descriptors';
import type { Draft, Position, VehiclePosition } from './types';
import {
  type DecodeError,
  decodeError,
  type Field,
  fieldFloat32,
  fieldInt32,
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

/** VehiclePosition and its Position. Repeated message fields merge (see decode-descriptors.ts). */

const LATITUDE = fieldKey(1, WireType.I32);
const LONGITUDE = fieldKey(2, WireType.I32);
const BEARING = fieldKey(3, WireType.I32);
const SPEED = fieldKey(5, WireType.I32);

const TRIP = fieldKey(1, WireType.LEN);
const POSITION = fieldKey(2, WireType.LEN);
const CURRENT_STOP_SEQUENCE = fieldKey(3, WireType.VARINT);
const CURRENT_STATUS = fieldKey(4, WireType.VARINT);
const TIMESTAMP = fieldKey(5, WireType.VARINT);
const STOP_ID = fieldKey(7, WireType.LEN);
const VEHICLE = fieldKey(8, WireType.LEN);

/** latitude and longitude are `required` in the proto; they may only be missing mid-decode. */
type PositionDraft = Draft<Omit<Position, 'latitude' | 'longitude'>> & { latitude: number | null; longitude: number | null };

const EMPTY_POSITION: PositionDraft = Object.freeze({ latitude: null, longitude: null, bearing: null, speed: null });

const EMPTY_VEHICLE_POSITION: VehiclePosition = Object.freeze({
  trip: null,
  vehicle: null,
  position: null,
  currentStopSequence: null,
  stopId: null,
  currentStatus: null,
  timestamp: null,
});

export function decodePosition(reader: Reader, base: Position | null): Result<Position, DecodeError> {
  invariant(reader.pos === reader.start, 'a Position is decoded from the start of its payload');
  const draft: PositionDraft = { ...(base ?? EMPTY_POSITION) };
  const failure = readMessage(reader, (field) => applyPositionField(draft, field));
  if (failure !== null) {
    return err(failure);
  }
  const { latitude, longitude } = draft;
  if (latitude === null || longitude === null) {
    return err(decodeError('missing-required-field', reader.start, 'Position.latitude and Position.longitude are required'));
  }
  invariant(reader.pos === reader.end, 'a decoded Position consumed its payload');
  return ok({ ...draft, latitude, longitude });
}

function applyPositionField(draft: PositionDraft, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case LATITUDE:
      draft.latitude = fieldFloat32(field);
      break;
    case LONGITUDE:
      draft.longitude = fieldFloat32(field);
      break;
    case BEARING:
      draft.bearing = fieldFloat32(field);
      break;
    case SPEED:
      draft.speed = fieldFloat32(field);
      break;
    default:
      break; // not modelled (odometer) or an unexpected wire type: already consumed, skipped
  }
  return null;
}

export function decodeVehiclePosition(reader: Reader, base: VehiclePosition | null): Result<VehiclePosition, DecodeError> {
  invariant(reader.pos === reader.start, 'a VehiclePosition is decoded from the start of its payload');
  const draft: Draft<VehiclePosition> = { ...(base ?? EMPTY_VEHICLE_POSITION) };
  const failure = readMessage(reader, (field) => applyVehiclePositionField(draft, field));
  invariant(failure !== null || reader.pos === reader.end, 'a decoded VehiclePosition consumed its payload');
  return failure === null ? ok(draft) : err(failure);
}

function applyVehiclePositionField(draft: Draft<VehiclePosition>, field: Field): DecodeError | null {
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
    case POSITION:
      return settle(decodePosition(fieldMessage(field), draft.position), (position) => {
        draft.position = position;
      });
    case TIMESTAMP:
      return settle(fieldUint64(field), (timestamp) => {
        draft.timestamp = timestamp;
      });
    case CURRENT_STOP_SEQUENCE:
      draft.currentStopSequence = fieldUint32(field);
      return null;
    case CURRENT_STATUS:
      draft.currentStatus = fieldInt32(field);
      return null;
    case STOP_ID:
      draft.stopId = fieldString(field);
      return null;
    default:
      return null; // not modelled (occupancy, congestion, carriages) or an unexpected wire type: skipped
  }
}
