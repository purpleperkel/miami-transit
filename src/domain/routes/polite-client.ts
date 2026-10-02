import { isLatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { buildPlanRequest, type Itinerary, parseItineraries, type PlanQuery, type PlanRequest } from './transitous';

/**
 * Plan M10a.3 — the polite Transitous client. Transitous approved this app on the condition of FEW
 * requests (transitous#2538), so this is the only way the app reaches /plan, and it keeps that promise:
 *
 *  - CACHE: an answer is reused for 60 s per (from, to, minute of the query time, arriveBy), on the
 *    injected clock. Only answers are cached, never failures.
 *  - DEBOUNCE: a call waits DEBOUNCE_MS on the injected sleep, and only the LATEST call of a burst goes
 *    on to fetch; the calls it supersedes resolve { kind: 'superseded' } without a request.
 *  - ONE REQUEST IN FLIGHT: a call for a key already pending shares that call's promise; different keys
 *    queue behind the request in flight (and a queued call superseded meanwhile never fetches).
 *  - RETRY: 429 or 5xx gets ONE retry after a backoff on the injected sleep — BACKOFF_MS, or the
 *    server's Retry-After when longer. A Retry-After past MAX_WAIT_MS is honoured by not retrying.
 *  - FAILURE IS A VALUE: a second failure, a network rejection, another HTTP status, an unreadable or
 *    malformed body all resolve { kind: 'unavailable', reason } — the UI then offers Apple Maps. No call
 *    ever rejects for a runtime failure: every injected promise is settled into a Result first.
 *
 * Pure: fetch, clock and sleep are injected (the app passes expo/fetch with its own abort timeout,
 * Date.now and a setTimeout sleep). The injected fetch must time out on its own, or a hung request
 * would hold the one request slot.
 */

/** The part of a fetch Response the client reads (the global and expo/fetch responses satisfy it). */
export type PlanResponseLike = {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
};

export type PlanFetch = (url: string, init: { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>> }) => Promise<PlanResponseLike>;

export type PoliteClientDeps = {
  readonly fetch: PlanFetch;
  /** Now, epoch milliseconds. */
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** app.json's expo.version, for the User-Agent. */
  readonly appVersion: string;
};

export type PlanOutcome =
  | { readonly kind: 'ok'; readonly itineraries: readonly Itinerary[]; readonly fetchedAtMs: number; readonly cached: boolean }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'superseded' };

export const CACHE_TTL_MS = 60_000;
export const DEBOUNCE_MS = 400;
export const BACKOFF_MS = 2_000;
/** The longest the client waits to retry; a server asking for longer is not retried. */
export const MAX_WAIT_MS = 10_000;
/** Answers kept at most (oldest evicted first), so a long session cannot grow the cache without bound. */
export const CACHE_MAX_ENTRIES = 32;

type CacheEntry = { readonly atMs: number; readonly itineraries: readonly Itinerary[] };
type AttemptFailure = { readonly retryable: boolean; readonly retryAfterMs: number | null; readonly reason: string };

const SUPERSEDED: PlanOutcome = Object.freeze({ kind: 'superseded' });

/** The cache key: from, to, the query's minute and its direction. */
export function planCacheKey(query: PlanQuery): string {
  invariant(Number.isFinite(query.timeEpoch), 'a query has an instant');
  const key = `${query.from.latitude},${query.from.longitude}|${query.to.latitude},${query.to.longitude}|${Math.floor(query.timeEpoch / 60)}|${query.arriveBy}`;
  invariant(key.split('|').length === 4, 'a cache key has four parts');
  return key;
}

