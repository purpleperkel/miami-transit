import {
  type ChainState,
  initialChainState,
  type PollResult,
  type ProviderStanding,
  recordPoll,
  resolveProvider,
  skipReason,
  type Standings,
} from '../chain';
import type { Capability, ProviderId } from '../types';

/** M4.4: the provider chain swiftly ▸ transitland ▸ none, per capability. Times are epoch seconds. */

const T0 = 1_790_872_200;
const BOTH = { vehicles: true, predictions: true };
const READY: ProviderStanding = { hasKey: true, capabilities: BOTH, callsThisMonth: 0 };
const BOTH_READY: Standings = { swiftly: READY, transitland: READY };

/** Replay polls of one provider for one capability: each [result, at] in order. */
function replay(capability: Capability, provider: ProviderId, polls: readonly (readonly [PollResult, number])[], start: ChainState = initialChainState()): ChainState {
  expect(polls.every(([, at], i) => i === 0 || at >= (polls[i - 1]?.[1] ?? 0))).toBe(true);
  const state = polls.reduce((current, [result, at]) => recordPoll(current, capability, provider, result, at), start);
  expect(state[capability][provider].consecutive).toBeGreaterThanOrEqual(0);
  return state;
}

function failures(n: number, from = T0): [PollResult, number][] {
  const polls = Array.from({ length: n }, (_, i): [PollResult, number] => ['failed', from + 30 * i]);
  expect(polls).toHaveLength(n);
  expect(polls.every(([result]) => result === 'failed')).toBe(true);
  return polls;
}

describe('provider chain (M4.4): order and independence', () => {
  it('swiftly ▸ transitland ▸ none: the first usable provider serves', () => {
    const state = initialChainState();
    expect(resolveProvider(state, 'vehicles', BOTH_READY, T0)).toBe('swiftly');
    expect(resolveProvider(state, 'predictions', { swiftly: { ...READY, hasKey: false }, transitland: READY }, T0)).toBe('transitland');
    expect(resolveProvider(state, 'vehicles', { swiftly: { ...READY, hasKey: false }, transitland: { ...READY, hasKey: false } }, T0)).toBe('none');
  });

  it('per capability: Swiftly predictions failing over leaves the vehicles chain on Swiftly', () => {
    const start = initialChainState();
    const state = replay('predictions', 'swiftly', failures(3), start);
    expect(resolveProvider(state, 'predictions', BOTH_READY, T0 + 61)).toBe('transitland');
    expect(resolveProvider(state, 'vehicles', BOTH_READY, T0 + 61)).toBe('swiftly');
    expect(state.vehicles).toBe(start.vehicles);
  });

  it('per capability: a provider that does not offer a capability is skipped for it alone', () => {
    const swiftlyVehiclesOnly: Standings = { swiftly: { ...READY, capabilities: { vehicles: true, predictions: false } }, transitland: READY };
    expect(resolveProvider(initialChainState(), 'vehicles', swiftlyVehiclesOnly, T0)).toBe('swiftly');
    expect(resolveProvider(initialChainState(), 'predictions', swiftlyVehiclesOnly, T0)).toBe('transitland');
    expect(skipReason(initialChainState(), 'predictions', 'swiftly', swiftlyVehiclesOnly.swiftly, T0)).toBe('unsupported');
  });
});

