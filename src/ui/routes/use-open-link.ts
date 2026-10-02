import { useCallback, useState } from 'react';
import { Linking } from 'react-native';

import type { OpenUrl } from '@/domain/handoff/apple-maps';
import { invariant } from '@/lib/invariant';
import type { Result } from '@/lib/result';

import { failureText, type LinkFailed, type LinkOpened } from './leg-actions';

/**
 * One button's link (plan M10b.2): pressing opens it through leg-actions.ts (openDirections for Apple
 * Maps, openLink for a web page), and the button remembers what to say when it did not open — cleared by
 * the next press that does. The opener is React Native's Linking.openURL unless a test passes its own.
 */

/** Opens a link through an opener: openDirections or openLink. */
export type LinkAction = (url: string, openURL: OpenUrl) => Promise<Result<LinkOpened, LinkFailed>>;

export type OpenLinkApi = {
  /** What to show under the button after a refusal, or null. */
  readonly failure: string | null;
  readonly open: (url: string) => void;
};

/** React Native's Linking.openURL (Promise<void>: success = resolve), the app's opener. */
export function linkingOpenURL(url: string): Promise<void> {
  invariant(url.length > 0, 'the system opens a link');
  invariant(typeof Linking.openURL === 'function', 'React Native opens links');
  return Linking.openURL(url);
}

export function useOpenLink(action: LinkAction, openURL: OpenUrl = linkingOpenURL): OpenLinkApi {
  const [failure, setFailure] = useState<string | null>(null);
  const open = useCallback((url: string) => startOpen(action, openURL, url, setFailure), [action, openURL]);
  invariant(typeof open === 'function', 'the button can open its link');
  invariant(failure === null || failure.includes(': '), 'a failure says what did not open and why');
  return { failure, open };
}

/** Starts opening `url` and reports the outcome: null when it opened, the failure's words when it did not. */
function startOpen(action: LinkAction, openURL: OpenUrl, url: string, report: (failure: string | null) => void): void {
  invariant(url.length > 0, 'a button opens a link');
  invariant(typeof report === 'function', 'the outcome is reported to the button');
  action(url, openURL).then(
    (opened) => report(opened.ok ? null : failureText(opened.error)),
    (error: unknown) => report(failureText({ kind: 'link-failed', link: url, message: String(error) })),
  );
}
