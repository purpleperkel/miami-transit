import {
  LIVE_TRIP_UPDATES_FIXTURE_DECODED,
  LIVE_VEHICLES_FIXTURE_DECODED,
} from '../../gtfsrt/__fixtures__/live-feeds.fixture';
import { decodeFeedMessage } from '../../gtfsrt/decode-feed';
import type { FeedEntity, FeedMessage } from '../../gtfsrt/types';
import type { LineId } from '../../lines/line-catalog';
import { SYNTHETIC_VEHICLE_POSITIONS_BYTES, SYNTHETIC_VEHICLE_TRIP_LINES } from '../__fixtures__/synthetic-vehicle-positions';
import { predictionsFromFeed, vehiclesFromFeed } from '../from-gtfsrt';
import { distanceToTrackM, resolveLine } from '../line-from-position';
import type { LiveNetwork, LiveVehicle } from '../types';
import { TEST_TRACKS, TRIP_LINES, testNetwork } from './test-network';

/**
 * M4.2: GTFS-realtime → LiveVehicle / LivePrediction, on the generated live-feeds fixture
 * (scripts/fixtures/make-gtfsrt-fixture.ts; oracle.test.ts proves the reference decoder reads its
 * bytes identically). Fixture positions are midpoints between real stations.
 */

const FEED_TIMESTAMP = 1_790_872_200;
const IN_SCOPE = ['14456', '14457', '31009'];

function vehicles(feed: FeedMessage = LIVE_VEHICLES_FIXTURE_DECODED, network = testNetwork()) {
  const mapped = vehiclesFromFeed(feed, network);
  expect(mapped.feedTimestamp).toBe(feed.header.timestamp);
  expect(new Set(mapped.items.map((v) => v.vehicleId)).size).toBe(mapped.items.length);
  return mapped;
}

function vehicle(id: string, network = testNetwork()): LiveVehicle {
  const found = vehicles(LIVE_VEHICLES_FIXTURE_DECODED, network).items.find((v) => v.vehicleId === id);
  expect(found).toBeDefined();
  expect(found?.vehicleId).toBe(id);
  return found as LiveVehicle;
}

/** The decoded fixture entity whose vehicle is `id`. */
function entityOf(id: string): FeedEntity {
  const entity = LIVE_VEHICLES_FIXTURE_DECODED.entity.find((e) => e.vehicle?.vehicle?.id === id);
  expect(entity).toBeDefined();
  expect(entity?.vehicle?.position).not.toBeNull();
  return entity as FeedEntity;
}

describe('from-gtfsrt (M4.2): vehicles', () => {
  it('maps fixture vehicles: every field of a Metrorail vehicle carries over', () => {
    const position = entityOf('rail-157').vehicle?.position;
    expect(vehicle('rail-157')).toEqual({
      vehicleId: 'rail-157',
      label: '157',
      tripId: 'fixture-rail-0822',
      routeId: '31009',
      mode: 'rail',
      lineId: 'ORANGE',
      lineSource: 'trip',
      directionId: 1,
      position: { latitude: position?.latitude, longitude: position?.longitude },
      bearing: 182,
      speedMps: position?.speed,
      stopId: '9512',
      stopStatus: 'in-transit',
      timestamp: FEED_TIMESTAMP - 25,
    });
    expect(position?.latitude).toBeCloseTo(25.7586, 5);
  });

  it('maps fixture vehicles: 10 in scope, sorted by id; the Mover keeps its UTF-8 label; dropped ones are counted', () => {
    const mapped = vehicles();
    expect(mapped.items.map((v) => v.vehicleId)).toEqual([
      'mover-07', 'mover-12', 'mover-19', 'mover-31', 'rail-157', 'rail-213', 'rail-301', 'rail-302', 'rail-303', 'rail-304',
    ]);
    expect(vehicle('mover-07')).toMatchObject({ label: 'Gov’t Center', mode: 'mover', lineId: 'MM_INNER', lineSource: 'route', stopStatus: null });
    expect(mapped.dropped).toEqual({ 'out-of-scope': 2, 'no-position': 1 });
    expect(mapped.items.length + 3).toBe(LIVE_VEHICLES_FIXTURE_DECODED.entity.length);
  });

  it('maps fixture vehicles: a vehicle with no timestamp of its own takes the feed header\'s', () => {
    expect(entityOf('rail-303').vehicle?.timestamp).toBeNull();
    expect(vehicle('rail-303').timestamp).toBe(FEED_TIMESTAMP);
    expect(vehicle('rail-301').timestamp).toBe(FEED_TIMESTAMP - 15);
  });

  it('maps fixture vehicles: a repeated vehicle id keeps the newest report and counts the duplicate', () => {
    const original = entityOf('rail-213');
    const older = { ...original, id: 'vehicle-rail-213-again', vehicle: { ...original.vehicle!, timestamp: FEED_TIMESTAMP - 90 } };
    const mapped = vehicles({ ...LIVE_VEHICLES_FIXTURE_DECODED, entity: [older, ...LIVE_VEHICLES_FIXTURE_DECODED.entity] });
    expect(mapped.items.filter((v) => v.vehicleId === 'rail-213').map((v) => v.timestamp)).toEqual([FEED_TIMESTAMP - 12]);
    expect(mapped.dropped.duplicate).toBe(1);
  });
});

