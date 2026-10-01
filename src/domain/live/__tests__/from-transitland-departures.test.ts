import type { LineId } from '../../lines/line-catalog';
import { SYNTHETIC_DEPARTURE_TRIP_LINES, SYNTHETIC_DEPARTURES } from '../__fixtures__/synthetic-departures';
import { DEPARTURES_813, DEPARTURES_9513 } from '../__fixtures__/transitland-departures.fixture';
import { type DepartureStop, predictionFromDepartureRow, predictionsFromDepartures } from '../from-transitland-departures';
import type { LivePrediction, MappedFeed } from '../types';
import { TRIP_LINES, testNetwork } from './test-network';

/**
 * M4.3b: Transitland departures → LivePrediction, on the hand-written SYNTHETIC mapper-case fixture
 * (synthetic trip ids and times in the live response's field structure). Expected instants are
 * computed independently with Date.UTC (EDT = UTC−4 on 2026-10-01).
 */

const AT_9513: DepartureStop = { stopId: '9513', stationKey: 'rail:government-ctr' };

function utc(hour: number, minute: number, second = 0): number {
  const epoch = Date.UTC(2026, 9, 1, hour, minute, second) / 1000;
  expect(Number.isInteger(epoch)).toBe(true);
  expect(epoch).toBeGreaterThan(1_790_000_000);
  return epoch;
}

