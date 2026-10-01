import { decodeTripUpdate } from '../decode-trip-update';
import { decodeFeedMessage } from '../decode-feed';
import { StopTimeScheduleRelationship, type TripUpdate, TripScheduleRelationship } from '../types';
import { createReader } from '../wire';
import { bytesOf, lengthField, stringField, varint, varintField } from './proto-bytes';

const ARRIVAL_TIME = 1_790_000_420;
const DEPARTURE_TIME = 1_790_000_450;

const TRIP = [...stringField(1, 'fixture-trip-7'), ...stringField(5, '31009')];
const ARRIVAL = [...varintField(1, -45), ...varintField(2, ARRIVAL_TIME), ...varintField(3, 30)];
const DEPARTURE = [...varintField(1, -45), ...varintField(2, DEPARTURE_TIME)];
const ON_TIME_STOP = [...varintField(1, 4), ...lengthField(2, ARRIVAL), ...lengthField(3, DEPARTURE), ...stringField(4, '9513')];
const SKIPPED_STOP = [...varintField(1, 5), ...stringField(4, '9511'), ...varintField(5, StopTimeScheduleRelationship.SKIPPED)];
const TRIP_UPDATE = [
  ...lengthField(1, TRIP),
  ...lengthField(2, ON_TIME_STOP),
  ...lengthField(2, SKIPPED_STOP),
  ...lengthField(3, stringField(1, 'rail-213')),
  ...varintField(4, 1_790_000_000),
  ...varintField(5, -45),
];

function decoded(payload: readonly number[]): TripUpdate {
  const result = decodeTripUpdate(createReader(Uint8Array.from(payload)), null);
  if (!result.ok) {
    throw new Error(`decode failed: ${result.error.kind}: ${result.error.message}`);
  }
  expect(result.ok).toBe(true);
  expect(result.value.trip.tripId).toBe('fixture-trip-7');
  return result.value;
}

describe('decodeTripUpdate', () => {
  it('keeps a delay of -45 seconds (a sign-extended 10-byte varint) on the trip and the stop event', () => {
    expect(varint(-45)).toHaveLength(10);
    const update = decoded(TRIP_UPDATE);
    expect(update.delay).toBe(-45);
    expect(update.stopTimeUpdate[0]?.arrival?.delay).toBe(-45);
    expect(update.stopTimeUpdate[0]?.departure?.delay).toBe(-45);
  });

  it('decodes the arrival time and departure time (int64 POSIX seconds) and uncertainty', () => {
    const [first] = decoded(TRIP_UPDATE).stopTimeUpdate;
    expect(first?.arrival).toEqual({ delay: -45, time: ARRIVAL_TIME, uncertainty: 30 });
    expect(first?.departure).toEqual({ delay: -45, time: DEPARTURE_TIME, uncertainty: null });
  });

  it('decodes stopId and stop sequence for every stop time update, in wire order', () => {
    const updates = decoded(TRIP_UPDATE).stopTimeUpdate;
    expect(updates.map((u) => u.stopId)).toEqual(['9513', '9511']);
    expect(updates.map((u) => u.stopSequence)).toEqual([4, 5]);
  });

  it('decodes schedule relationship SKIPPED = 1 (and leaves an absent one null)', () => {
    const [first, second] = decoded(TRIP_UPDATE).stopTimeUpdate;
    expect(StopTimeScheduleRelationship.SKIPPED).toBe(1);
    expect(second?.scheduleRelationship).toBe(StopTimeScheduleRelationship.SKIPPED);
    expect(first?.scheduleRelationship).toBeNull();
    expect(second?.arrival).toBeNull();
  });

  it('decodes the vehicle descriptor, timestamp and a CANCELED trip', () => {
    const canceled = [...lengthField(1, [...TRIP, ...varintField(4, TripScheduleRelationship.CANCELED)])];
    expect(decoded(canceled).trip.scheduleRelationship).toBe(TripScheduleRelationship.CANCELED);
    const update = decoded(TRIP_UPDATE);
    expect(update.vehicle).toEqual({ id: 'rail-213', label: null, licensePlate: null });
    expect(update.timestamp).toBe(1_790_000_000);
  });

  it('rejects a TripUpdate without its required trip', () => {
    const result = decodeTripUpdate(createReader(bytesOf(lengthField(2, SKIPPED_STOP))), null);
    expect(result).toMatchObject({ ok: false, error: { kind: 'missing-required-field' } });
    expect(result.ok).toBe(false);
  });

  it('decodes a trip update inside a feed entity', () => {
    const header = [...stringField(1, '2.0')];
    const entity = [...stringField(1, 'tu1'), ...lengthField(3, TRIP_UPDATE)];
    const feed = decodeFeedMessage(bytesOf(lengthField(1, header), lengthField(2, entity)));
    expect(feed).toMatchObject({ ok: true, value: { entity: [{ id: 'tu1', vehicle: null, tripUpdate: { delay: -45 } }] } });
    expect(feed.ok ? feed.value.entity[0]?.tripUpdate?.stopTimeUpdate : null).toHaveLength(2);
  });
});
