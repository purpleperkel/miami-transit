import { fetch as expoFetch } from 'expo/fetch';

import type { LiveRequest } from '../domain/live/transports';
import { type LiveError, PROVIDER_IDS, type ProviderId } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import { err, ok, type Result } from '../lib/result';

/**
 * Plan M4.8: the one place the app talks to a realtime provider. It performs a LiveRequest (a pure
 * request built by src/domain/live/transports.ts) through expo/fetch — whose arrayBuffer() is
 * binary-safe on Hermes (falsifier R6) — and turns every way a request can go wrong into a typed
 * LiveError value, never a throw:
 *
 *   the request's own abort timer fires (8 s)   → { kind: 'timeout' }
 *   the caller aborts (the runtime shut down)   → { kind: 'timeout' }, saying it was cancelled
 *   fetch rejects (offline, DNS, TLS, reset)    → { kind: 'network' }
 *   the body stops arriving part-way            → 'timeout' or 'network', by the same rules
 *   a response outside 200–299                  → { kind: 'http', status }
 *
 * The timer covers the whole exchange — headers AND body — so a stalled download cannot hang a poll.
 * Nothing here logs a header: the key travels only in headers (transports.ts), never in a URL.
 *
 * BYTE COUNTER: every response body read — 2xx or not — is added to its provider's tally in a
 * ByteCounter. That is the cellular-data meter Diagnostics shows (§4 Polling, falsifier R19). A body
 * is counted as delivered to JS (after any gzip decoding), so the tally is an upper bound on what
 * crossed the radio.
 */

