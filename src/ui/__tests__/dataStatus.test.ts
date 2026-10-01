import type { ServiceEnds } from '@/domain/expiry/expiry';
import { PROVIDER_CONFIG } from '@/domain/live/constants';
import type { CapabilityStatus } from '@/live/poller';

import { DATA_STATUS_PRIORITY, dataStatus, type StatusCondition, statusConditions, statusFace } from '../dataStatus';
import { liveBatch, liveVehicle } from '../map/__tests__/map-fixtures';

/**
 * M5.11 dataStatus: the pill shows the most important condition that holds —
 * expired > offline > stale > live > expiring > scheduled — one passing test per adjacent pair.
 */

const EXPIRED: StatusCondition = { kind: 'expired' };
const OFFLINE: StatusCondition = { kind: 'offline' };
const STALE: StatusCondition = { kind: 'stale', ageS: 200 };
const LIVE: StatusCondition = { kind: 'live' };
const EXPIRING: StatusCondition = { kind: 'expiring', daysLeft: 9 };

/** Asserts `winner` beats `loser` in either order, and alone each shows itself. */
function expectBeats(winner: StatusCondition, loser: StatusCondition): void {
  expect(dataStatus([winner, loser])).toEqual(winner);
  expect(dataStatus([loser, winner])).toEqual(winner);
  expect(dataStatus([loser])).toEqual(loser);
}

describe('dataStatus priority (M5.11)', () => {
  it('expired beats offline', () => {
    expectBeats(EXPIRED, OFFLINE);
  });

  it('offline beats stale', () => {
    expectBeats(OFFLINE, STALE);
  });

  it('stale beats live', () => {
    expectBeats(STALE, LIVE);
  });

  it('live beats expiring', () => {
    expectBeats(LIVE, EXPIRING);
  });

  it('expiring beats scheduled', () => {
    expect(dataStatus([EXPIRING])).toEqual(EXPIRING);
    expect(dataStatus([])).toEqual({ kind: 'scheduled' });
    expect(DATA_STATUS_PRIORITY).toEqual(['expired', 'offline', 'stale', 'live', 'expiring', 'scheduled']);
  });
});

/** Rail ends 2026-11-22 (start of the 23rd), Mover 2026-12-31, as in the bundled manifest. */
const ENDS: ServiceEnds = { rail: { date: 20261122, epoch: 1_795_410_000 }, mover: { date: 20261231, epoch: 1_798_779_600 } };
const OCT_1 = 1_790_870_400;
const DAY_S = 86_400;
const IDLE: CapabilityStatus = { provider: 'transitland', failing: false, consecutiveFailures: 0, lastError: null };

describe('dataStatus conditions (M5.11)', () => {
  it('live data is stale only past its provider\'s fresh threshold', () => {
    for (const provider of ['swiftly', 'transitland'] as const) {
      const fresh = PROVIDER_CONFIG[provider].freshS;
      const batch = liveBatch(provider, [liveVehicle({ latitude: 25.77, longitude: -80.19 }, OCT_1)], OCT_1);
      const [atFresh, pastFresh] = [fresh, fresh + 1].map((ageS) => statusConditions({ serviceEnds: ENDS, vehicles: batch, vehiclesStatus: IDLE, nowS: OCT_1 + ageS }));
      expect(atFresh).toEqual([{ kind: 'live' }]);
      expect(pastFresh).toEqual([{ kind: 'stale', ageS: fresh + 1 }]);
    }
  });

  it('a network failure is offline; the schedule ending soon is expiring, then expired', () => {
    const offline: CapabilityStatus = { ...IDLE, lastError: { kind: 'network', message: 'The Internet connection appears to be offline.' } };
    expect(statusConditions({ serviceEnds: ENDS, vehicles: null, vehiclesStatus: offline, nowS: OCT_1 })).toEqual([{ kind: 'offline' }]);
    const http: CapabilityStatus = { ...IDLE, lastError: { kind: 'http', status: 401, message: 'unauthorised' } };
    expect(statusConditions({ serviceEnds: ENDS, vehicles: null, vehiclesStatus: http, nowS: OCT_1 })).toEqual([]);
    const soon = ENDS.rail.epoch - 9 * DAY_S;
    expect(statusConditions({ serviceEnds: ENDS, vehicles: null, vehiclesStatus: null, nowS: soon })).toEqual([{ kind: 'expiring', daysLeft: 9 }]);
    expect(statusConditions({ serviceEnds: ENDS, vehicles: null, vehiclesStatus: null, nowS: ENDS.rail.epoch + 1 })).toEqual([{ kind: 'expired' }]);
  });

  it('every status has its words', () => {
    expect(statusFace({ kind: 'stale', ageS: 130 }).text).toBe('Live · 2 min old');
    expect(statusFace({ kind: 'expiring', daysLeft: 1 }).text).toBe('Scheduled · ends in 1 day');
    expect(statusFace({ kind: 'expiring', daysLeft: 9 }).text).toBe('Scheduled · ends in 9 days');
    expect([statusFace({ kind: 'live' }).pulse, statusFace({ kind: 'scheduled' }).pulse]).toEqual([true, false]);
  });
});
