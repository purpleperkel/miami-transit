import { invariant } from '../../lib/invariant';
import { providerConfig } from './constants';
import type { ProviderId } from './types';

/**
 * The RELATIVE staleness rule (arbiter ruling for mfix3 §4, 2026-10-01; numbers in constants.ts). A
 * provider republishes its feed on its own schedule — Transitland's cached county feed only about every
 * 2 min — so a vehicle's age on our clock says more about the feed's cache than about the vehicle. The
 * rule judges each part against the right clock:
 *
 *   the FEED     is live while its header is at most freshS old (Transitland 180 s, Swiftly 75 s);
 *                older, the pill reads "Live · N min old" and every marker of the feed is stale.
 *   a VEHICLE    is stale when it LAGS its own feed — feed time − its fix's time — by more than
 *                lagStaleS (Transitland 90 s, Swiftly 60 s): a stuck AVL unit in a fresh feed.
 *   DROPPED      when its feed is older than maxAgeS, or it lags the feed by more than maxAgeS
 *                (Transitland 300 s, Swiftly 150 s).
 *
 * The merge (rules 1 and 5), the pill and the markers all read this one module. Pure.
 */

/** A batch as the rule reads it: the feed header's timestamp (null when the response had none) and when it arrived. */
export type FeedClock = { readonly feedTimestamp: number | null; readonly fetchedAt: number };

/** A live vehicle against its feed at one instant: how old the feed is, and how far the vehicle lags it (seconds). */
export type Sighting = { readonly provider: ProviderId; readonly feedAgeS: number; readonly lagS: number };

/**
 * The feed's own time (epoch s): its header timestamp. A batch whose response carried no header
 * timestamp is timed by the moment it was fetched (card ruling, mfix3 §4): the feed is then as old as
 * our copy of it, and a vehicle's lag is measured against that.
 */
export function feedTimeOf(feed: FeedClock): number {
  invariant(Number.isFinite(feed.fetchedAt), 'a batch arrived at an instant');
  const time = feed.feedTimestamp ?? feed.fetchedAt;
  invariant(Number.isFinite(time), 'a feed timestamp is a number of seconds');
  return time;
}

/** A vehicle measured at `vehicleTimestamp`, in this feed, seen at `nowS`. Ages and lags never go below 0. */
export function sightingOf(provider: ProviderId, feed: FeedClock, vehicleTimestamp: number, nowS: number): Sighting {
  invariant(Number.isFinite(vehicleTimestamp) && Number.isFinite(nowS), 'a sighting is judged from a fix time at an instant');
  const feedTime = feedTimeOf(feed);
  const sighting: Sighting = { provider, feedAgeS: Math.max(0, nowS - feedTime), lagS: Math.max(0, feedTime - vehicleTimestamp) };
  invariant(sighting.feedAgeS >= 0 && sighting.lagS >= 0, 'ages and lags are never negative');
  return sighting;
}

/** The feed is live: its header is at most the provider's freshS old. */
export function feedIsLive(provider: ProviderId, feedAgeS: number): boolean {
  invariant(Number.isFinite(feedAgeS) && feedAgeS >= 0, `a feed's age is a non-negative number of seconds, got ${feedAgeS}`);
  const { freshS } = providerConfig(provider);
  invariant(freshS > 0, `${provider} has a fresh limit`);
  return feedAgeS <= freshS;
}

/** A sighting is STALE when its feed is no longer live, or it lags its feed by more than lagStaleS. */
export function isStaleSighting(sighting: Sighting): boolean {
  invariant(sighting.lagS >= 0 && Number.isFinite(sighting.lagS), `a lag is a non-negative number of seconds, got ${sighting.lagS}`);
  const { lagStaleS } = providerConfig(sighting.provider);
  invariant(lagStaleS > 0, `${sighting.provider} has a lag limit`);
  return !feedIsLive(sighting.provider, sighting.feedAgeS) || sighting.lagS > lagStaleS;
}

/** A sighting is DROPPED when its feed is older than maxAgeS, or it lags its feed by more than maxAgeS. */
export function isDroppedSighting(sighting: Sighting): boolean {
  invariant(sighting.feedAgeS >= 0 && sighting.lagS >= 0, 'ages and lags are never negative');
  const { maxAgeS } = providerConfig(sighting.provider);
  invariant(maxAgeS > 0, `${sighting.provider} has a drop limit`);
  return sighting.feedAgeS > maxAgeS || sighting.lagS > maxAgeS;
}
