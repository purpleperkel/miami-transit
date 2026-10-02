import fixture from '../__fixtures__/transitous-plan.json';
import { BACKOFF_MS, CACHE_TTL_MS, DEBOUNCE_MS, MAX_WAIT_MS, type PlanFetch, type PlanResponseLike, PolitePlanClient } from '../polite-client';
import { buildPlanRequest, type PlanQuery } from '../transitous';

/**
 * Plan M10a.3 A: the polite client on an injected fetch, clock and sleep — no network, no real timers.
 * Every fetch and sleep is written to one event log, so a test reads the exact order of what happened.
 * Fetches can be HELD (they resolve only when the test releases them) and sleeps can be MANUAL (they
 * resolve only when the test wakes them).
 */

const UA = 'MiamiTransit/1.0.0 (+https://github.com/purpleperkel/miami-transit)';
const T0_MS = Date.parse('2026-10-02T18:00:00Z');
const GOVERNMENT_CENTER = { latitude: 25.7745, longitude: -80.1953 };
const BRICKELL = { latitude: 25.7584, longitude: -80.1937 };
const DADELAND = { latitude: 25.6849, longitude: -80.3134 };
const BAYSIDE = { latitude: 25.7781, longitude: -80.1868 };
/** Microtask turns a test lets pass when it waits for, or watches, the client. */
const TICKS = 200;

type Reply = { readonly status: number; readonly body?: unknown; readonly retryAfter?: string } | { readonly reject: string };

/** A query from Government Center, `seconds` after T0. */
function query(to = BRICKELL, seconds = 0): PlanQuery {
  const q: PlanQuery = { from: GOVERNMENT_CENTER, to, timeEpoch: T0_MS / 1000 + seconds, arriveBy: false };
  expect(Number.isInteger(q.timeEpoch)).toBe(true);
  expect(q.from).not.toEqual(q.to);
  return q;
}

/** The url the client must send for a query. */
function urlOf(q: PlanQuery): string {
  const { url, headers } = buildPlanRequest(q, '1.0.0');
  expect(headers['User-Agent']).toBe(UA);
  expect(url).toMatch(/^https:\/\/api\.transitous\.org\/api\/v5\/plan\?/);
  return url;
}

function response(reply: { readonly status: number; readonly body?: unknown; readonly retryAfter?: string }): PlanResponseLike {
  expect(reply.status).toBeGreaterThanOrEqual(100);
  const res: PlanResponseLike = {
    status: reply.status,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? (reply.retryAfter ?? null) : null) },
    json: () => (reply.body === undefined ? Promise.reject(new SyntaxError('Unexpected end of JSON input')) : Promise.resolve(reply.body)),
  };
  expect(res.status).toBe(reply.status);
  return res;
}

/** A client over scripted replies, a settable clock, and a sleep that is instant or manual. */
function harness(replies: Reply[], opts: { readonly holdFetch?: boolean; readonly manualSleep?: boolean } = {}) {
  expect(replies.every((r) => 'reject' in r || r.status >= 100)).toBe(true);
  const log: string[] = [];
  const net = { urls: [] as string[], inFlight: 0, maxInFlight: 0, held: [] as (() => void)[], sleeping: [] as (() => void)[], nowMs: T0_MS };
  const fetch: PlanFetch = async (url, init) => {
    expect(init).toEqual({ method: 'GET', headers: { 'User-Agent': UA } });
    net.urls.push(url);
    log.push('fetch');
    net.inFlight += 1;
    net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
    if (opts.holdFetch === true) {
      await new Promise<void>((resolve) => {
        net.held.push(resolve);
      });
    }
    net.inFlight -= 1;
    const reply = replies.shift();
    expect(reply).toBeDefined();
    if (reply === undefined || 'reject' in reply) {
      throw new TypeError(reply?.reject ?? 'no reply was scripted');
    }
    return response(reply);
  };
  const sleep = (ms: number): Promise<void> => {
    expect(Number.isFinite(ms) && ms > 0).toBe(true);
    log.push(`sleep ${ms}`);
    expect(log.at(-1)).toBe(`sleep ${ms}`);
    if (opts.manualSleep !== true) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      net.sleeping.push(resolve);
    });
  };
  const client = new PolitePlanClient({ fetch, clock: () => net.nowMs, sleep, appVersion: '1.0.0' });
  expect(client).toBeInstanceOf(PolitePlanClient);
  return { client, log, net };
}

/** Lets microtasks run until `cond` holds (bounded). */
async function until(cond: () => boolean): Promise<void> {
  let turns = 0;
  while (!cond() && turns < TICKS) {
    await Promise.resolve();
    turns += 1;
  }
  expect(turns).toBeLessThan(TICKS);
  expect(cond()).toBe(true);
}

/** Lets every pending microtask run, checking `steady` holds all along. */
async function staysTrue(steady: () => boolean): Promise<void> {
  let held = steady();
  for (let turn = 0; turn < TICKS; turn += 1) {
    await Promise.resolve();
    held = held && steady();
  }
  expect(held).toBe(true);
  expect(steady()).toBe(true);
}

