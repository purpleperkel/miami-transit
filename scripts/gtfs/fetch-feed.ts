import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';

/**
 * Step 1 of the GTFS pipeline (plan §4): a conditional GET of the schedule zip. The caller hands
 * in the validators it stored from the last download; they go out as If-None-Match (the ETag) and
 * If-Modified-Since (the Last-Modified date). A 304 is `not-modified`. A 200 must carry zip bytes:
 * an HTML error page served with 200 is an Err, never a "feed".
 *
 * Only transport failures (fetch's TypeError, the timeout/abort DOMException) become Errs; any
 * other exception is a bug and is rethrown, not disguised as a network problem.
 */

export type FeedValidators = { readonly etag: string | null; readonly lastModified: string | null };
export const NO_VALIDATORS: FeedValidators = { etag: null, lastModified: null };

export type FetchOutcome =
  | { readonly kind: 'fresh'; readonly bytes: Uint8Array; readonly validators: FeedValidators }
  | { readonly kind: 'not-modified' };

export type FetchError = {
  readonly kind: 'network' | 'timeout' | 'http' | 'not-zip';
  readonly url: string;
  readonly status: number | null;
  readonly message: string;
};

/** The county zip is ~8.4 MB; two minutes covers a slow link without hanging the build forever. */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
/** A zip begins with a local file header: "PK\x03\x04". */
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const;

export async function fetchFeed(
  url: string,
  stored: FeedValidators,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Result<FetchOutcome, FetchError>> {
  invariant(/^https?:\/\//.test(url), `the feed URL is http(s), got "${url}"`);
  invariant(Number.isInteger(timeoutMs) && timeoutMs > 0, 'the fetch timeout is a positive whole number of ms');
  const headers = conditionalHeaders(stored);
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await transport(url, timeoutMs, () => fetch(url, { headers, signal, redirect: 'follow' }));
  if (!response.ok) {
    return response;
  }
  if (response.value.status !== 200) {
    const discarded = await transport(url, timeoutMs, () => discardBody(response.value));
    if (!discarded.ok) {
      return discarded;
    }
    return non200Outcome(url, response.value, Object.keys(headers).length > 0);
  }
  const body = await transport(url, timeoutMs, async () => new Uint8Array(await response.value.arrayBuffer()));
  if (!body.ok) {
    return body;
  }
  if (!isZip(body.value)) {
    return err(failure('not-zip', url, 200, `the 200 body (${body.value.length} bytes) is not a zip`));
  }
  return ok({ kind: 'fresh', bytes: body.value, validators: validatorsOf(response.value.headers) });
}

/** 304 to a conditional request → not-modified; any other non-200 (or an unasked-for 304) → Err. */
function non200Outcome(url: string, response: Response, conditional: boolean): Result<FetchOutcome, FetchError> {
  const { status, statusText } = response;
  invariant(status !== 200, 'non200Outcome only sees non-200 responses');
  if (status === 304 && conditional) {
    return ok({ kind: 'not-modified' });
  }
  const detail = status === 304 ? 'HTTP 304 to a request that sent no validators' : `HTTP ${status} ${statusText}`.trim();
  invariant(detail.startsWith('HTTP'), 'the detail leads with the status');
  return err(failure('http', url, status, detail));
}

/** If-None-Match and If-Modified-Since for whichever validators are stored. */
export function conditionalHeaders(stored: FeedValidators): Record<string, string> {
  invariant(stored.etag === null || stored.etag.length > 0, 'a stored ETag is null or non-empty');
  invariant(stored.lastModified === null || stored.lastModified.length > 0, 'a stored Last-Modified is null or non-empty');
  const headers: Record<string, string> = {};
  if (stored.etag !== null) {
    headers['If-None-Match'] = stored.etag;
  }
  if (stored.lastModified !== null) {
    headers['If-Modified-Since'] = stored.lastModified;
  }
  return headers;
}

/** Runs one network step; a transport failure becomes an Err, anything else is rethrown. */
async function transport<T>(url: string, timeoutMs: number, step: () => Promise<T>): Promise<Result<T, FetchError>> {
  invariant(url.length > 0, 'a transport step names its URL');
  invariant(timeoutMs > 0, 'a transport step runs under a positive timeout');
  try {
    return ok(await step());
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    if (!(error instanceof TypeError) && !timedOut && !aborted) {
      throw error;
    }
    const detail = timedOut ? `no complete response within ${timeoutMs} ms` : transportDetail(error);
    return err(failure(timedOut ? 'timeout' : 'network', url, null, detail));
  }
}

/** A non-200 body is not needed; cancelling it frees the connection. */
async function discardBody(response: Response): Promise<void> {
  invariant(response.status !== 200, 'only a non-200 body is discarded');
  invariant(!response.bodyUsed, 'a body is discarded before anything reads it');
  await response.body?.cancel();
}

function validatorsOf(headers: Headers): FeedValidators {
  const etag = headers.get('etag');
  const lastModified = headers.get('last-modified');
  invariant(etag === null || typeof etag === 'string', 'Headers.get returns a string or null');
  invariant(lastModified === null || typeof lastModified === 'string', 'Headers.get returns a string or null');
  return { etag: etag === '' ? null : etag, lastModified: lastModified === '' ? null : lastModified };
}

function isZip(bytes: Uint8Array): boolean {
  invariant(bytes instanceof Uint8Array, 'isZip inspects raw bytes');
  const zip = ZIP_LOCAL_HEADER.every((byte, i) => bytes[i] === byte);
  invariant(!zip || bytes.length >= ZIP_LOCAL_HEADER.length, 'a zip is at least its signature long');
  return zip;
}

function failure(kind: FetchError['kind'], url: string, status: number | null, detail: string): FetchError {
  invariant(detail.length > 0, 'a fetch failure explains itself');
  const error: FetchError = { kind, url, status, message: `GTFS fetch ${kind} for ${url}: ${detail}` };
  invariant(error.message.includes(url), 'the message names the URL');
  return error;
}

/** fetch() rejects with a TypeError whose `cause` holds the socket error; surface both. */
function transportDetail(error: Error): string {
  invariant(error.message.length > 0 || error.name.length > 0, 'a transport error has a message or a name');
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  const detail = `${error.name}: ${error.message}${cause}`;
  invariant(detail.length > 0, 'the description is never empty');
  return detail;
}
