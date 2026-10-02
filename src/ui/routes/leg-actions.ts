import { appleMapsUrl, type DirectionsMode, openAppleMaps, type OpenUrl } from '../../domain/handoff/apple-maps';
import type { Leg } from '../../domain/routes/transitous';
import { isLatLon, type LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { copy } from '../copy';

/**
 * Plan M10b.2: what the itinerary's buttons do. A walk leg's "Directions" hands the walk to Apple Maps
 * (dirflg=w) toward the leg's end — m10a's leg.to — and the unavailable state's "Open in Apple Maps"
 * asks Apple Maps for the whole trip by transit (dirflg=r). Both URLs come from the app's ONE builder,
 * m6b's src/domain/handoff/apple-maps.ts (ruling R5), and so does the opening: the Maps app first, then
 * at most its https://maps.apple.com fallback.
 *
 * THE HANDOFF RULE (M1.19): React Native's Linking.openURL is Promise<void>. A resolution — with any
 * value — means the link opened; only a rejection is a failure, and it comes back as an err naming the
 * link (this module never throws for a refused link, and never reads the value openURL resolved with).
 */

/** A destination as the route screens carry it (the recent places' shape). */
export type MapsPoint = { readonly lat: number; readonly lon: number };

/** The link opened: the URL the system accepted, and whether that was the web fallback. */
export type LinkOpened = { readonly url: string; readonly fellBack: boolean };

/** The link would not open: which link, and why the last attempt was refused. */
export type LinkFailed = { readonly kind: 'link-failed'; readonly link: string; readonly message: string };

/** Apple Maps walking directions to `to`: maps://?daddr=<lat>,<lon>&dirflg=w. */
export function walkDirectionsUrl(to: MapsPoint): string {
  invariant(Number.isFinite(to.lat) && Number.isFinite(to.lon), 'walk directions lead to a coordinate');
  const url = appleMapsUrl(latLonOf(to), 'walk');
  invariant(url.startsWith('maps://?daddr=') && url.endsWith('&dirflg=w'), `a walk link reads maps://…&dirflg=w, got ${url}`);
  return url;
}

/** Apple Maps transit directions to `to`: maps://?daddr=<lat>,<lon>&dirflg=r. */
export function transitDirectionsUrl(to: MapsPoint): string {
  invariant(Number.isFinite(to.lat) && Number.isFinite(to.lon), 'transit directions lead to a coordinate');
  const url = appleMapsUrl(latLonOf(to), 'transit');
  invariant(url.startsWith('maps://?daddr=') && url.endsWith('&dirflg=r'), `a transit link reads maps://…&dirflg=r, got ${url}`);
  return url;
}

/** Where a leg's walk leads: its end (m10a's leg.to). */
export function legTarget(leg: Leg): MapsPoint {
  invariant(isLatLon(leg.to), `a leg ends at a real coordinate: ${leg.to.latitude},${leg.to.longitude}`);
  const target = { lat: leg.to.latitude, lon: leg.to.longitude };
  invariant(Number.isFinite(target.lat) && Number.isFinite(target.lon), 'the target is a coordinate');
  return target;
}

/** The Maps app link `walkDirectionsUrl` or `transitDirectionsUrl` built, read back; null for any other text. */
const MAPS_LINK = /^maps:\/\/\?daddr=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)&dirflg=([rw])$/;

/**
 * Opens an Apple Maps directions link through `openURL` (React Native's Linking.openURL): the Maps app,
 * then — only if the system refuses it — the same directions on https://maps.apple.com, by
 * m6b's openAppleMaps. Resolves ok on any resolution of openURL; an err naming `url` when both are refused.
 */
export async function openDirections(url: string, openURL: OpenUrl): Promise<Result<LinkOpened, LinkFailed>> {
  invariant(typeof openURL === 'function', 'directions are opened through an opener');
  const target = directionsTarget(url);
  if (target === null) {
    return err({ kind: 'link-failed', link: url, message: 'it is not an Apple Maps directions link this app builds' });
  }
  invariant(appleMapsUrl(target.destination, target.mode) === url, `${url} is the link the one builder makes`);
  const opened = await openAppleMaps(target.destination, target.mode, (link) => Promise.resolve(link).then(openURL));
  return opened.ok ? ok(opened.value) : err({ kind: 'link-failed', link: url, message: opened.error.message });
}

/** The destination and mode of a Maps app link the one builder makes; null for any other text. */
function directionsTarget(url: string): { readonly destination: LatLon; readonly mode: DirectionsMode } | null {
  invariant(typeof url === 'string', 'a link is text');
  const match = MAPS_LINK.exec(url);
  const destination: LatLon | null = match === null ? null : { latitude: Number(match[1]), longitude: Number(match[2]) };
  if (match === null || destination === null || !isLatLon(destination)) {
    return null;
  }
  const mode: DirectionsMode = match[3] === 'w' ? 'walk' : 'transit';
  invariant(mode === 'walk' || match[3] === 'r', 'a Maps link walks or rides transit');
  return appleMapsUrl(destination, mode) === url ? { destination, mode } : null;
}

/** Opens a web page (an attribution's source) through `openURL`: ok on any resolution, an err naming the link on a rejection. */
export async function openLink(url: string, openURL: OpenUrl): Promise<Result<LinkOpened, LinkFailed>> {
  invariant(/^https:\/\/\S+$/.test(url), `only https pages are opened as links, got ${url}`);
  invariant(typeof openURL === 'function', 'a link is opened through an opener');
  return Promise.resolve(url)
    .then(openURL)
    .then(
      () => ok({ url, fellBack: false }),
      (error: unknown) => err({ kind: 'link-failed' as const, link: url, message: messageOf(error) }),
    );
}

/** What the screen says under a button whose link did not open: "Apple Maps did not open: …" for directions. */
export function failureText(failure: LinkFailed): string {
  invariant(failure.link.length > 0, 'a failure names its link');
  const lead = failure.link.startsWith('maps://') ? copy.mapsFailed : copy.pageFailed;
  const text = `${lead}: ${failure.message}`;
  invariant(text.startsWith(lead) && text.length > lead.length + 2, 'a failure is said in the app\'s words, with why');
  return text;
}

/** What a refused link says: the error's message, else the link itself. */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  invariant(typeof message === 'string', 'a refusal has a message');
  const said = message.trim().length > 0 ? message : 'the system would not open it';
  invariant(said.length > 0, 'a message is never empty');
  return said;
}

function latLonOf(point: MapsPoint): LatLon {
  invariant(typeof point === 'object' && point !== null, 'a destination is a { lat, lon } point');
  const latLon = { latitude: point.lat, longitude: point.lon };
  invariant(isLatLon(latLon), `a destination is a real coordinate, got ${point.lat},${point.lon}`);
  return latLon;
}