export class PolitePlanClient {
  private readonly deps: PoliteClientDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<PlanOutcome>>();
  private latestKey: string | null = null;
  /** Resolves when the request in flight (and every one queued before it) has finished. */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: PoliteClientDeps) {
    invariant(typeof deps.fetch === 'function' && typeof deps.clock === 'function' && typeof deps.sleep === 'function', 'fetch, clock and sleep are injected');
    invariant(/^\S+$/.test(deps.appVersion), 'the app version identifies the client');
    this.deps = deps;
  }

  /** Route options for a query: cached, shared, debounced and queued as the header describes. */
  async plan(query: PlanQuery): Promise<PlanOutcome> {
    invariant(isLatLon(query.from) && isLatLon(query.to) && typeof query.arriveBy === 'boolean', 'a query runs between two valid coordinates, one way');
    const key = planCacheKey(query);
    this.latestKey = key;
    const hit = this.fresh(key);
    if (hit !== null) {
      return hit;
    }
    const shared = this.pending.get(key);
    if (shared !== undefined) {
      return shared;
    }
    const run = this.debounced(key, query);
    this.pending.set(key, run);
    invariant(this.pending.get(key) === run && this.latestKey === key, 'the call is pending and is the latest');
    return run;
  }

  /** Waits out the debounce, then — still the latest call — takes the request slot and fetches. */
  private async debounced(key: string, query: PlanQuery): Promise<PlanOutcome> {
    invariant(!this.pending.has(key), 'one pending run per key');
    try {
      const waited = await settle(() => this.deps.sleep(DEBOUNCE_MS));
      if (!waited.ok) {
        return unavailable(`the debounce timer failed: ${waited.error}`);
      }
      if (this.latestKey !== key) {
        return SUPERSEDED;
      }
      const outcome = await this.exclusive(() => (this.latestKey === key ? this.fetchWithRetry(query, key) : Promise.resolve(SUPERSEDED)));
      invariant(outcome.kind !== 'ok' || !outcome.cached, 'a fetched answer is not a cache hit');
      return outcome;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Runs `task` once every earlier task has finished: one request in flight. */
  private async exclusive(task: () => Promise<PlanOutcome>): Promise<PlanOutcome> {
    const previous = this.tail;
    const turn = { end: (): void => undefined };
    this.tail = new Promise<void>((resolve) => {
      turn.end = resolve;
    });
    invariant(this.tail !== previous, 'this task now holds the end of the queue');
    await previous;
    try {
      const outcome = await task();
      invariant(typeof outcome.kind === 'string', 'the task settles to an outcome');
      return outcome;
    } finally {
      turn.end();
    }
  }

  /** One request, and one retry after a backoff when Transitous answers 429 or 5xx. */
  private async fetchWithRetry(query: PlanQuery, key: string): Promise<PlanOutcome> {
    const request = buildPlanRequest(query, this.deps.appVersion);
    invariant(planCacheKey(query) === key, 'the request is for the pending key');
    const first = await this.attempt(request);
    if (first.ok) {
      return this.store(key, first.value);
    }
    if (!first.error.retryable) {
      return unavailable(first.error.reason);
    }
    const waitMs = Math.max(BACKOFF_MS, first.error.retryAfterMs ?? 0);
    if (waitMs > MAX_WAIT_MS) {
      return unavailable(`${first.error.reason}; Transitous asked for ${waitMs / 1000} s before a retry`);
    }
    const slept = await settle(() => this.deps.sleep(waitMs));
    const second = slept.ok ? await this.attempt(request) : err<AttemptFailure>({ retryable: false, retryAfterMs: null, reason: `the backoff timer failed: ${slept.error}` });
    if (second.ok) {
      return this.store(key, second.value);
    }
    invariant(second.error.reason.length > 0, 'a failure says why');
    return unavailable(`${first.error.reason}, then after a ${waitMs} ms backoff: ${second.error.reason}`);
  }

  /** One GET of the plan: its itineraries, or why not (and whether a retry may help). */
  private async attempt(request: PlanRequest): Promise<Result<Itinerary[], AttemptFailure>> {
    invariant(request.url.length > 0 && request.headers['User-Agent'] !== undefined, 'a request carries the User-Agent');
    const response = await settle(() => this.deps.fetch(request.url, { method: 'GET', headers: request.headers }));
    if (!response.ok) {
      return err({ retryable: false, retryAfterMs: null, reason: `network: ${response.error}` });
    }
    const { status } = response.value;
    if (status === 429 || status >= 500) {
      return err({ retryable: true, retryAfterMs: retryAfterMs(response.value), reason: `HTTP ${status}` });
    }
    if (status < 200 || status > 299) {
      return err({ retryable: false, retryAfterMs: null, reason: `HTTP ${status}` });
    }
    const body = await settle(() => response.value.json());
    const parsed = body.ok ? parseItineraries(body.value) : err({ kind: 'malformed' as const, message: `unreadable body: ${body.error}` });
    invariant(parsed.ok || parsed.error.message.length > 0, 'a malformed body says why');
    return parsed.ok ? parsed : err({ retryable: false, retryAfterMs: null, reason: parsed.error.message });
  }

  /** Caches an answer (evicting expired, then oldest, entries) and returns it. */
  private store(key: string, itineraries: readonly Itinerary[]): PlanOutcome {
    const atMs = this.deps.clock();
    invariant(Number.isFinite(atMs), 'the clock reads an instant');
    this.cache.delete(key);
    for (const [k, entry] of this.cache) {
      if (this.cache.size >= CACHE_MAX_ENTRIES || !isFresh(entry, atMs)) {
        this.cache.delete(k);
      }
    }
    this.cache.set(key, { atMs, itineraries });
    invariant(this.cache.size <= CACHE_MAX_ENTRIES, 'the cache stays bounded');
    return { kind: 'ok', itineraries, fetchedAtMs: atMs, cached: false };
  }

  /** The cached answer for a key while it is younger than CACHE_TTL_MS, else null. */
  private fresh(key: string): PlanOutcome | null {
    const nowMs = this.deps.clock();
    invariant(Number.isFinite(nowMs), 'the clock reads an instant');
    const entry = this.cache.get(key);
    const hit: PlanOutcome | null = entry !== undefined && isFresh(entry, nowMs) ? { kind: 'ok', itineraries: entry.itineraries, fetchedAtMs: entry.atMs, cached: true } : null;
    invariant(hit === null || entry !== undefined, 'a hit comes from the cache');
    return hit;
  }
}

function isFresh(entry: CacheEntry, nowMs: number): boolean {
  invariant(Number.isFinite(entry.atMs) && Number.isFinite(nowMs), 'freshness compares two instants');
  const age = nowMs - entry.atMs;
  invariant(Number.isFinite(age), 'an age is finite');
  return age >= 0 && age < CACHE_TTL_MS;
}

/** A Retry-After given in seconds, in milliseconds; null when absent or given as a date. */
function retryAfterMs(response: PlanResponseLike): number | null {
  invariant(response.status === 429 || response.status >= 500, 'only a retryable answer is asked when to retry');
  const raw = response.headers?.get('Retry-After') ?? null;
  const seconds = raw !== null && /^\s*\d+\s*$/.test(raw) ? Number(raw) : null;
  invariant(seconds === null || (Number.isInteger(seconds) && seconds >= 0), 'a Retry-After is whole seconds');
  return seconds === null ? null : seconds * 1000;
}

function unavailable(reason: string): PlanOutcome {
  invariant(reason.length > 0, 'unavailable says why');
  const outcome: PlanOutcome = { kind: 'unavailable', reason };
  invariant(outcome.kind === 'unavailable', 'an unavailable outcome');
  return outcome;
}

/** An injected promise settled into a Result: a rejection (or a synchronous throw) becomes err(reason). */
async function settle<T>(run: () => Promise<T>): Promise<Result<T, string>> {
  invariant(typeof run === 'function', 'settle runs a thunk');
  try {
    const value = await run();
    return ok(value);
  } catch (error: unknown) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    invariant(typeof reason === 'string', 'a rejection is described');
    return err(reason.length > 0 ? reason : 'rejected without a reason');
  }
}
