import { transit_realtime } from 'gtfs-realtime-bindings';

import { VEHICLE_POSITIONS_FIXTURE_BYTES, VEHICLE_POSITIONS_FIXTURE_DECODED } from '../__fixtures__/vehicle-positions.fixture';
import { decodeFeedMessage } from '../decode-feed';
import type { FeedMessage } from '../types';

/**
 * The reference GTFS-realtime bindings (protobufjs) are the ORACLE: they encode feeds, and our
 * decoder must read those bytes exactly as the reference decoder does. The bindings are a dev
 * dependency used only here and in the Mac-side fixture generator; the app never ships them.
 */

const NOW = 1_790_872_200;
const BEYOND_2_POW_32 = 5_000_000_000;

function oracleEncode(feed: transit_realtime.IFeedMessage): Uint8Array {
  expect(transit_realtime.FeedMessage.verify(feed)).toBeNull();
  const bytes = transit_realtime.FeedMessage.encode(transit_realtime.FeedMessage.fromObject(feed)).finish();
  expect(bytes.length).toBeGreaterThan(0);
  return bytes;
}

/** The reference decode as a plain object: 64-bit Longs as numbers; absent fields omitted. */
function oracleDecode(bytes: Uint8Array): unknown {
  const plain = transit_realtime.FeedMessage.toObject(transit_realtime.FeedMessage.decode(bytes), { longs: Number });
  expect(plain).toHaveProperty('header');
  expect(plain.header).toHaveProperty('gtfsRealtimeVersion');
  return plain;
}

function ourDecode(bytes: Uint8Array): FeedMessage {
  const result = decodeFeedMessage(bytes);
  if (!result.ok) {
    throw new Error(`our decoder failed: ${result.error.kind} at ${result.error.offset}: ${result.error.message}`);
  }
  expect(result.ok).toBe(true);
  expect(result.value.header.gtfsRealtimeVersion.length).toBeGreaterThan(0);
  return result.value;
}

/** Our decode in toObject's shape: null (absent) fields and empty repeated fields omitted. */
function inOracleShape(feed: FeedMessage): unknown {
  const text = JSON.stringify(feed, (_key, value: unknown) =>
    value === null || (Array.isArray(value) && value.length === 0) ? undefined : value,
  );
  expect(text).not.toContain('null');
  expect(text.length).toBeGreaterThan(2);
  return JSON.parse(text) as unknown;
}

const THREE_VEHICLES: transit_realtime.IFeedMessage = {
  header: { gtfsRealtimeVersion: '2.0', incrementality: 0, timestamp: NOW },
  entity: [
    {
      id: 'v1',
      vehicle: {
        trip: { tripId: 'T1', routeId: '31009', directionId: 0, startTime: '16:20:00', startDate: '20261001', scheduleRelationship: 0 },
        vehicle: { id: 'rail-213', label: '213', licensePlate: 'MDT-213' },
        position: { latitude: 25.7747, longitude: -80.1955, bearing: 0, speed: 0 },
        currentStopSequence: 12,
        stopId: '9513',
        currentStatus: 1,
        timestamp: NOW - 12,
      },
    },
    {
      id: 'v2',
      vehicle: {
        trip: { tripId: 'T2', routeId: '14456', directionId: 1 },
        position: { latitude: 25.7761, longitude: -80.1902, bearing: 270.5, speed: 6.7 },
        currentStatus: 2,
        timestamp: BEYOND_2_POW_32,
      },
    },
    { id: 'v3', isDeleted: false, vehicle: { vehicle: { id: 'mover-07' }, position: { latitude: 25.7739, longitude: -80.1917 } } },
  ],
};

const TWO_TRIP_UPDATES: transit_realtime.IFeedMessage = {
  header: { gtfsRealtimeVersion: '2.0', incrementality: 1, timestamp: NOW },
  entity: [
    {
      id: 'tu1',
      tripUpdate: {
        trip: { tripId: 'T1', routeId: '31009', startDate: '20261001' },
        vehicle: { id: 'rail-213' },
        stopTimeUpdate: [
          { stopSequence: 12, stopId: '9513', arrival: { delay: -45, time: NOW + 120, uncertainty: 30 }, departure: { time: NOW + 150 } },
          { stopSequence: 13, stopId: '9511', scheduleRelationship: 1 },
          { stopSequence: 14, stopId: '9509', scheduleRelationship: 2 },
        ],
        timestamp: NOW - 5,
        delay: -45,
      },
    },
    { id: 'tu2', tripUpdate: { trip: { tripId: 'T9', scheduleRelationship: 3 } } },
  ],
};

