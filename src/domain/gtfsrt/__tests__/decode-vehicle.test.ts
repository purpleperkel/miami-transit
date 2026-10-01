import { decodeFeedMessage } from '../decode-feed';
import { type FeedMessage, Incrementality, type VehiclePosition, VehicleStopStatus } from '../types';
import { bytesOf, fixed64Field, float32Field, lengthField, stringField, varintField } from './proto-bytes';

const FEED_TIMESTAMP = 1_790_000_000;
const VEHICLE_TIMESTAMP = 1_789_999_990;

const HEADER = [...stringField(1, '2.0'), ...varintField(2, Incrementality.FULL_DATASET), ...varintField(3, FEED_TIMESTAMP)];
const TRIP = [...stringField(1, 'fixture-trip-1'), ...stringField(5, '31009'), ...varintField(6, 1)];
const POSITION = [...float32Field(1, 25.7743), ...float32Field(2, -80.1955), ...float32Field(3, 90), ...float32Field(5, 12.5)];
const DESCRIPTOR = [...stringField(1, 'rail-213'), ...stringField(2, '213')];
const VEHICLE = [
  ...lengthField(1, TRIP),
  ...lengthField(2, POSITION),
  ...varintField(3, 12),
  ...varintField(4, VehicleStopStatus.STOPPED_AT),
  ...varintField(5, VEHICLE_TIMESTAMP),
  ...stringField(7, '9513'),
  ...lengthField(8, DESCRIPTOR),
];

/** Field 1000 once per wire type the reader supports. */
const UNKNOWN_1000 = [...varintField(1000, 42), ...stringField(1000, 'future'), ...float32Field(1000, 1), ...fixed64Field(1000, 2)];

/** A one-entity feed: `vehicle` is the VehiclePosition payload, `entityExtra` more entity fields. */
function feedBytes(vehicle: readonly number[], entityExtra: readonly number[] = []): Uint8Array {
  const entity = [...stringField(1, 'v1'), ...lengthField(4, vehicle), ...entityExtra];
  const bytes = bytesOf(lengthField(1, HEADER), lengthField(2, entity));
  expect(bytes.length).toBeGreaterThan(vehicle.length);
  expect(entity.length).toBeGreaterThan(0);
  return bytes;
}

function decoded(bytes: Uint8Array): FeedMessage {
  const result = decodeFeedMessage(bytes);
  if (!result.ok) {
    throw new Error(`decode failed: ${result.error.kind} at ${result.error.offset}: ${result.error.message}`);
  }
  expect(result.ok).toBe(true);
  expect(result.value.header.gtfsRealtimeVersion).toBe('2.0');
  return result.value;
}

function onlyVehicle(feed: FeedMessage): VehiclePosition {
  expect(feed.entity).toHaveLength(1);
  const vehicle = feed.entity[0]?.vehicle ?? null;
  expect(vehicle).not.toBeNull();
  if (vehicle === null) {
    throw new Error('the entity carries no vehicle');
  }
  return vehicle;
}

describe('decodeFeedMessage: a vehicle position from hand-built bytes', () => {
  it('decodes the header timestamp and the vehicle timestamp (uint64)', () => {
    const feed = decoded(feedBytes(VEHICLE));
    expect(feed.header).toEqual({ gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: FEED_TIMESTAMP });
    expect(onlyVehicle(feed).timestamp).toBe(VEHICLE_TIMESTAMP);
  });

  it('decodes latitude and longitude (float32, within 1e-5) plus bearing and speed', () => {
    const position = onlyVehicle(decoded(feedBytes(VEHICLE))).position;
    expect(position?.latitude).toBeCloseTo(25.7743, 5);
    expect(position?.longitude).toBeCloseTo(-80.1955, 5);
    expect(position?.bearing).toBe(90);
    expect(position?.speed).toBe(12.5);
  });

  it('decodes the trip id, route id and direction id', () => {
    const trip = onlyVehicle(decoded(feedBytes(VEHICLE))).trip;
    expect(trip).toEqual({
      tripId: 'fixture-trip-1',
      routeId: '31009',
      directionId: 1,
      startTime: null,
      startDate: null,
      scheduleRelationship: null,
    });
    expect(trip?.tripId).toBe('fixture-trip-1');
  });

  it('decodes the entity id, vehicle descriptor, stop id, status and stop sequence', () => {
    const feed = decoded(feedBytes(VEHICLE));
    const vehicle = onlyVehicle(feed);
    expect(feed.entity[0]).toMatchObject({ id: 'v1', isDeleted: null, tripUpdate: null });
    expect(vehicle.vehicle).toEqual({ id: 'rail-213', label: '213', licensePlate: null });
    expect(vehicle).toMatchObject({ stopId: '9513', currentStatus: VehicleStopStatus.STOPPED_AT, currentStopSequence: 12 });
  });
});