export type HttpInit = {
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

/** The part of a fetch Response http.ts reads. expo/fetch's FetchResponse satisfies it. */
export type FetchResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** A fetch implementation: expo/fetch on the phone (the default), a fake in tests. */
export type FetchFn = (url: string, init: HttpInit) => Promise<FetchResponseLike>;

/** A successful (2xx) response: its body bytes and when they finished arriving. */
export type HttpBody = {
  readonly provider: ProviderId;
  readonly status: number;
  readonly body: Uint8Array;
  /** Epoch second the body finished arriving. */
  readonly receivedAt: number;
};

/** One provider's traffic so far: bodies read, their total size, and the latest one's size. */
export type ByteTally = {
  readonly responses: number;
  readonly bytes: number;
  /** The latest response body's size, or null before the first response. */
  readonly lastBytes: number | null;
  /** Epoch second of the latest response, or null before the first. */
  readonly lastAt: number | null;
};

export type ByteTallies = Readonly<Record<ProviderId, ByteTally>>;

const EMPTY_TALLY: ByteTally = Object.freeze({ responses: 0, bytes: 0, lastBytes: null, lastAt: null });

/** Response bytes per provider since the counter was made (one app session). */
export class ByteCounter {
  private readonly tallies = new Map<ProviderId, ByteTally>();

  /** Adds one response body of `bytes` received at `atS`; returns the provider's new tally. */
  add(provider: ProviderId, bytes: number, atS: number): ByteTally {
    invariant(Number.isSafeInteger(bytes) && bytes >= 0, `a body size is a whole number of bytes, got ${bytes}`);
    invariant(Number.isFinite(atS), 'a response arrives at an instant');
    const before = this.tally(provider);
    const after: ByteTally = Object.freeze({ responses: before.responses + 1, bytes: before.bytes + bytes, lastBytes: bytes, lastAt: atS });
    this.tallies.set(provider, after);
    return after;
  }

  /** The provider's tally: zero responses before its first. */
  tally(provider: ProviderId): ByteTally {
    invariant((PROVIDER_IDS as readonly string[]).includes(provider), `"${provider}" is a realtime provider`);
    const tally = this.tallies.get(provider) ?? EMPTY_TALLY;
    invariant(tally.lastBytes === null || tally.lastBytes <= tally.bytes, 'the latest body is part of the total');
    return tally;
  }

  /** Every provider's tally, for Diagnostics. */
  snapshot(): ByteTallies {
    const tallies = { swiftly: this.tally('swiftly'), transitland: this.tally('transitland') };
    invariant(PROVIDER_IDS.every((id) => tallies[id] !== undefined), 'every provider has a tally');
    invariant(Object.keys(tallies).length === PROVIDER_IDS.length, 'the snapshot holds only providers');
    return Object.freeze(tallies);
  }
}

export type HttpDeps = {
  readonly fetch: FetchFn;
  readonly counter: ByteCounter;
  /** The clock, in epoch seconds. */
  readonly nowS: () => number;
};

/** expo/fetch, typed as a FetchFn (its FetchResponse has every member FetchResponseLike reads). */
export const EXPO_FETCH: FetchFn = expoFetch;

/** Performs `request` (GET), aborted after `request.timeoutMs` or when `signal` aborts. Never throws for a failed exchange. */
export async function httpGet(request: LiveRequest, signal: AbortSignal, deps: HttpDeps): Promise<Result<HttpBody, LiveError>> {
  invariant(request.url.startsWith('https://'), 'live requests go over HTTPS');
  invariant(request.timeoutMs > 0, 'every live request has an abort timer');
  const host = hostOf(request.url);
  const abort = linkAbort(signal, request.timeoutMs);
  try {
    const response = await send(request, abort, deps.fetch, host);
    if (!response.ok) {
      return response;
    }
    const body = await readBody(response.value, abort, host);
    if (body.ok) {
      deps.counter.add(request.provider, body.value.byteLength, deps.nowS());
    }
    if (!response.value.ok) {
      return err(statusError(response.value.status, host));
    }
    return body.ok ? ok({ provider: request.provider, status: response.value.status, body: body.value, receivedAt: deps.nowS() }) : body;
  } finally {
    abort.dispose();
  }
}

/** The request's headers arrive (any status), or why they did not. */
async function send(request: LiveRequest, abort: LinkedAbort, fetchFn: FetchFn, host: string): Promise<Result<FetchResponseLike, LiveError>> {
  invariant(request.headers !== undefined, 'a live request carries its (auth) headers');
  invariant(!abort.disposed(), 'a request is sent under a live abort timer');
  try {
    const response = await fetchFn(request.url, { method: 'GET', headers: request.headers, signal: abort.signal });
    invariant(Number.isInteger(response.status), 'a response has a numeric status');
    return ok(response);
  } catch (error) {
    return err(failure(abort, error, host));
  }
}

/** The whole body as bytes, or why it did not finish arriving. */
async function readBody(response: FetchResponseLike, abort: LinkedAbort, host: string): Promise<Result<Uint8Array, LiveError>> {
  invariant(typeof response.arrayBuffer === 'function', 'a response body can be read as bytes');
  invariant(!abort.disposed(), 'a body is read under a live abort timer');
  try {
    const buffer = await response.arrayBuffer();
    return ok(new Uint8Array(buffer));
  } catch (error) {
    return err(failure(abort, error, host));
  }
}

/** A rejected fetch or body read as a LiveError: our timer fired → timeout; the caller aborted → timeout (cancelled); else network. */
function failure(abort: LinkedAbort, error: unknown, host: string): LiveError {
  invariant(error !== undefined, 'a rejection carries a reason');
  const reason = error instanceof Error ? error.message : String(error);
  const failed: LiveError = abort.timedOut()
    ? { kind: 'timeout', message: `${host} did not answer within ${abort.timeoutMs / 1000} s` }
    : abort.cancelled()
      ? { kind: 'timeout', message: `the request to ${host} was cancelled before it finished` }
      : { kind: 'network', message: `${host} could not be reached: ${reason}` };
  invariant(failed.message.length > 0, 'a failure explains itself');
  return failed;
}

function statusError(status: number, host: string): LiveError {
  invariant(Number.isInteger(status) && (status < 200 || status > 299), `only a non-2xx status is an http error, got ${status}`);
  const error: LiveError = { kind: 'http', status, message: `${host} answered HTTP ${status}` };
  invariant(error.kind === 'http' && error.status === status, 'the error carries the status');
  return error;
}

/** The URL's host, for messages (a URL never holds the key, so it is safe to show). */
function hostOf(url: string): string {
  const host = /^https:\/\/([^/?#]+)/.exec(url)?.[1] ?? '';
  invariant(host.length > 0, `"${url}" names a host`);
  invariant(!host.includes('/'), 'a host is a single URL component');
  return host;
}

/** An abort signal that fires after `timeoutMs` or when `outer` aborts, whichever comes first. */
type LinkedAbort = {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  timedOut(): boolean;
  cancelled(): boolean;
  disposed(): boolean;
  /** Clears the timer and stops listening to `outer`; call once the exchange is over. */
  dispose(): void;
};

function linkAbort(outer: AbortSignal, timeoutMs: number): LinkedAbort {
  invariant(Number.isFinite(timeoutMs) && timeoutMs > 0, 'an abort timer has a positive duration');
  const controller = new AbortController();
  const state = { timedOut: false, disposed: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = { handleEvent: () => controller.abort() };
  if (outer.aborted) {
    controller.abort();
  } else {
    outer.addEventListener('abort', forward);
  }
  invariant(!outer.aborted || controller.signal.aborted, 'an already-aborted caller aborts the request at once');
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => state.timedOut,
    cancelled: () => outer.aborted,
    disposed: () => state.disposed,
    dispose: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', forward);
      state.disposed = true;
    },
  };
}
