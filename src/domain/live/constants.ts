import { invariant } from '../../lib/invariant';
import { PROVIDER_IDS, type ProviderId, type TrunkLineId } from './types';

/**
 * The plan's realtime numbers (§3 provider table, §4 Polling and Merge rules), in one place. The
 * scheduler, chain and merges read them from here; constants.test.ts pins every value.
 */

export type ProviderConfig = {
  readonly id: ProviderId;
  /** Seconds between polls while the app is open. Swiftly's binding docs say cache GTFS-rt ≥ 30 s. */
  readonly cadenceS: number;
  /** Data at most this old is fresh: the pill reads Live and the mode's scheduled ghosts hide (merge rule 5). */
  readonly freshS: number;
  /** A live vehicle older than this is dropped (merge rule 1). */
  readonly maxAgeS: number;
  /** REST calls per calendar month on the plan we use, or null when the provider publishes none. */
  readonly monthlyQuota: number | null;
};

export const PROVIDER_CONFIG: Readonly<Record<ProviderId, ProviderConfig>> = Object.freeze({
  swiftly: Object.freeze({ id: 'swiftly', cadenceS: 30, freshS: 75, maxAgeS: 150, monthlyQuota: null }),
  // Transitland re-fetches the county feed about once a minute; the Free plan allows 10,000 calls a month.
  transitland: Object.freeze({ id: 'transitland', cadenceS: 60, freshS: 150, maxAgeS: 210, monthlyQuota: 10_000 }),
});

/** Every request is aborted after this long (§4 Polling: an 8 s abort on each request). */
export const REQUEST_ABORT_MS = 8_000;

/** Failure backoff: the first retry waits 15 s, each further failure doubles it, never past 120 s. */
export const BACKOFF_FIRST_S = 15;
export const BACKOFF_CAP_S = 120;

/** The chain leaves a provider after this many consecutive failures… */
export const FAILOVER_AFTER_FAILURES = 3;
/** …and tries it again (re-probes it) this long after its last failure. */
export const REPROBE_AFTER_S = 300;

/** A provider whose monthly quota is at least this percent used is skipped (§4 Polling). */
export const QUOTA_SKIP_PERCENT = 95;

/** The polling heartbeat ticks this often, only while the app is active and focused. */
export const HEARTBEAT_MS = 1_000;

/** Transitland departures are asked for this far ahead (`?next=3600`, the §3 live-verified call). */
export const DEPARTURES_WINDOW_S = 3_600;

/** Merge rule 2: a live vehicle with no trip match pairs with a scheduled one of its line at most this far away. */
export const MATCH_RADIUS_M = 800;

/** A position this close to a line's track is on that line (used only when the vehicle's trip is unknown). */
export const ON_TRACK_M = 100;

/**
 * Merge rule 1's Miami bounding box. The rail and Mover network spans 25.685–25.846 °N and
 * 80.324–80.187 °W (schedule.db shape points, 2026-10-01); the box adds at least 5 km on every side,
 * so a real vehicle is never cut while a 0,0 fix or a stray agency's vehicle is.
 */
export const MIAMI_BOUNDS = Object.freeze({ south: 25.6, north: 25.9, west: -80.4, east: -80.1 });

/** The neutral line of each route whose lines share track (types.ts TRUNK_LINE_IDS, arbiter ruling R-c). */
export const TRUNK_LINE_OF_ROUTE: ReadonlyMap<string, TrunkLineId> = new Map([
  ['31009', 'RAIL_TRUNK'],
  ['14456', 'MM_TRUNK'],
]);

export function providerConfig(id: ProviderId): ProviderConfig {
  invariant((PROVIDER_IDS as readonly string[]).includes(id), `"${id}" is a realtime provider`);
  const config = PROVIDER_CONFIG[id];
  invariant(config.id === id && config.freshS < config.maxAgeS && config.cadenceS <= BACKOFF_CAP_S, `${id}'s config is consistent`);
  return config;
}

/** The monthly call count at which the provider is skipped (95% of its quota), or null when it has no quota. */
export function quotaSkipAt(id: ProviderId): number | null {
  const { monthlyQuota } = providerConfig(id);
  invariant(monthlyQuota === null || (Number.isSafeInteger(monthlyQuota) && monthlyQuota > 0), `${id}'s quota is a whole number of calls`);
  // Integer arithmetic (×95 then ÷100), so 10,000 gives exactly 9,500 — no 0.95 float rounding.
  const skipAt = monthlyQuota === null ? null : Math.ceil((monthlyQuota * QUOTA_SKIP_PERCENT) / 100);
  invariant(skipAt === null || (skipAt > 0 && skipAt <= (monthlyQuota ?? 0)), 'the skip point lies inside the quota');
  return skipAt;
}