describe('from-gtfsrt (M4.2): scope', () => {
  it('keeps only 31009/14456/14457: the MIA Mover (14458) and the bus are dropped from vehicles and trip updates', () => {
    const fromVehicles = vehicles().items.map((v) => v.routeId);
    const fromUpdates = predictionsFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork()).items.map((p) => p.routeId);
    expect([...new Set(fromVehicles)].sort()).toEqual(IN_SCOPE);
    expect([...new Set(fromUpdates)].sort()).toEqual(['14456', '31009']);
    expect(vehicles().items.some((v) => v.vehicleId === 'mia-mover-2' || v.vehicleId === 'bus-1104')).toBe(false);
    expect(predictionsFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork()).dropped['out-of-scope']).toBe(1);
  });

  it('keeps only 31009/14456/14457: a descriptor with no route_id takes its known trip\'s route', () => {
    const entity = entityOf('rail-213');
    const trip = { ...entity.vehicle!.trip!, routeId: null };
    const feed = { ...LIVE_VEHICLES_FIXTURE_DECODED, entity: [{ ...entity, vehicle: { ...entity.vehicle!, trip } }] };
    expect(vehicles(feed).items.map((v) => [v.vehicleId, v.routeId, v.lineId])).toEqual([['rail-213', '31009', 'GREEN']]);
    expect(vehicles(feed, testNetwork(new Map())).dropped).toEqual({ 'out-of-scope': 1 });
  });
});

