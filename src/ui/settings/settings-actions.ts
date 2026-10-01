import { Alert, Linking } from 'react-native';

import type { ProviderId } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';
import { detach } from '@/live/detach';
import type { LiveRuntime } from '@/live/runtime';

import { PROVIDER_NAMES } from './settings-text';

/**
 * What the Data & Settings controls DO (plan M8b.1). Keys and the agency key go ONLY through the live
 * runtime (saveKey / clearKey / saveSwiftlyAgency), which writes the Keychain through src/live/keys.ts
 * and puts the change in effect at once — the "paste → Live" path of M8.4. Each action settles to a
 * Notice for the screen; none ever carries a key (keys.ts messages never contain one).
 */

export type Notice = { readonly tone: 'ok' | 'error'; readonly text: string };

const NOT_RUNNING: Notice = Object.freeze({ tone: 'error', text: 'Live data is not running yet — the schedule is still opening. Try again in a moment.' });

/**
 * Runs an action without blocking the tap and shows the Notice it settles to (null clears it). The
 * actions return Results, so a rejection is a bug; it is shown as an error notice, never lost.
 */
export function runAction(work: Promise<Notice | null>, show: (notice: Notice | null) => void): void {
  invariant(typeof work.then === 'function', 'an action is a promise');
  invariant(typeof show === 'function', 'an action shows its outcome');
  detach(work.then(show), (message) => show({ tone: 'error', text: `Something went wrong: ${message}` }));
}

/** Stores a pasted API key through the runtime (trimmed; a bad paste is refused and nothing is stored). */
export async function saveKeyNotice(runtime: LiveRuntime | null, provider: ProviderId, pasted: string): Promise<Notice> {
  invariant(typeof pasted === 'string', 'a pasted key is text');
  if (runtime === null) {
    return NOT_RUNNING;
  }
  const saved = await runtime.saveKey(provider, pasted);
  invariant(saved.ok || saved.error.message.length > 0, 'a refusal explains itself');
  return saved.ok ? { tone: 'ok', text: `${PROVIDER_NAMES[provider]} key saved. Live data starts at the next update.` } : { tone: 'error', text: sentence(saved.error.message) };
}

/** Removes a provider's key through the runtime. */
export async function clearKeyNotice(runtime: LiveRuntime | null, provider: ProviderId): Promise<Notice> {
  invariant(provider in PROVIDER_NAMES, `"${provider}" is a realtime provider`);
  if (runtime === null) {
    return NOT_RUNNING;
  }
  const cleared = await runtime.clearKey(provider);
  invariant(cleared.ok || cleared.error.message.length > 0, 'a failure explains itself');
  return cleared.ok ? { tone: 'ok', text: `${PROVIDER_NAMES[provider]} key removed.` } : { tone: 'error', text: sentence(cleared.error.message) };
}

/** Stores Swiftly's agency key through the runtime (blank restores the default, miami). */
export async function saveAgencyNotice(runtime: LiveRuntime | null, pasted: string): Promise<Notice> {
  invariant(typeof pasted === 'string', 'an agency key is text');
  if (runtime === null) {
    return NOT_RUNNING;
  }
  const saved = await runtime.saveSwiftlyAgency(pasted);
  invariant(saved.ok || saved.error.message.length > 0, 'a refusal explains itself');
  return saved.ok ? { tone: 'ok', text: `Swiftly agency key saved: ${saved.value}.` } : { tone: 'error', text: sentence(saved.error.message) };
}

/** Asks before removing a key; the destructive choice removes it. */
export function confirmClearKey(runtime: LiveRuntime | null, provider: ProviderId, show: (notice: Notice | null) => void): void {
  const name = PROVIDER_NAMES[provider];
  invariant(name !== undefined, `"${provider}" is a realtime provider`);
  invariant(typeof show === 'function', 'removing a key shows its outcome');
  Alert.alert(`Remove the ${name} key?`, `Live data from ${name} stops until a key is pasted again.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => runAction(clearKeyNotice(runtime, provider), show) },
  ]);
}

/**
 * Opens `url` in Safari. Per the M1.19 phone run, openURL RESOLVING means it opened and REJECTING
 * means it did not; the resolved value is never read (on iOS 27 it resolved falsy for a link that opened).
 */
export async function openLinkNotice(url: string): Promise<Notice | null> {
  invariant(url.startsWith('https://'), 'attribution links are https');
  const opened = await openUrl(url);
  invariant(opened.ok || opened.error.length > 0, 'a failure explains itself');
  return opened.ok ? null : { tone: 'error', text: opened.error };
}

async function openUrl(url: string): Promise<Result<null, string>> {
  invariant(url.length > 0, 'a link has a URL');
  invariant(typeof Linking.openURL === 'function', 'React Native provides Linking.openURL');
  try {
    await Linking.openURL(url);
    return ok(null);
  } catch (error) {
    return err(`Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A message as a sentence: first letter capitalised. */
function sentence(message: string): string {
  invariant(message.length > 0, 'a message says something');
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  invariant(text.length === message.length, 'capitalising keeps the message whole');
  return text;
}
