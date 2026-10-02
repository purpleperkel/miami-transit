import { decodeUtf8 } from '@/domain/gtfsrt/utf8';
import type { LiveError } from '@/domain/live/types';
import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';
import type { FetchFn, FetchResponseLike } from '@/live/http';

/**
 * mfix9: one GET of a routed-walk (one-to-many) URL for RoutedWalkProvider, through the fetch it hands in — the app's
 * typed HTTP, src/live/http.ts's EXPO_FETCH, whose arrayBuffer() is binary-safe on Hermes. http.ts's httpGet is typed
 * to the realtime providers (a ProviderId, a ByteCounter per provider), so this module keeps its own abort timer over
 * the WHOLE exchange (headers and body) and maps every failure to the same typed LiveErrors, never a throw:
 *
 *   a status outside 200–299                     → { kind: 'http', status }
 *   fetch or the body read rejects               → { kind: 'network' }
 *   the timer fired, or the provider cancelled   → { kind: 'timeout' }
 *   a 2xx body that is not JSON                  → { kind: 'decode' }
 */

/** A walk answer that takes longer than this is abandoned (a 'timeout'; the provider backs off). */
export const WALK_TIMEOUT_MS = 15_000;

/** One one-to-many GET: its URL and its headers (exactly the User-Agent). */
export type WalkGet = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** The abort the exchange runs under: WALK_TIMEOUT_MS, or the provider's own signal, whichever fires first. */
type WalkTimer = { readonly signal: AbortSignal; timedOut(): boolean; dispose(): void };

/** GETs `request` through `fetchFn`: the parsed JSON body of a 2xx answer, or a typed LiveError. Never rejects. */
export async function fetchWalkJson(fetchFn: FetchFn, request: WalkGet, signal: AbortSignal): Promise<Result<unknown, LiveError>> {
  const host = /^https:\/\/([^/?#]+)/.exec(request.url)?.[1] ?? '';
  invariant(host.length > 0, `a walk is asked for over HTTPS from a named host, got ${request.url}`);
  invariant(!signal.aborted, 'a walk is asked for by a provider that is still mounted');
  const timer = walkTimer(signal);
  try {
    const response = await fetchFn(request.url, { method: 'GET', headers: request.headers, signal: timer.signal });
    if (!response.ok) {
      return err({ kind: 'http', status: response.status, message: `${host} answered HTTP ${response.status}` });
    }
    return await bodyJson(response, host);
  } catch (error) {
    return err(failureOf(error, host, timer, signal));
  } finally {
    timer.dispose();
  }
}

/** An abort controller fired by WALK_TIMEOUT_MS or by `outer` (the provider unmounting); dispose() once the exchange is over. */
function walkTimer(outer: AbortSignal): WalkTimer {
  invariant(!outer.aborted, 'the timer starts with the request');
  const controller = new AbortController();
  const state = { timedOut: false };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, WALK_TIMEOUT_MS);
  const forward = { handleEvent: () => controller.abort() };
  outer.addEventListener('abort', forward);
  invariant(!controller.signal.aborted, 'the exchange starts un-aborted');
  return {
    signal: controller.signal,
    timedOut: () => state.timedOut,
    dispose: () => {
      clearTimeout(timeout);
      outer.removeEventListener('abort', forward);
    },
  };
}

/** A 2xx answer's whole body as JSON (read under the timer), or a decode failure. */
async function bodyJson(response: FetchResponseLike, host: string): Promise<Result<unknown, LiveError>> {
  invariant(response.ok, 'only a 2xx body is read as walks');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = decodeUtf8(bytes);
  invariant(text.length <= bytes.byteLength, 'UTF-8 never decodes to more UTF-16 units than it has bytes');
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err({ kind: 'decode', message: `${host}'s walk answer is not JSON (${error instanceof Error ? error.message : String(error)})` });
  }
}

/** A rejected fetch or body read: our timer fired, or the provider cancelled → timeout; anything else → network. */
function failureOf(error: unknown, host: string, timer: WalkTimer, outer: AbortSignal): LiveError {
  invariant(error !== undefined, 'a rejection carries a reason');
  const reason = error instanceof Error ? error.message : String(error);
  const failure: LiveError = timer.timedOut()
    ? { kind: 'timeout', message: `${host} did not answer within ${WALK_TIMEOUT_MS / 1000} s` }
    : outer.aborted
      ? { kind: 'timeout', message: `the walk request to ${host} was cancelled before it finished` }
      : { kind: 'network', message: `${host} could not be reached: ${reason}` };
  invariant(failure.kind !== 'network' || !timer.signal.aborted, 'a network failure is never one our own abort caused');
  return failure;
}