describe('oracle: our decoder agrees with the reference bindings', () => {
  it('decodes 3 vehicles to deep-equal fields', () => {
    const bytes = oracleEncode(THREE_VEHICLES);
    const feed = ourDecode(bytes);
    expect(feed.entity).toHaveLength(3);
    expect(inOracleShape(feed)).toEqual(oracleDecode(bytes));
  });

  it('decodes 2 trip updates to deep-equal fields (negative delays, SKIPPED, CANCELED)', () => {
    const bytes = oracleEncode(TWO_TRIP_UPDATES);
    const feed = ourDecode(bytes);
    expect(feed.entity.map((e) => e.tripUpdate?.trip.tripId)).toEqual(['T1', 'T9']);
    expect(inOracleShape(feed)).toEqual(oracleDecode(bytes));
  });

  it('decodes a uint64 timestamp beyond 2^32 (and 2^53 - 1) like the reference', () => {
    const feed: transit_realtime.IFeedMessage = {
      header: { gtfsRealtimeVersion: '2.0', timestamp: BEYOND_2_POW_32 },
      entity: [{ id: 'max', vehicle: { timestamp: Number.MAX_SAFE_INTEGER } }],
    };
    const bytes = oracleEncode(feed);
    const ours = ourDecode(bytes);
    expect(ours.header.timestamp).toBe(BEYOND_2_POW_32);
    expect(ours.entity[0]?.vehicle?.timestamp).toBe(Number.MAX_SAFE_INTEGER);
    expect(inOracleShape(ours)).toEqual(oracleDecode(bytes));
  });

  it('decodes unicode strings (Gov’t Center, Ñ, 🚆) like the reference', () => {
    const label = 'Gov’t Center · Ñ · 🚆';
    const feed: transit_realtime.IFeedMessage = {
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [{ id: 'Ñ-1', vehicle: { vehicle: { id: '🚆', label }, stopId: 'Gov’t Center', trip: { tripId: 'ñandú-🚆' } } }],
    };
    const bytes = oracleEncode(feed);
    const ours = ourDecode(bytes);
    expect(ours.entity[0]?.vehicle?.vehicle?.label).toBe(label);
    expect(ours.entity[0]?.id).toBe('Ñ-1');
    expect(inOracleShape(ours)).toEqual(oracleDecode(bytes));
  });
});

describe('oracle: fields this decoder does not model', () => {
  it('skips alerts, occupancy, carriages, odometer and trip properties, agreeing on everything else', () => {
    const rich: transit_realtime.IFeedMessage = {
      header: { gtfsRealtimeVersion: '2.0', timestamp: NOW, feedVersion: 'fv-1' },
      entity: [
        {
          id: 'v1',
          vehicle: {
            position: { latitude: 25.7747, longitude: -80.1955, odometer: 12345.5 },
            congestionLevel: 1,
            occupancyStatus: 2,
            occupancyPercentage: 40,
            multiCarriageDetails: [{ id: 'car-1', label: 'A', carriageSequence: 1 }],
          },
        },
        { id: 'a1', alert: { headerText: { translation: [{ text: 'Elevator out at Gov’t Center', language: 'en' }] } } },
        { id: 'tu1', tripUpdate: { trip: { tripId: 'T1' }, tripProperties: { tripHeadsign: 'Dadeland South' } } },
      ],
    };
    const modelled: transit_realtime.IFeedMessage = {
      header: { gtfsRealtimeVersion: '2.0', timestamp: NOW },
      entity: [
        { id: 'v1', vehicle: { position: { latitude: 25.7747, longitude: -80.1955 } } },
        { id: 'a1' },
        { id: 'tu1', tripUpdate: { trip: { tripId: 'T1' } } },
      ],
    };
    const richBytes = oracleEncode(rich);
    expect(richBytes.length).toBeGreaterThan(oracleEncode(modelled).length);
    expect(inOracleShape(ourDecode(richBytes))).toEqual(oracleDecode(oracleEncode(modelled)));
  });
});

describe('oracle: the generated vehicle-positions fixture', () => {
  it('decodes to the committed expectation, which the reference decoder agrees with', () => {
    const ours = ourDecode(VEHICLE_POSITIONS_FIXTURE_BYTES);
    expect(ours).toEqual(VEHICLE_POSITIONS_FIXTURE_DECODED);
    expect(inOracleShape(ours)).toEqual(oracleDecode(VEHICLE_POSITIONS_FIXTURE_BYTES));
  });
});