describe('decodeFeedMessage: unknown and unexpected fields', () => {
  it('skips an unknown field 1000 of every wire type, at every message level', () => {
    const noisyVehicle = [
      ...UNKNOWN_1000,
      ...lengthField(1, [...TRIP, ...UNKNOWN_1000]),
      ...lengthField(2, [...UNKNOWN_1000, ...POSITION]),
      ...varintField(3, 12),
      ...varintField(4, VehicleStopStatus.STOPPED_AT),
      ...varintField(5, VEHICLE_TIMESTAMP),
      ...stringField(7, '9513'),
      ...lengthField(8, [...DESCRIPTOR, ...UNKNOWN_1000]),
    ];
    const noisy = bytesOf(
      UNKNOWN_1000,
      lengthField(1, [...HEADER, ...UNKNOWN_1000]),
      lengthField(2, [...UNKNOWN_1000, ...stringField(1, 'v1'), ...lengthField(4, noisyVehicle)]),
    );
    // Seven insertions: feed, header, entity, vehicle position, trip, position, vehicle descriptor.
    expect(noisy.length).toBeGreaterThanOrEqual(feedBytes(VEHICLE).length + 7 * UNKNOWN_1000.length);
    expect(decoded(noisy)).toEqual(decoded(feedBytes(VEHICLE)));
  });

  it('treats a known field number with an unexpected wire type as unknown (protobuf semantics)', () => {
    const vehicle = onlyVehicle(decoded(feedBytes([...VEHICLE, ...varintField(7, 9), ...stringField(4, 'x')])));
    expect(vehicle.stopId).toBe('9513');
    expect(vehicle.currentStatus).toBe(VehicleStopStatus.STOPPED_AT);
  });

  it('lets the last occurrence of a scalar win and MERGES a repeated message field', () => {
    const repeated = [...VEHICLE, ...stringField(7, '9512'), ...lengthField(2, float32Field(3, 180))];
    const vehicle = onlyVehicle(decoded(feedBytes(repeated)));
    expect(vehicle.stopId).toBe('9512');
    expect(vehicle.position?.bearing).toBe(180);
    expect(vehicle.position?.latitude).toBeCloseTo(25.7743, 5);
  });

  it('decodes a deleted entity', () => {
    const feed = decoded(bytesOf(lengthField(1, HEADER), lengthField(2, [...stringField(1, 'gone'), ...varintField(2, 1)])));
    expect(feed.entity[0]).toEqual({ id: 'gone', isDeleted: true, tripUpdate: null, vehicle: null });
    expect(feed.entity).toHaveLength(1);
  });
});

describe('decodeFeedMessage: malformed feeds are an Err, never a throw', () => {
  it('reports missing required fields (header, version, entity id, latitude)', () => {
    const required = { ok: false, error: { kind: 'missing-required-field' } };
    expect(decodeFeedMessage(bytesOf(lengthField(2, stringField(1, 'v1'))))).toMatchObject(required);
    expect(decodeFeedMessage(bytesOf(lengthField(1, varintField(3, 1))))).toMatchObject(required);
    expect(decodeFeedMessage(bytesOf(lengthField(1, HEADER), lengthField(2, lengthField(4, VEHICLE))))).toMatchObject(required);
    expect(decodeFeedMessage(feedBytes(lengthField(2, float32Field(2, -80.19))))).toMatchObject(required);
  });

  it('returns a Result for every truncation and every single-byte corruption of a valid feed', () => {
    const bytes = feedBytes(VEHICLE);
    let errors = 0;
    for (let cut = 0; cut < bytes.length; cut += 1) {
      errors += decodeFeedMessage(bytes.subarray(0, cut)).ok ? 0 : 1;
    }
    for (let at = 0; at < bytes.length; at += 1) {
      const corrupted = Uint8Array.from(bytes);
      corrupted[at] = 0xff;
      expect(typeof decodeFeedMessage(corrupted).ok).toBe('boolean');
    }
    expect(errors).toBeGreaterThan(bytes.length / 2);
  });
});
