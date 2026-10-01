import scheduleManifest from '@/assets/db/manifest.json';
import { type ExpiryState, type ModeExpiry, scheduleExpiry } from '@/domain/expiry/expiry';
import { PROVIDER_CONFIG } from '@/domain/live/constants';
import type { ProviderId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import type { LiveState } from '@/live/runtime';
import { shortServiceDate } from '@/ui/diagnostics/data-version';

/**
 * The words and numbers Data & Settings shows (plan M8b.1), as pure functions of the live state and
 * the clock, so each is tested on its own. Nothing here ever sees a key: a stored key reaches the
 * screen only as the runtime's masked hint (keys.ts maskKey, "••••" + its last 4).
 */

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({ swiftly: 'Swiftly', transitland: 'Transitland' });

const KB = 1024;
const MB = KB * KB;
const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;
/** Age units, largest first: an age reads in the largest unit it has at least one of. */
const AGE_UNITS: readonly (readonly [number, string])[] = [
  [DAY_S, 'd'],
  [HOUR_S, 'h'],
  [MINUTE_S, 'min'],
  [1, 's'],
];
/** Metres per second → miles per hour (1 mile = 1609.344 m). */
const MPH_PER_MPS = 3600 / 1609.344;

/** A whole count with thousands separators: 1234 → "1,234". */
export function groupDigits(count: number): string {
  invariant(Number.isSafeInteger(count) && count >= 0, `a count is a whole number, got ${count}`);
  const digits = String(count);
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  const text = groups.join(',');
  invariant(text.split(',').join('') === digits, 'grouping only adds separators');
  return text;
}

/** The quota row: "1,234 of <monthly quota> this month", or "N calls this month" for a provider that publishes no quota. */
export function quotaText(provider: ProviderId, calls: number): string {
  invariant(Number.isSafeInteger(calls) && calls >= 0, `a call count is a whole number, got ${calls}`);
  const quota = PROVIDER_CONFIG[provider].monthlyQuota;
  const text = quota === null ? `${groupDigits(calls)} calls this month` : `${groupDigits(calls)} of ${groupDigits(quota)} this month`;
  invariant(text.startsWith(groupDigits(calls)), 'the row leads with the calls made');
  return text;
}

/** A body size: "512 B", "1.3 KB", "1.0 MB". */
export function formatBytes(bytes: number): string {
  invariant(Number.isFinite(bytes) && bytes >= 0, `a size is a non-negative number of bytes, got ${bytes}`);
  const whole = Math.round(bytes);
  const text = whole < KB ? `${whole} B` : whole < MB ? `${(whole / KB).toFixed(1)} KB` : `${(whole / MB).toFixed(1)} MB`;
  invariant(/^\d+(\.\d)? (B|KB|MB)$/.test(text), `"${text}" is a size with its unit`);
  return text;
}

/** How long ago something happened: "just now", "12 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function formatAge(ageS: number): string {
  invariant(Number.isFinite(ageS), `an age is a finite number of seconds, got ${ageS}`);
  const seconds = Math.max(0, Math.floor(ageS));
  const unit = AGE_UNITS.find(([size]) => seconds >= size);
  const text = unit === undefined ? 'just now' : `${Math.floor(seconds / unit[0])} ${unit[1]} ago`;
  invariant(unit !== undefined || seconds === 0, 'only a zero age is "just now"');
  return text;
}

/** A pace for display: "1.35 m/s · 3.0 mph" (at most two decimals of m/s). */
export function paceText(mps: number): string {
  invariant(Number.isFinite(mps) && mps > 0, `a pace is a positive speed, got ${mps}`);
  const text = `${Number(mps.toFixed(2))} m/s · ${(mps * MPH_PER_MPS).toFixed(1)} mph`;
  invariant(text.includes(' m/s · '), 'a pace reads in m/s first');
  return text;
}

/** A pace for an input field: at most two decimals, no trailing zeros ("2.7", "1.35"). */
export function paceDraft(mps: number): string {
  invariant(Number.isFinite(mps) && mps > 0, `a pace is a positive speed, got ${mps}`);
  const draft = String(Number(mps.toFixed(2)));
  invariant(/^\d+(\.\d{1,2})?$/.test(draft), `"${draft}" is a plain decimal`);
  return draft;
}

/** The key row: "Saved ••••WXYZ", "Not set", or why the Keychain could not tell. */
export function keyStatusText(state: LiveState | null, provider: ProviderId): string {
  invariant(provider in PROVIDER_NAMES, `"${provider}" is a realtime provider`);
  const hint = state === null ? null : state.keyHints[provider];
  let text = 'Not set';
  if (state === null) {
    text = 'Checking the Keychain…';
  } else if (hint !== null) {
    text = `Saved ${hint}`;
  } else if (state.keysError !== null) {
    text = `Unknown · ${state.keysError.message}`;
  }
  invariant(hint === null || text === `Saved ${hint}`, 'a stored key shows only as its masked hint');
  return text;
}

/** What the Schedule section says about expiry: the mode that runs out first, and how soon. */
export function expiryText(nowS: number): { readonly state: ExpiryState; readonly text: string } {
  const expiry = scheduleExpiry(scheduleManifest.serviceEnd, Math.floor(nowS));
  const first: ModeExpiry = expiry.rail.remainingS <= expiry.mover.remainingS ? expiry.rail : expiry.mover;
  const mode = first.mode === 'rail' ? 'rail' : 'Mover';
  const days = first.daysLeft === 1 ? '1 day' : `${first.daysLeft ?? 0} days`;
  const texts: Readonly<Record<ExpiryState, string>> = {
    ok: `Current · ${mode} runs out in ${days}`,
    warn: `Ending soon · ${mode} runs out in ${days}`,
    urgent: `Almost out · ${mode} runs out in ${days}`,
    expired: `Expired · ${mode} service ended ${shortServiceDate(first.end.date)}`,
  };
  const text = texts[first.state];
  invariant(first.remainingS <= Math.max(expiry.rail.remainingS, expiry.mover.remainingS), 'the mode that runs out first is named');
  invariant(text.length > 0, 'the expiry state always reads as something');
  return { state: first.state, text };
}