describe('from-gtfsrt (M4.2): the line of a vehicle', () => {
  it('line from trip_id pattern: the trip\'s line wins even on the shared trunk', () => {
    expect(vehicle('rail-213')).toMatchObject({ lineId: 'GREEN', lineSource: 'trip' });
    expect(vehicle('rail-157')).toMatchObject({ lineId: 'ORANGE', lineSource: 'trip' });
    expect(vehicle('mover-31')).toMatchObject({ lineId: 'MM_OMNI', lineSource: 'trip' });
  });

  it('line from trip_id pattern: a trip line on another route is ignored and position decides', () => {
    const wrongRoute = new Map([['fixture-rail-0815', 'MM_INNER' as const]]);
    expect(vehicle('rail-213', testNetwork(wrongRoute))).toMatchObject({ lineId: 'RAIL_TRUNK', lineSource: 'position' });
    expect(vehicle('rail-213', testNetwork(new Map()))).toMatchObject({ lineId: 'RAIL_TRUNK', lineSource: 'position' });
  });

  it('line inferred from position: no trip_id on the Green branch -> GREEN, on the Airport branch -> ORANGE', () => {
    expect(vehicle('rail-301')).toMatchObject({ tripId: null, lineId: 'GREEN', lineSource: 'position' });
    expect(vehicle('rail-302')).toMatchObject({ tripId: null, lineId: 'ORANGE', lineSource: 'position' });
  });

  it('line inferred from position: a trip the schedule does not know is placed by position; so is a Brickell-only Mover', () => {
    expect(vehicle('rail-304')).toMatchObject({ tripId: 'fixture-rail-unknown', lineId: 'GREEN', lineSource: 'position' });
    expect(vehicle('mover-19')).toMatchObject({ tripId: null, lineId: 'MM_BRICKELL', lineSource: 'position' });
  });

  it('no trip_id on the shared trunk -> RAIL_TRUNK (and MM_TRUNK on the shared Omni/Brickell track)', () => {
    expect(vehicle('rail-303')).toMatchObject({ tripId: null, lineId: 'RAIL_TRUNK', lineSource: 'position' });
    expect(vehicle('mover-12')).toMatchObject({ tripId: null, lineId: 'MM_TRUNK', lineSource: 'position' });
  });

  it('no trip_id on the shared trunk -> RAIL_TRUNK also off every track (a yard, a bad fix): never a guessed colour', () => {
    const offTrack = { latitude: 25.79, longitude: -80.3 };
    expect(Math.min(...TEST_TRACKS.map((track) => distanceToTrackM(offTrack, track.points)))).toBeGreaterThan(1_000);
    expect(resolveLine('31009', null, offTrack, testNetwork())).toEqual({ lineId: 'RAIL_TRUNK', lineSource: 'position' });
  });

  it('distance to a track: 0 on a segment, the perpendicular beside it, the end point beyond it', () => {
    const track = [
      { latitude: 25.77, longitude: -80.2 },
      { latitude: 25.78, longitude: -80.2 },
    ];
    expect(distanceToTrackM({ latitude: 25.775, longitude: -80.2 }, track)).toBeCloseTo(0, 6);
    expect(distanceToTrackM({ latitude: 25.775, longitude: -80.199 }, track)).toBeCloseTo(100.1, 0);
    expect(distanceToTrackM({ latitude: 25.781, longitude: -80.2 }, track)).toBeCloseTo(111.2, 0);
  });
});

describe('from-gtfsrt (M4.2): trip updates', () => {
  it('maps fixture trip updates: absolute departures, a canceled trip, a delay-only stop and a skipped stop', () => {
    const base = { routeId: '31009', headsign: null, scheduledEpoch: null, realtime: true };
    const mapped = predictionsFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork());
    expect(mapped.items).toEqual([
      { ...base, tripId: 'fixture-rail-0822', lineId: 'ORANGE', stopId: '9515', stationKey: 'rail:brickell', epoch: FEED_TIMESTAMP + 300, delayS: 120, canceled: false },
      { ...base, tripId: 'fixture-rail-0822', lineId: 'ORANGE', stopId: '9513', stationKey: 'rail:government-ctr', epoch: FEED_TIMESTAMP + 420, delayS: 120, canceled: false },
      { ...base, tripId: 'fixture-rail-0830', lineId: 'GREEN', stopId: null, stationKey: null, epoch: null, delayS: null, canceled: true },
      { ...base, routeId: '14456', tripId: 'fixture-omni-1630', lineId: 'MM_OMNI', stopId: '813', stationKey: 'mover:government-center', epoch: null, delayS: 45, canceled: false },
      { ...base, routeId: '14456', tripId: 'fixture-omni-1630', lineId: 'MM_OMNI', stopId: '815', stationKey: 'mover:third-street', epoch: null, delayS: null, canceled: true },
    ]);
    expect(mapped.feedTimestamp).toBe(FEED_TIMESTAMP);
  });

  it('maps fixture trip updates: NO_DATA, an unknown stop and a sequence-only stop are dropped and counted', () => {
    const mapped = predictionsFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork());
    expect(mapped.dropped).toEqual({ 'no-data': 1, 'unknown-stop': 1, 'no-stop': 1, 'out-of-scope': 1 });
    expect(mapped.items.some((p) => p.tripId === 'fixture-rail-0845')).toBe(false);
  });

  it('maps fixture trip updates: a vehicle feed has no predictions and a trip-update feed has no vehicles', () => {
    expect(predictionsFromFeed(LIVE_VEHICLES_FIXTURE_DECODED, testNetwork())).toEqual({ items: [], feedTimestamp: FEED_TIMESTAMP, dropped: {} });
    expect(vehiclesFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork())).toEqual({ items: [], feedTimestamp: FEED_TIMESTAMP, dropped: {} });
  });
});