describe('polite client: the 60 s cache (M10a.3)', () => {
  it('within 60 s -> cache hit, no fetch', async () => {
    const { client, log, net } = harness([{ status: 200, body: fixture }]);
    const first = await client.plan(query());
    expect(first).toMatchObject({ kind: 'ok', cached: false, fetchedAtMs: T0_MS });
    net.nowMs = T0_MS + CACHE_TTL_MS - 1;
    // The same minute of the query time (30 s later) is the same key.
    const second = await client.plan(query(BRICKELL, 30));
    expect(second).toEqual({ ...first, cached: true });
    expect(net.urls).toEqual([urlOf(query())]);
    // A hit neither fetches nor waits out the debounce.
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, 'fetch']);
  });

  it('after 60 s -> refetch', async () => {
    const { client, net } = harness([{ status: 200, body: fixture }, { status: 200, body: fixture }]);
    expect((await client.plan(query())).kind).toBe('ok');
    net.nowMs = T0_MS + CACHE_TTL_MS;
    const again = await client.plan(query());
    expect(again).toMatchObject({ kind: 'ok', cached: false, fetchedAtMs: T0_MS + CACHE_TTL_MS });
    expect(net.urls).toEqual([urlOf(query()), urlOf(query())]);
  });

  it('another minute of the query time is another cache key', async () => {
    const { client, net } = harness([{ status: 200, body: fixture }, { status: 200, body: fixture }]);
    expect((await client.plan(query())).kind).toBe('ok');
    expect(await client.plan(query(BRICKELL, 60))).toMatchObject({ kind: 'ok', cached: false });
    expect(net.urls).toEqual([urlOf(query()), urlOf(query(BRICKELL, 60))]);
  });
});

describe('polite client: one request in flight (M10a.3)', () => {
  it('concurrent calls -> one request in flight', async () => {
    const { client, net } = harness([{ status: 200, body: fixture }, { status: 200, body: fixture }], { holdFetch: true });
    const first = client.plan(query());
    const same = client.plan(query());
    await until(() => net.urls.length === 1 && net.held.length === 1);
    // A different query arrives while the first request is in flight: it queues, it does not fetch.
    const other = client.plan(query(DADELAND));
    await staysTrue(() => net.urls.length === 1);
    net.held.shift()?.();
    const [a, b] = await Promise.all([first, same]);
    expect(a.kind).toBe('ok');
    expect(b).toBe(a);
    await until(() => net.urls.length === 2 && net.held.length === 1);
    net.held.shift()?.();
    expect((await other).kind).toBe('ok');
    expect(net.urls).toEqual([urlOf(query()), urlOf(query(DADELAND))]);
    expect(net.maxInFlight).toBe(1);
  });
});

describe('polite client: one retry after a backoff (M10a.3)', () => {
  it('429 -> one retry after backoff', async () => {
    const { client, log, net } = harness([{ status: 429 }, { status: 200, body: fixture }]);
    expect(await client.plan(query())).toMatchObject({ kind: 'ok', cached: false });
    // The backoff runs on the injected sleep, between the two requests.
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, 'fetch', `sleep ${BACKOFF_MS}`, 'fetch']);
    expect(net.urls).toEqual([urlOf(query()), urlOf(query())]);
  });

  it('a 5xx is retried once too, waiting out a longer Retry-After', async () => {
    const { client, log } = harness([{ status: 503, retryAfter: '5' }, { status: 200, body: fixture }]);
    expect((await client.plan(query())).kind).toBe('ok');
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, 'fetch', 'sleep 5000', 'fetch']);
  });

  it('a Retry-After past the longest wait is honoured by not retrying', async () => {
    const { client, log } = harness([{ status: 429, retryAfter: String(MAX_WAIT_MS / 1000 + 1) }]);
    expect(await client.plan(query())).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/HTTP 429.*11 s/) });
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, 'fetch']);
  });
});

describe('polite client: every failure is unavailable (M10a.3)', () => {
  it('retry fails -> unavailable', async () => {
    const { client, log } = harness([{ status: 503 }, { status: 429 }]);
    const outcome = await client.plan(query());
    expect(outcome).toEqual({ kind: 'unavailable', reason: `HTTP 503, then after a ${BACKOFF_MS} ms backoff: HTTP 429` });
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, 'fetch', `sleep ${BACKOFF_MS}`, 'fetch']);
  });

  it('a network rejection, a 404 or a bad body is unavailable at once, and is never cached', async () => {
    const replies: Reply[] = [{ reject: 'Network request failed' }, { status: 404 }, { status: 200 }, { status: 200, body: { itineraries: {} } }, { status: 200, body: fixture }];
    const { client, net } = harness(replies);
    for (const reason of [/^network: TypeError: Network request failed$/, /^HTTP 404$/, /^unreadable body: SyntaxError/, /not a \/plan response/]) {
      expect(await client.plan(query())).toEqual({ kind: 'unavailable', reason: expect.stringMatching(reason) });
    }
    // None of the failures was cached: the next call fetches, and answers.
    expect(await client.plan(query())).toMatchObject({ kind: 'ok', cached: false });
    expect(net.urls).toHaveLength(5);
  });
});

describe('polite client: debounce (M10a.3)', () => {
  it('rapid queries -> debounced to one request', async () => {
    const { client, log, net } = harness([{ status: 200, body: fixture }], { manualSleep: true });
    // Typing: three destinations inside one debounce window; only the last one is asked for.
    const typed = [client.plan(query(BAYSIDE)), client.plan(query(DADELAND)), client.plan(query())];
    await until(() => net.sleeping.length === 3);
    for (const wake of net.sleeping.splice(0)) {
      wake();
    }
    const [bayside, dadeland, brickell] = await Promise.all(typed);
    expect(bayside).toEqual({ kind: 'superseded' });
    expect(dadeland).toEqual({ kind: 'superseded' });
    expect(brickell).toMatchObject({ kind: 'ok', cached: false });
    expect(net.urls).toEqual([urlOf(query())]);
    expect(log).toEqual([`sleep ${DEBOUNCE_MS}`, `sleep ${DEBOUNCE_MS}`, `sleep ${DEBOUNCE_MS}`, 'fetch']);
  });
});
