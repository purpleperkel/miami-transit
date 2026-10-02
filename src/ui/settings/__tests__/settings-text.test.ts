import manifest from '../../../../assets/db/manifest.json';
import type { CapabilityStatus } from '../../../live/poller';
import type { LiveState } from '../../../live/runtime';
import { providerHealth } from '../provider-health';
import { expiryText, formatAge, formatBytes, groupDigits, keyStatusText, paceDraft, paceText, quotaText } from '../settings-text';

/**
 * M8b.1: the words and numbers Data & Settings shows, as pure functions — and the provider health
 * cases a single-key runtime cannot reach (standby behind Swiftly, benched while Swiftly serves).
 */

const NOW = Date.UTC(2026, 9, 1, 16) / 1000;
const IDLE: CapabilityStatus = { provider: 'none', failing: false, consecutiveFailures: 0, lastError: null };
const NO_BYTES = { responses: 0, bytes: 0, lastBytes: null, lastAt: null };

/** A published state with nothing fetched; `over` replaces fields. */
function state(over: Partial<LiveState> = {}): LiveState {
  const base: LiveState = {
    vehicles: null,
    predictions: new Map(),
    status: { vehicles: IDLE, predictions: IDLE },
    bytes: { swiftly: NO_BYTES, transitland: NO_BYTES },
    callsThisMonth: { swiftly: 0, transitland: 0 },
    hasKey: { swiftly: true, transitland: true },
    keyHints: { swiftly: '••••SWFT', transitland: '••••WXYZ' },
    swiftlyAgency: 'miami',
    keysError: null,
    internalError: null,
    swiftlyGated: false,
  };
  expect(base.status.vehicles.provider).toBe('none');
  expect(Object.keys(over).every((key) => key in base)).toBe(true);
  return { ...base, ...over };
}

/** Both capabilities served by `provider`. */
function servedBy(provider: 'swiftly' | 'transitland', failing = false): LiveState['status'] {
  const status: CapabilityStatus = { provider, failing, consecutiveFailures: failing ? 3 : 0, lastError: null };
  expect(status.provider).toBe(provider);
  expect(status.failing).toBe(failing);
  return { vehicles: status, predictions: status };
}

describe('settings text (M8b.1): numbers', () => {
  it('counts group their thousands; the quota row names the provider\'s monthly quota', () => {
    expect([groupDigits(0), groupDigits(999), groupDigits(1234), groupDigits(10_000), groupDigits(1_234_567)]).toEqual(['0', '999', '1,234', '10,000', '1,234,567']);
    expect(quotaText('transitland', 9)).toBe('9 of 10,000 this month');
    expect(quotaText('swiftly', 1234)).toBe('1,234 calls this month');
  });

  it('sizes, ages and paces read the way the screen shows them', () => {
    expect([formatBytes(512), formatBytes(1337), formatBytes(56 * 1024), formatBytes(1024 * 1024)]).toEqual(['512 B', '1.3 KB', '56.0 KB', '1.0 MB']);
    expect([formatAge(0), formatAge(12), formatAge(151), formatAge(7200), formatAge(-3)]).toEqual(['just now', '12 s ago', '2 min ago', '2 h ago', 'just now']);
    expect([paceText(1.35), paceText(2.7), paceDraft(2.7), paceDraft(1.333)]).toEqual(['1.35 m/s · 3.0 mph', '2.7 m/s · 6.0 mph', '2.7', '1.33']);
  });
});

describe('settings text (M8b.1): key and schedule', () => {
  it('a key reads "Saved ••••<last4>", "Not set", or why the Keychain could not tell', () => {
    expect(keyStatusText(state(), 'transitland')).toBe('Saved ••••WXYZ');
    expect(keyStatusText(state({ hasKey: { swiftly: false, transitland: true }, keyHints: { swiftly: null, transitland: '••••WXYZ' } }), 'swiftly')).toBe('Not set');
    const locked = state({ hasKey: { swiftly: false, transitland: false }, keyHints: { swiftly: null, transitland: null }, keysError: { kind: 'keychain', message: 'could not read the swiftly key: locked' } });
    expect(keyStatusText(locked, 'swiftly')).toBe('Unknown · could not read the swiftly key: locked');
    expect(keyStatusText(null, 'swiftly')).toBe('Checking the Keychain…');
  });

  it('the expiry names the mode that runs out first: current, ending soon, almost out, expired', () => {
    const railEnd = manifest.serviceEnd.rail.epoch;
    expect(expiryText(NOW)).toEqual({ state: 'ok', text: 'Current · rail runs out in 53 days' });
    expect(expiryText(railEnd - 10 * 86_400)).toEqual({ state: 'warn', text: 'Ending soon · rail runs out in 10 days' });
    expect(expiryText(railEnd - 86_400)).toEqual({ state: 'urgent', text: 'Almost out · rail runs out in 1 day' });
    expect(expiryText(railEnd + 1)).toEqual({ state: 'expired', text: 'Expired · rail service ended Nov 22' });
  });
});

describe('provider health (M8b.1): states a one-key runtime never reaches', () => {
  it('a keyed provider behind one that serves everything is on standby', () => {
    const health = providerHealth(state({ status: servedBy('swiftly') }), 'transitland', NOW);
    expect(health).toEqual({ kind: 'standby', text: 'Standby · Swiftly serves' });
  });

  it('a provider the chain benched while one after it serves is failing, even though it serves nothing', () => {
    expect(providerHealth(state({ status: servedBy('transitland') }), 'swiftly', NOW)).toEqual({ kind: 'failing', text: 'Failing · benched for vehicles and predictions' });
    expect(providerHealth(state({ status: servedBy('transitland', true) }), 'transitland', NOW).kind).toBe('failing');
  });

  it('before the runtime publishes the row says Starting; before the first heartbeat, Waiting', () => {
    expect(providerHealth(null, 'transitland', NOW)).toEqual({ kind: 'starting', text: 'Starting…' });
    expect(providerHealth(state(), 'transitland', NOW)).toEqual({ kind: 'waiting', text: 'Waiting for the first update' });
  });
});