/** The generated whole-agency feed (scripts/fixtures/make-live-fixtures.ts: synthetic, from the public GTFS), read by our decoder. */
function syntheticFeed(): FeedMessage {
  const decoded = decodeFeedMessage(SYNTHETIC_VEHICLE_POSITIONS_BYTES);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) {
    throw new Error(decoded.error.message);
  }
  expect(decoded.value.entity.length).toBeGreaterThanOrEqual(50);
  return decoded.value;
}

/** The test network, also knowing the line of each real schedule.db trip the synthetic feed's vehicles run. */
function syntheticNetwork(): LiveNetwork {
  const trips = new Map<string, LineId>([...TRIP_LINES, ...SYNTHETIC_VEHICLE_TRIP_LINES]);
  expect(trips.size).toBe(TRIP_LINES.size + SYNTHETIC_VEHICLE_TRIP_LINES.length);
  expect(SYNTHETIC_VEHICLE_TRIP_LINES.length).toBeGreaterThan(0);
  return testNetwork(trips);
}

describe('from-gtfsrt (M8.3): the generated whole-agency feed', () => {
  it('synthetic capture maps rail and Mover vehicles: each on its real trip, its line from that trip, id and label kept', () => {
    const feed = syntheticFeed();
    const lines = new Map(SYNTHETIC_VEHICLE_TRIP_LINES);
    const inScope = feed.entity.filter((entity) => IN_SCOPE.includes(entity.vehicle?.trip?.routeId ?? ''));
    const mapped = vehiclesFromFeed(feed, syntheticNetwork());
    expect(mapped.items.map((v) => v.vehicleId).sort()).toEqual(inScope.map((entity) => entity.vehicle?.vehicle?.id).sort());
    expect(new Set(mapped.items.map((v) => `${v.routeId} ${v.mode}`))).toEqual(new Set(['31009 rail', '14456 mover', '14457 mover']));
    expect(mapped.items.filter((v) => v.tripId === null || v.lineId !== lines.get(v.tripId) || v.lineSource === 'position')).toEqual([]);
    expect(mapped.items.every((v) => v.label === v.vehicleId && v.vehicleId.startsWith('syn-') && v.timestamp <= (feed.header.timestamp ?? 0))).toBe(true);
    expect([...new Set(mapped.items.map((v) => v.stopStatus))].sort()).toEqual(expect.arrayContaining(['in-transit', 'stopped']));
  });

  it('synthetic capture drops out-of-scope routes: every bus and every vehicle on no trip is counted, none kept', () => {
    const feed = syntheticFeed();
    const outside = feed.entity.filter((entity) => !IN_SCOPE.includes(entity.vehicle?.trip?.routeId ?? ''));
    const mapped = vehiclesFromFeed(feed, syntheticNetwork());
    expect(outside.some((entity) => entity.vehicle?.trip === null)).toBe(true);
    expect(outside.some((entity) => entity.vehicle?.trip !== null)).toBe(true);
    expect(mapped.dropped).toEqual({ 'out-of-scope': outside.length });
    expect(mapped.items.length + outside.length).toBe(feed.entity.length);
  });
});
