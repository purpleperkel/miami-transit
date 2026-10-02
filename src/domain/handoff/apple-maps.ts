import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * Plan M7.6 (R5): the Apple Maps handoff — one URL builder for every "Directions" button in the app
 * (the station sheet's walk directions first, then the trip and route screens). Pure: no React Native
 * here; the caller passes its opener (React Native's `Linking.openURL`).
 *
 *   transit  maps://?daddr=25.7759,-80.1961&dirflg=r
 *   walk     maps://?daddr=25.7759,-80.1961&dirflg=w
 *   fallback https://maps.apple.com/?daddr=…&dirflg=…   (the same directions on Apple's web host)
 *
 * THE HANDOFF RULE (M1.19 RESULT): React Native's `Linking.openURL` is `Promise<void>`. A RESOLVED
 * promise means the system opened the URL, whatever value it carries (undefined on the phone); only a
 * REJECTION is a failure. The resolved value is never read — the m1c probe that read it reported a
 * false failure while Apple Maps sat open on the screen.
 */

/** How Apple Maps routes to the destination: by public transit, or on foot. */
export type DirectionsMode = 'transit' | 'walk';

/** Apple Maps' `dirflg` letter for each mode (r = public transit, w = walking). */
const DIRFLG: Readonly<Record<DirectionsMode, string>> = { transit: 'r', walk: 'w' };

/** Where the URL is opened: the Maps app's own scheme, or Apple's web host (which hands over to the app). */
export type MapsHost = 'app' | 'web';

const HOST_PREFIX: Readonly<Record<MapsHost, string>> = { app: 'maps://?', web: 'https://maps.apple.com/?' };

/** Coordinates to 6 decimals (about 0.1 m), with no trailing zeros: 25.7759 stays "25.7759". */
const COORDINATE_DECIMALS = 1e6;

/** The opener the handoff uses: React Native's Linking.openURL, or a test's stand-in. Its value is never read. */
export type OpenUrl = (url: string) => Promise<unknown>;

/** The handoff succeeded: the URL the system accepted, and whether it took the web fallback to get there. */
export type HandoffOpened = { readonly url: string; readonly fellBack: boolean };

/** Neither the Maps app nor its web host would open: both URLs, and why the last one was refused. */
export type HandoffFailed = { readonly kind: 'handoff-failed'; readonly urls: readonly string[]; readonly message: string };

/** Apple Maps directions to `destination` by `mode`, as the Maps app's URL (or its web host's). */
export function appleMapsUrl(destination: LatLon, mode: DirectionsMode, host: MapsHost = 'app'): string {
  invariant(isLatLon(destination), `directions need a real destination, got ${destination.latitude},${destination.longitude}`);
  invariant(mode in DIRFLG && host in HOST_PREFIX, `"${mode}" directions on the "${host}" host are ones Apple Maps takes`);
  const daddr = `${coordinateText(destination.latitude)},${coordinateText(destination.longitude)}`;
  return `${HOST_PREFIX[host]}daddr=${daddr}&dirflg=${DIRFLG[mode]}`;
}

/** One coordinate as the URL carries it: rounded to 6 decimals, no exponent, no trailing zeros. */
function coordinateText(degrees: number): string {
  invariant(Number.isFinite(degrees) && Math.abs(degrees) <= 180, `a coordinate is a finite angle, got ${degrees}`);
  const text = String(Math.round(degrees * COORDINATE_DECIMALS) / COORDINATE_DECIMALS);
  invariant(/^-?\d+(\.\d+)?$/.test(text), `${degrees} prints as plain decimal degrees, got ${text}`);
  return text;
}

/**
 * Opens Apple Maps with directions to `destination`: the Maps app first; if the system refuses that
 * URL (a rejection), the same directions on https://maps.apple.com. A resolution — of any value — is
 * success. Both refused is an Err naming both URLs and the last reason.
 */
export async function openAppleMaps(destination: LatLon, mode: DirectionsMode, open: OpenUrl): Promise<Result<HandoffOpened, HandoffFailed>> {
  invariant(typeof open === 'function', 'the handoff needs an opener');
  const urls = [appleMapsUrl(destination, mode, 'app'), appleMapsUrl(destination, mode, 'web')] as const;
  const first = await opened(open, urls[0]);
  if (first === null) {
    return ok({ url: urls[0], fellBack: false });
  }
  const second = await opened(open, urls[1]);
  invariant(urls[1].startsWith('https://maps.apple.com/'), 'the fallback is Apple\'s web host');
  return second === null ? ok({ url: urls[1], fellBack: true }) : err({ kind: 'handoff-failed', urls, message: second });
}

/** null when `open(url)` resolved (its value is never read); otherwise why it rejected. */
async function opened(open: OpenUrl, url: string): Promise<string | null> {
  invariant(url.length > 0, 'an opener opens a URL');
  const refusal = await open(url).then(
    () => null,
    (error: unknown) => (error instanceof Error && error.message.length > 0 ? error.message : `the system would not open ${url}`),
  );
  invariant(refusal === null || refusal.length > 0, 'a refusal says why');
  return refusal;
}
