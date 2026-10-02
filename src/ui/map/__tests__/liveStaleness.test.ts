import type { ServiceEnds } from '@/domain/expiry/expiry';
import type { LiveBatch, LiveVehicle } from '@/domain/live/types';
import type { CapabilityStatus } from '@/live/poller';

import { dataStatus, statusConditions, statusFace } from '../../dataStatus';
import { framesAt, NO_SHOWN, planFrames, type VehicleFrame } from '../vehicleFrames';
import { vehicleVisual } from '../vehicleVisual';

/**
 * mfix3 §4, "sometimes live": the arbiter's RELATIVE staleness rule, judged on the real path — the pill
 * through statusConditions + statusFace (src/ui/dataStatus), the drop through planFrames' merge, and
 * each marker's stale look through framesAt → vehicleVisual (src/ui/map). Transitland: a vehicle is
 * stale past 90 s behind its feed header; the feed is Live while its header is ≤ 180 s old; a vehicle is
 * dropped when its feed is over 300 s old or it lags the feed by over 300 s.
 *
 * Batches are synthetic (no realtime capture): rail vehicles off any timetable (the timetable is not
 * open), so every live vehicle is drawn at its fix — what is checked is whether it is drawn, and how.
 */

/** Rail ends 2026-11-22, Mover 2026-12-31, as in the bundled manifest: far from expiring at FETCH. */
const ENDS: ServiceEnds = { rail: { date: 20261122, epoch: 1_795_410_000 }, mover: { date: 20261231, epoch: 1_798_779_600 } };
/** 2026-10-01 19:30 EDT: when the batches below arrive. */
const FETCH = 1_790_897_400;
const SERVING: CapabilityStatus = { provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null };

/** Rail vehicle `i` (off any timetable), its fix measured at `timestamp`. */
function railVehicle(i: number, timestamp: number): LiveVehicle {
  const vehicle: LiveVehicle = {
    vehicleId: `rail-${i}`,
    label: null,
    tripId: null,
    routeId: '31009',
    mode: 'rail',
    lineId: 'GREEN',
    lineSource: 'position',
    directionId: 0,
    position: { latitude: 25.75 + i * 0.002, longitude: -80.25 },
    bearing: 0,
    speedMps: null,
    stopId: null,
    stopStatus: null,
    timestamp,
  };
  expect(Number.isSafeInteger(timestamp)).toBe(true);
  expect(vehicle.vehicleId).toBe(`rail-${i}`);
  return vehicle;
}

/** A Transitland batch fetched at FETCH whose feed header is `feedAgeS` old, holding one rail vehicle per lag (seconds behind the header). */
function cachedFeed(feedAgeS: number, lagsS: readonly number[]): LiveBatch<LiveVehicle> {
  const header = FETCH - feedAgeS;
  const items = lagsS.map((lagS, i) => railVehicle(i, header - lagS));
  expect(items).toHaveLength(lagsS.length);
  expect(items.every((vehicle) => vehicle.timestamp <= header)).toBe(true);
  return { provider: 'transitland', items, feedTimestamp: header, fetchedAt: FETCH, dropped: {}, bytes: 2_048 };
}

type Judged = { readonly pill: string; readonly drawn: readonly string[]; readonly stale: readonly string[] };

/** At `nowS`: the pill's words, the live vehicles drawn (their ids), and which of them look stale. */
function judge(batch: LiveBatch<LiveVehicle>, nowS: number): Judged {
  const pill = statusFace(dataStatus(statusConditions({ serviceEnds: ENDS, vehicles: batch, vehiclesStatus: SERVING, nowS }))).text;
  const frames = framesAt(planFrames(null, batch, Math.floor(nowS)), nowS, NO_SHOWN).frames.filter((frame) => frame.source === 'live');
  const looks = frames.map((frame: VehicleFrame) => ({
    id: frame.key.replace('live:', ''),
    stale: vehicleVisual({ vehicleKey: frame.key, mode: frame.mode, lineId: frame.lineId, source: frame.source, live: frame.live, bearing: frame.bearing, scheme: 'light' }).stale,
  }));
  expect(looks.length).toBeLessThanOrEqual(batch.items.length);
  expect(pill.length).toBeGreaterThan(0);
  return { pill, drawn: looks.map((look) => look.id).sort(), stale: looks.filter((look) => look.stale).map((look) => look.id).sort() };
}

/** The ids of the first `n` vehicles of a batch. */
function railIds(n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `rail-${i}`);
  expect(ids).toHaveLength(n);
  expect(new Set(ids).size).toBe(n);
  return ids;
}

describe('pill and markers agree (mfix3 §4)', () => {
  it('a 120 s old feed with vehicles 10 s behind stays live for the next 60 s', () => {
    const batch = cachedFeed(120, [10, 10, 10]);
    const seconds = Array.from({ length: 61 }, (_, s) => judge(batch, FETCH + s));
    // Every second of the next minute: nothing stale, nothing dropped, and the pill says Live.
    expect(seconds.every((at) => at.pill === 'Live')).toBe(true);
    expect(seconds.every((at) => at.drawn.length === 3 && at.stale.length === 0)).toBe(true);
  });

  it('a vehicle 136 s behind a 27 s old feed is stale and the others solid', () => {
    // Live sample 3 (2026-10-01): a stuck AVL unit 163 s old while its feed was 27 s old.
    const judged = judge(cachedFeed(27, [8, 136, 16]), FETCH);
    expect(judged).toEqual({ pill: 'Live', drawn: railIds(3), stale: ['rail-1'] });
    expect(judged.stale).not.toContain('rail-0');
  });

  it('a vehicle 91 s behind a fresh feed is stale and one 90 s behind is solid', () => {
    const judged = judge(cachedFeed(0, [90, 91]), FETCH);
    expect(judged).toEqual({ pill: 'Live', drawn: railIds(2), stale: ['rail-1'] });
    expect(judged.drawn).toContain('rail-0');
  });

  it('a 200 s old feed reads live 3 min old and every marker is stale', () => {
    const judged = judge(cachedFeed(200, [20, 20, 20]), FETCH);
    expect(judged.pill).toBe('Live · 3 min old');
    expect(judged).toEqual({ pill: 'Live · 3 min old', drawn: railIds(3), stale: railIds(3) });
  });
});

describe('the drop rule (mfix3 §4)', () => {
  it('a 290 s old feed keeps its vehicles', () => {
    const judged = judge(cachedFeed(290, [5, 5]), FETCH);
    expect(judged.drawn).toEqual(railIds(2));
    expect(judged.stale).toEqual(railIds(2));
  });

  it('a feed over 300 s old or a vehicle over 300 s behind it is dropped', () => {
    // The feed itself past 300 s: every vehicle goes (and the pill still says how old the feed is).
    const old = judge(cachedFeed(301, [0, 0]), FETCH);
    expect(old.drawn).toEqual([]);
    expect(old.pill).toBe('Live · 5 min old');
    // A fresh feed: 301 s behind it is dropped, exactly 300 s behind is kept (and stale).
    expect(judge(cachedFeed(0, [300, 301]), FETCH)).toEqual({ pill: 'Live', drawn: ['rail-0'], stale: ['rail-0'] });
  });
});