describe('provider chain (M4.4): failover and re-probe', () => {
  it('fails over after 3 failures in a row (not after 2)', () => {
    expect(resolveProvider(replay('vehicles', 'swiftly', failures(2)), 'vehicles', BOTH_READY, T0 + 31)).toBe('swiftly');
    const three = replay('vehicles', 'swiftly', failures(3));
    expect(resolveProvider(three, 'vehicles', BOTH_READY, T0 + 61)).toBe('transitland');
    expect(skipReason(three, 'vehicles', 'swiftly', READY, T0 + 61)).toBe('failing');
  });

  it('fails over after 3 failures in a row: a success in between resets the count', () => {
    const interrupted = replay('vehicles', 'swiftly', [['failed', T0], ['failed', T0 + 30], ['ok', T0 + 60], ['failed', T0 + 90]]);
    expect(interrupted.vehicles.swiftly).toEqual({ consecutive: 1, lastFailureAt: T0 + 90 });
    expect(resolveProvider(interrupted, 'vehicles', BOTH_READY, T0 + 91)).toBe('swiftly');
  });

  it('re-probes the primary after 300 s: benched until then, tried again at 300 s', () => {
    const benched = replay('vehicles', 'swiftly', failures(3));
    const lastFailure = T0 + 60;
    expect(resolveProvider(benched, 'vehicles', BOTH_READY, lastFailure + 299)).toBe('transitland');
    expect(resolveProvider(benched, 'vehicles', BOTH_READY, lastFailure + 300)).toBe('swiftly');
  });

  it('re-probes the primary after 300 s: a failed re-probe benches it 300 s more, a good one restores it', () => {
    const reprobe = T0 + 60 + 300;
    const failedAgain = replay('vehicles', 'swiftly', [['failed', reprobe]], replay('vehicles', 'swiftly', failures(3)));
    expect(resolveProvider(failedAgain, 'vehicles', BOTH_READY, reprobe + 299)).toBe('transitland');
    expect(resolveProvider(failedAgain, 'vehicles', BOTH_READY, reprobe + 300)).toBe('swiftly');
    const recovered = replay('vehicles', 'swiftly', [['ok', reprobe]], replay('vehicles', 'swiftly', failures(3)));
    expect(recovered.vehicles.swiftly).toEqual({ consecutive: 0, lastFailureAt: null });
    expect(resolveProvider(recovered, 'vehicles', BOTH_READY, reprobe + 1)).toBe('swiftly');
  });

  it('every provider benched: none (the schedule alone) until a re-probe is due', () => {
    const both = replay('vehicles', 'transitland', failures(3), replay('vehicles', 'swiftly', failures(3)));
    expect(resolveProvider(both, 'vehicles', BOTH_READY, T0 + 61)).toBe('none');
    expect(resolveProvider(both, 'vehicles', BOTH_READY, T0 + 60 + 300)).toBe('swiftly');
  });
});

describe('provider chain (M4.4): keys and quota', () => {
  it('a provider with no key is skipped (day one: Transitland only)', () => {
    const transitlandOnly: Standings = { swiftly: { ...READY, hasKey: false }, transitland: READY };
    expect(skipReason(initialChainState(), 'vehicles', 'swiftly', transitlandOnly.swiftly, T0)).toBe('no-key');
    expect(resolveProvider(initialChainState(), 'vehicles', transitlandOnly, T0)).toBe('transitland');
    expect(resolveProvider(initialChainState(), 'predictions', transitlandOnly, T0)).toBe('transitland');
  });

  it('skips transitland at 9500 calls this month (95% of 10,000)', () => {
    const atLimit: Standings = { swiftly: { ...READY, hasKey: false }, transitland: { ...READY, callsThisMonth: 9_500 } };
    expect(skipReason(initialChainState(), 'vehicles', 'transitland', atLimit.transitland, T0)).toBe('quota');
    expect(resolveProvider(initialChainState(), 'vehicles', atLimit, T0)).toBe('none');
    expect(resolveProvider(initialChainState(), 'predictions', { ...atLimit, transitland: { ...READY, callsThisMonth: 9_999 } }, T0)).toBe('none');
  });

  it('keeps transitland at 9499 calls this month', () => {
    const justUnder: Standings = { swiftly: { ...READY, hasKey: false }, transitland: { ...READY, callsThisMonth: 9_499 } };
    expect(skipReason(initialChainState(), 'vehicles', 'transitland', justUnder.transitland, T0)).toBeNull();
    expect(resolveProvider(initialChainState(), 'vehicles', justUnder, T0)).toBe('transitland');
  });

  it('swiftly publishes no quota, so no call count benches it', () => {
    expect(skipReason(initialChainState(), 'vehicles', 'swiftly', { ...READY, callsThisMonth: 1_000_000 }, T0)).toBeNull();
    expect(resolveProvider(initialChainState(), 'vehicles', { swiftly: { ...READY, callsThisMonth: 1_000_000 }, transitland: READY }, T0)).toBe('swiftly');
  });
});
