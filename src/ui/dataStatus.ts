import type { SFSymbol } from 'expo-symbols';

import { type ExpiryState, type ServiceEnds, scheduleExpiry } from '../domain/expiry/expiry';
import { feedIsLive, feedTimeOf } from '../domain/live/staleness';
import type { LiveBatch, LiveVehicle } from '../domain/live/types';
import type { CapabilityStatus } from '../live/poller';
import { invariant } from '../lib/invariant';
import { minutesOld } from './a11y';

/**
 * How much the map can be trusted right now (plan §4 "Status pill priority", M5.11). Several things
 * can be true at once — the schedule is about to run out WHILE live data streams in — so each one is
 * gathered as a CONDITION (statusConditions) and the pill shows the most important (dataStatus):
 *
 *   expired > offline > stale > live > expiring > scheduled
 *
 *   expired    the bundled schedule has run out (the mode that ends first is past its end, M3.7)
 *   offline    the live provider cannot be reached: its latest poll failed on the network or timed out
 *   stale      live vehicles, but their FEED's header is older than its provider's freshS (the
 *              relative rule, src/domain/live/staleness.ts: Swiftly 75 s, Transitland 180 s) —
 *              "Live · 3 min old"; every marker of that feed renders stale with it
 *   live       live vehicles whose feed header is within that limit
 *   expiring   the schedule ends within 14 days (M3.7 warn/urgent) — "Scheduled · ends in N days"
 *   scheduled  nothing else holds: the map shows the timetable alone
 */

/** The statuses, most important first. */
export const DATA_STATUS_PRIORITY = ['expired', 'offline', 'stale', 'live', 'expiring', 'scheduled'] as const;
export type DataStatusKind = (typeof DATA_STATUS_PRIORITY)[number];

export type DataStatus =
  | { readonly kind: 'expired' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'stale'; readonly ageS: number }
  | { readonly kind: 'live' }
  | { readonly kind: 'expiring'; readonly daysLeft: number }
  | { readonly kind: 'scheduled' };

/** A condition that holds now; 'scheduled' is what remains when none does. */
export type StatusCondition = Exclude<DataStatus, { readonly kind: 'scheduled' }>;

const SCHEDULED: DataStatus = Object.freeze({ kind: 'scheduled' });

/** The status the pill shows: the highest-priority condition that holds, else 'scheduled'. */
export function dataStatus(conditions: readonly StatusCondition[]): DataStatus {
  invariant(Array.isArray(conditions), 'the status is judged over a list of conditions');
  let best: DataStatus = SCHEDULED;
  for (const condition of conditions) {
    if (DATA_STATUS_PRIORITY.indexOf(condition.kind) < DATA_STATUS_PRIORITY.indexOf(best.kind)) {
      best = condition;
    }
  }
  invariant(conditions.every((c) => DATA_STATUS_PRIORITY.indexOf(c.kind) >= DATA_STATUS_PRIORITY.indexOf(best.kind)), 'no condition outranks the status');
  return best;
}

/** What the conditions are gathered from: the schedule's service ends, the live vehicles and their capability's status. */
export type StatusInputs = {
  readonly serviceEnds: ServiceEnds;
  readonly vehicles: LiveBatch<LiveVehicle> | null;
  readonly vehiclesStatus: CapabilityStatus | null;
  readonly nowS: number;
};

const EXPIRING: ReadonlySet<ExpiryState> = new Set(['warn', 'urgent']);

/** Every condition that holds at `nowS`. */
export function statusConditions(inputs: StatusInputs): StatusCondition[] {
  invariant(Number.isSafeInteger(Math.floor(inputs.nowS)), 'conditions are judged at an instant');
  const expiry = scheduleExpiry(inputs.serviceEnds, Math.floor(inputs.nowS));
  const first = expiry.rail.remainingS <= expiry.mover.remainingS ? expiry.rail : expiry.mover;
  const conditions: StatusCondition[] = [];
  if (first.state === 'expired') {
    conditions.push({ kind: 'expired' });
  } else if (EXPIRING.has(first.state) && first.daysLeft !== null) {
    conditions.push({ kind: 'expiring', daysLeft: first.daysLeft });
  }
  const lastError = inputs.vehiclesStatus?.lastError ?? null;
  if (lastError !== null && (lastError.kind === 'network' || lastError.kind === 'timeout')) {
    conditions.push({ kind: 'offline' });
  }
  const ageS = feedAgeS(inputs.vehicles, inputs.nowS);
  if (ageS !== null && inputs.vehicles !== null) {
    conditions.push(feedIsLive(inputs.vehicles.provider, ageS) ? { kind: 'live' } : { kind: 'stale', ageS });
  }
  invariant(conditions.filter((c) => c.kind === 'stale' || c.kind === 'live').length <= 1, 'the live data is stale or fresh, not both');
  return conditions;
}

/**
 * How old the vehicles' feed is at `nowS` — its header's age (a batch without a header timestamp is
 * timed by its fetch, staleness.ts) — or null when there are no live vehicles to judge.
 */
function feedAgeS(batch: LiveBatch<LiveVehicle> | null, nowS: number): number | null {
  invariant(Number.isFinite(nowS), 'an age is measured at an instant');
  if (batch === null || batch.items.length === 0) {
    return null;
  }
  const ageS = Math.max(0, nowS - feedTimeOf(batch));
  invariant(Number.isFinite(ageS) && ageS >= 0, 'a feed age is a non-negative number of seconds');
  return ageS;
}

/** What the pill shows for a status: an SF Symbol AND a word (never colour alone, §4), and whether the icon pulses. */
export type StatusFace = { readonly icon: SFSymbol; readonly text: string; readonly pulse: boolean };

export function statusFace(status: DataStatus): StatusFace {
  invariant(DATA_STATUS_PRIORITY.includes(status.kind), `"${status.kind}" is a data status`);
  const face: StatusFace = faceOf(status);
  invariant(face.icon.length > 0 && face.text.trim().length > 0, 'every status has an icon and a word');
  return face;
}

function faceOf(status: DataStatus): StatusFace {
  invariant(typeof status.kind === 'string', 'a status has a kind');
  let face: StatusFace;
  switch (status.kind) {
    case 'expired':
      face = { icon: 'calendar.badge.exclamationmark', text: 'Schedule expired', pulse: false };
      break;
    case 'offline':
      face = { icon: 'wifi.slash', text: 'Offline', pulse: false };
      break;
    case 'stale':
      face = { icon: 'clock', text: `Live · ${minutesOld(status.ageS)}`, pulse: false };
      break;
    case 'live':
      face = { icon: 'dot.radiowaves.left.and.right', text: 'Live', pulse: true };
      break;
    case 'expiring':
      face = { icon: 'calendar', text: `Scheduled · ends in ${status.daysLeft} ${status.daysLeft === 1 ? 'day' : 'days'}`, pulse: false };
      break;
    case 'scheduled':
      face = { icon: 'calendar', text: 'Scheduled', pulse: false };
      break;
  }
  invariant(face.pulse === (status.kind === 'live'), 'only the live icon pulses');
  return face;
}