/** The fixture's first row (Orange, realtime), reshaped by `edit`. */
function firstRow(edit: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row): unknown {
  const row = DEPARTURES_9513.stops[0]?.departures[0];
  expect(row).toBeDefined();
  expect(row?.trip.schedule_relationship).toBe('SCHEDULED');
  return edit(JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
}

function mapRow(row: unknown): LivePrediction {
  const mapped = predictionFromDepartureRow(row, AT_9513, testNetwork());
  expect(mapped.ok).toBe(true);
  if (!mapped.ok) {
    throw new Error(mapped.error.message);
  }
  expect(mapped.value.stopId).toBe('9513');
  return mapped.value;
}

function mapResponse(json: unknown) {
  const mapped = predictionsFromDepartures(json, testNetwork());
  expect(mapped.ok).toBe(true);
  if (!mapped.ok) {
    throw new Error(mapped.error.message);
  }
  expect(mapped.value.feedTimestamp).toBeNull();
  return mapped.value;
}

describe('from-transitland-departures (M4.3b): the fixture', () => {
  it('maps fixture departures: the realtime Orange row at Government Center becomes a full prediction', () => {
    expect(mapResponse(DEPARTURES_9513).items).toHaveLength(5);
    expect(mapResponse(DEPARTURES_9513).items[0]).toEqual({
      tripId: 'fixture-rail-0828',
      routeId: '31009',
      lineId: 'ORANGE',
      stopId: '9513',
      stationKey: 'rail:government-ctr',
      epoch: utc(12, 31, 47),
      scheduledEpoch: utc(12, 28),
      delayS: 227,
      realtime: true,
      canceled: false,
      headsign: 'ORANGE LINE AIRPORT STATION',
    });
  });

  it('maps fixture departures: all five rail rows and both Mover rows, nothing dropped', () => {
    const rail = mapResponse(DEPARTURES_9513);
    expect(rail.items.map((p) => [p.tripId, p.realtime, p.canceled, p.epoch ?? p.scheduledEpoch])).toEqual([
      ['fixture-rail-0828', true, false, utc(12, 31, 47)],
      ['fixture-rail-0834', true, false, utc(12, 35, 2)],
      ['fixture-rail-0846', false, false, utc(12, 46)],
      ['fixture-rail-0858', false, false, utc(12, 58)],
      ['fixture-rail-0920', false, true, utc(13, 20)],
    ]);
    expect(rail.dropped).toEqual({});
    const mover = mapResponse(DEPARTURES_813);
    expect(mover.items.map((p) => [p.tripId, p.lineId, p.realtime, p.delayS])).toEqual([
      ['fixture-omni-0831', 'MM_OMNI', true, -20],
      ['fixture-inner-0833', 'MM_INNER', false, null],
    ]);
  });
});

describe('from-transitland-departures (M4.3b): what counts as realtime', () => {
  it('non-static with estimated_utc is realtime: SCHEDULED and an estimate → realtime, predicted epoch set', () => {
    const prediction = mapRow(firstRow());
    expect(prediction.realtime).toBe(true);
    expect(prediction.epoch).toBe(utc(12, 31, 47));
  });

  it('static is not realtime: a STATIC row stays scheduled-only even when it carries an estimate', () => {
    const staticWithEstimate = mapRow(firstRow((row) => ({ ...row, trip: { ...(row.trip as object), schedule_relationship: 'STATIC' } })));
    expect(staticWithEstimate).toMatchObject({ realtime: false, epoch: null, delayS: null, scheduledEpoch: utc(12, 28) });
    expect(mapResponse(DEPARTURES_9513).items[2]).toMatchObject({ tripId: 'fixture-rail-0846', realtime: false });
  });

  it('no estimated_utc is not realtime: SCHEDULED with a null (or missing) estimate stays scheduled-only', () => {
    const nullEstimate = mapRow(firstRow((row) => ({ ...row, departure: { scheduled_local: '2026-10-01T08:28:00-04:00', estimated_utc: null } })));
    const missingEstimate = mapRow(firstRow((row) => ({ ...row, departure: { scheduled_local: '2026-10-01T08:28:00-04:00' } })));
    expect(nullEstimate).toMatchObject({ realtime: false, epoch: null });
    expect(missingEstimate).toMatchObject({ realtime: false, epoch: null });
    expect(mapResponse(DEPARTURES_9513).items[3]).toMatchObject({ tripId: 'fixture-rail-0858', realtime: false });
  });

  it('scheduled-only rows flagged: realtime false, no predicted epoch, the scheduled time kept', () => {
    const scheduledOnly = mapResponse(DEPARTURES_9513).items.filter((p) => !p.realtime);
    expect(scheduledOnly.map((p) => p.tripId)).toEqual(['fixture-rail-0846', 'fixture-rail-0858', 'fixture-rail-0920']);
    expect(scheduledOnly.every((p) => p.epoch === null && p.delayS === null && p.scheduledEpoch !== null)).toBe(true);
  });

  it('a CANCELED trip is flagged canceled (struck through later, never removed)', () => {
    const canceled = mapResponse(DEPARTURES_9513).items.filter((p) => p.canceled);
    expect(canceled.map((p) => [p.tripId, p.scheduledEpoch])).toEqual([['fixture-rail-0920', utc(13, 20)]]);
    expect(canceled[0]?.realtime).toBe(false);
  });
});

describe('from-transitland-departures (M4.3b): stops, scope and bad input', () => {
  it('stop_id maps to stationKey through the schedule lookup', () => {
    expect(new Set(mapResponse(DEPARTURES_9513).items.map((p) => `${p.stopId} ${p.stationKey}`))).toEqual(new Set(['9513 rail:government-ctr']));
    expect(new Set(mapResponse(DEPARTURES_813).items.map((p) => `${p.stopId} ${p.stationKey}`))).toEqual(new Set(['813 mover:government-center']));
    const unknownStop = { stops: [{ ...DEPARTURES_9513.stops[0], stop_id: '1104' }] };
    expect(mapResponse(unknownStop)).toEqual({ items: [], feedTimestamp: null, dropped: { 'unknown-stop': 5 } });
  });

  it('an out-of-scope route is dropped and counted', () => {
    const bus = firstRow((row) => ({ ...row, trip: { ...(row.trip as object), route: { route_id: 'fixture-bus' } } }));
    const mapped = mapResponse({ stops: [{ stop_id: '9513', departures: [bus, firstRow()] }] });
    expect(mapped.items.map((p) => p.tripId)).toEqual(['fixture-rail-0828']);
    expect(mapped.dropped).toEqual({ 'out-of-scope': 1 });
  });

  it('malformed row returns Err without throwing — and the batch keeps the good rows', () => {
    const bad: unknown[] = [
      null,
      'a string',
      firstRow((row) => ({ ...row, trip: undefined })),
      firstRow((row) => ({ ...row, trip: { ...(row.trip as object), trip_id: 42 } })),
      firstRow((row) => ({ ...row, departure: { scheduled_local: 'yesterday' } })),
      firstRow((row) => ({ ...row, departure: { scheduled_local: '2026-10-01T08:28:00' } })),
      firstRow((row) => ({ ...row, departure: {} })),
      firstRow((row) => ({ ...row, departure: undefined })),
    ];
    for (const row of bad) {
      expect(() => predictionFromDepartureRow(row, AT_9513, testNetwork())).not.toThrow();
      expect(predictionFromDepartureRow(row, AT_9513, testNetwork())).toMatchObject({ ok: false, error: { kind: 'decode' } });
    }
    const mapped = mapResponse({ stops: [{ stop_id: '9513', departures: [...bad, firstRow()] }] });
    expect(mapped.items).toHaveLength(1);
    expect(mapped.dropped).toEqual({ malformed: bad.length });
  });

  it('a malformed envelope is a decode Err for the whole response', () => {
    for (const json of [null, [], {}, { stops: {} }, { stops: [{ departures: [] }] }, { stops: [{ stop_id: '9513' }] }]) {
      expect(predictionsFromDepartures(json, testNetwork())).toMatchObject({ ok: false, error: { kind: 'decode' } });
    }
    expect(mapResponse({ stops: [] })).toEqual({ items: [], feedTimestamp: null, dropped: {} });
  });
});

const GOVERNMENT_CENTER_RAIL = ['9512', '9513'] as const;
type GovernmentCenterStop = (typeof GOVERNMENT_CENTER_RAIL)[number];

/** The rows of the generated response for one platform (scripts/fixtures/make-live-fixtures.ts: synthetic, from the public GTFS). */
function syntheticRows(stopId: GovernmentCenterStop) {
  const stops = SYNTHETIC_DEPARTURES[stopId].stops;
  expect(stops).toHaveLength(1);
  expect(stops[0]?.stop_id).toBe(stopId);
  return stops[0]?.departures ?? [];
}

/** The generated response for one platform through the mapper, on a network that knows its real trips. */
function mapSynthetic(stopId: GovernmentCenterStop): MappedFeed<LivePrediction> {
  const trips = new Map<string, LineId>([...TRIP_LINES, ...SYNTHETIC_DEPARTURE_TRIP_LINES]);
  expect(trips.size).toBe(TRIP_LINES.size + SYNTHETIC_DEPARTURE_TRIP_LINES.length);
  const mapped = predictionsFromDepartures(SYNTHETIC_DEPARTURES[stopId], testNetwork(trips));
  expect(mapped.ok).toBe(true);
  if (!mapped.ok) {
    throw new Error(mapped.error.message);
  }
  return mapped.value;
}

describe('from-transitland-departures (M8.3): the generated Government Center responses', () => {
  it('synthetic capture yields realtime predictions: each non-STATIC row with an estimate, at its estimated instant; the rest scheduled-only', () => {
    const lines = new Map(SYNTHETIC_DEPARTURE_TRIP_LINES);
    for (const stopId of GOVERNMENT_CENTER_RAIL) {
      const rows = syntheticRows(stopId);
      const live = rows.map((row) => row.trip.schedule_relationship !== 'STATIC' && row.departure.estimated_utc !== null);
      const items = mapSynthetic(stopId).items;
      expect(items.map((p) => p.tripId)).toEqual(rows.map((row) => row.trip.trip_id));
      expect(items.map((p) => p.realtime)).toEqual(live);
      expect(live.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      expect(items.map((p) => p.epoch)).toEqual(rows.map((row, i) => (live[i] ? Date.parse(String(row.departure.estimated_utc)) / 1000 : null)));
      expect(items.map((p) => p.delayS)).toEqual(rows.map((row, i) => (live[i] ? row.departure.estimated_delay : null)));
      expect(items.filter((p) => p.lineId === null || p.lineId !== lines.get(p.tripId ?? ''))).toEqual([]);
    }
  });

  it('synthetic capture maps stop_id 9512/9513 to the Government Center stationKey', () => {
    for (const stopId of GOVERNMENT_CENTER_RAIL) {
      const mapped = mapSynthetic(stopId);
      expect(mapped.items).toHaveLength(syntheticRows(stopId).length);
      expect(new Set(mapped.items.map((p) => `${p.stopId} ${p.stationKey}`))).toEqual(new Set([`${stopId} rail:government-ctr`]));
      expect(mapped.dropped).toEqual({});
    }
  });
});
