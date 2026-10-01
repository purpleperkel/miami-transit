import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import type { Draft, TripDescriptor, VehicleDescriptor } from './types';
import {
  type DecodeError,
  type Field,
  fieldInt32,
  fieldKey,
  fieldString,
  fieldUint32,
  type Reader,
  readMessage,
  WireType,
} from './wire';

/**
 * TripDescriptor and VehicleDescriptor — shared by VehiclePosition and TripUpdate. A message field
 * that repeats on the wire MERGES into the earlier one (protobuf semantics), so every decoder takes
 * the previously decoded value as its starting point.
 */

const TRIP_ID = fieldKey(1, WireType.LEN);
const START_TIME = fieldKey(2, WireType.LEN);
const START_DATE = fieldKey(3, WireType.LEN);
const TRIP_SCHEDULE_RELATIONSHIP = fieldKey(4, WireType.VARINT);
const ROUTE_ID = fieldKey(5, WireType.LEN);
const DIRECTION_ID = fieldKey(6, WireType.VARINT);

const VEHICLE_ID = fieldKey(1, WireType.LEN);
const VEHICLE_LABEL = fieldKey(2, WireType.LEN);
const LICENSE_PLATE = fieldKey(3, WireType.LEN);

const EMPTY_TRIP: TripDescriptor = Object.freeze({
  tripId: null,
  routeId: null,
  directionId: null,
  startTime: null,
  startDate: null,
  scheduleRelationship: null,
});

const EMPTY_VEHICLE: VehicleDescriptor = Object.freeze({ id: null, label: null, licensePlate: null });

export function decodeTripDescriptor(reader: Reader, base: TripDescriptor | null): Result<TripDescriptor, DecodeError> {
  invariant(reader.pos === reader.start, 'a TripDescriptor is decoded from the start of its payload');
  const draft: Draft<TripDescriptor> = { ...(base ?? EMPTY_TRIP) };
  const failure = readMessage(reader, (field) => applyTripField(draft, field));
  invariant(failure !== null || reader.pos === reader.end, 'a decoded TripDescriptor consumed its payload');
  return failure === null ? ok(draft) : err(failure);
}

function applyTripField(draft: Draft<TripDescriptor>, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case TRIP_ID:
      draft.tripId = fieldString(field);
      break;
    case START_TIME:
      draft.startTime = fieldString(field);
      break;
    case START_DATE:
      draft.startDate = fieldString(field);
      break;
    case TRIP_SCHEDULE_RELATIONSHIP:
      draft.scheduleRelationship = fieldInt32(field);
      break;
    case ROUTE_ID:
      draft.routeId = fieldString(field);
      break;
    case DIRECTION_ID:
      draft.directionId = fieldUint32(field);
      break;
    default:
      break; // not modelled (modified_trip, …) or an unexpected wire type: already consumed, skipped
  }
  return null;
}

export function decodeVehicleDescriptor(
  reader: Reader,
  base: VehicleDescriptor | null,
): Result<VehicleDescriptor, DecodeError> {
  invariant(reader.pos === reader.start, 'a VehicleDescriptor is decoded from the start of its payload');
  const draft: Draft<VehicleDescriptor> = { ...(base ?? EMPTY_VEHICLE) };
  const failure = readMessage(reader, (field) => applyVehicleDescriptorField(draft, field));
  invariant(failure !== null || reader.pos === reader.end, 'a decoded VehicleDescriptor consumed its payload');
  return failure === null ? ok(draft) : err(failure);
}

function applyVehicleDescriptorField(draft: Draft<VehicleDescriptor>, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case VEHICLE_ID:
      draft.id = fieldString(field);
      break;
    case VEHICLE_LABEL:
      draft.label = fieldString(field);
      break;
    case LICENSE_PLATE:
      draft.licensePlate = fieldString(field);
      break;
    default:
      break; // not modelled (wheelchair_accessible, …) or an unexpected wire type: skipped
  }
  return null;
}
