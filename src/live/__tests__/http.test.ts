import { type LiveRequest, transitlandVehiclesRequest } from '../../domain/live/transports';
import { ByteCounter, type FetchFn, type FetchResponseLike, httpGet, type HttpDeps, type HttpInit } from '../http';

/**
 * M4.8: http.ts over an injected fetch. expo/fetch is native, so it is not called here; instead the
 * fakes reject exactly the way expo/fetch 57 does once its signal aborts (`FetchError('The operation
 * was aborted.')`, node_modules/expo/src/winter/fetch/fetch.ts), and no native module is mocked.
 * The key is an obviously fake test string.
 */

const FAKE_KEY = 'test-only-fake-transitland-key';
const NOW_S = 1_790_872_200;
const BODY = new Uint8Array([0x0a, 0x00, 0xff, 0x80, 0x12]);
const VEHICLES_URL = 'https://transit.land/api/v2/rest/feeds/f-miamidadetransit~rt/download_latest_rt/vehicle_positions.pb';

/** The Transitland vehicles request (the real builder), with its abort timer shortened for a test. */
function vehiclesRequest(timeoutMs = 8_000): LiveRequest {
  const built = transitlandVehiclesRequest(FAKE_KEY);
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  expect(built.value.headers).toEqual({ apikey: FAKE_KEY });
  expect(built.value.timeoutMs).toBe(8_000);
  return { ...built.value, timeoutMs };
}

/** A response with `status` whose body is `body`, or whatever `read` yields. */
function response(status: number, body: Uint8Array = BODY, read?: () => Promise<ArrayBuffer>): FetchResponseLike {
  expect(Number.isInteger(status)).toBe(true);
  expect(body).toBeInstanceOf(Uint8Array);
  return { ok: status >= 200 && status <= 299, status, arrayBuffer: read ?? (() => Promise.resolve(body.slice().buffer)) };
}

/** A promise that rejects as expo/fetch does when `signal` aborts, and never settles otherwise. */
function rejectOnAbort<T>(signal: AbortSignal): Promise<T> {
  expect(signal).toBeDefined();
  expect(signal.aborted).toBe(false);
  return new Promise<T>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('The operation was aborted.'))));
}

function deps(fetch: FetchFn, counter = new ByteCounter()): HttpDeps {
  expect(typeof fetch).toBe('function');
  expect(counter).toBeInstanceOf(ByteCounter);
  return { fetch, counter, nowS: () => NOW_S };
}

/** A caller signal that never aborts (the runtime still running). */
function live(): AbortSignal {
  const signal = new AbortController().signal;
  expect(signal.aborted).toBe(false);
  expect(typeof signal.addEventListener).toBe('function');
  return signal;
}

describe('httpGet (M4.8): success', () => {
  it('a 2xx response returns its body bytes and status; the request carries its headers and a signal', async () => {
    const seen: { url: string; init: HttpInit }[] = [];
    const recording = deps((url, init) => {
      seen.push({ url, init });
      return Promise.resolve(response(200));
    });
    const result = await httpGet(vehiclesRequest(), live(), recording);
    expect(result).toEqual({ ok: true, value: { provider: 'transitland', status: 200, body: BODY, receivedAt: NOW_S } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(VEHICLES_URL);
    expect(seen[0]?.init).toEqual(expect.objectContaining({ method: 'GET', headers: { apikey: FAKE_KEY } }));
    expect(seen[0]?.init.signal).toBeDefined();
  });

  it('clears its abort timer once the exchange is over (no timer outlives a request)', async () => {
    jest.useFakeTimers();
    try {
      const result = await httpGet(vehiclesRequest(), live(), deps(() => Promise.resolve(response(200))));
      expect(result.ok).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('httpGet (M4.8): timeout and abort', () => {
  it('timeout: no answer within the request\'s timeoutMs aborts it and gives { kind: "timeout" }', async () => {
    const started = Date.now();
    const result = await httpGet(vehiclesRequest(25), live(), deps((_url, init) => rejectOnAbort(init.signal)));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({ kind: 'timeout', message: 'transit.land did not answer within 0.025 s' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('timeout: a body that stalls after the headers is aborted by the same timer', async () => {
    const counter = new ByteCounter();
    const stalling = deps((_url, init) => Promise.resolve(response(200, BODY, () => rejectOnAbort(init.signal))), counter);
    const result = await httpGet(vehiclesRequest(25), live(), stalling);
    expect(!result.ok && result.error.kind).toBe('timeout');
    expect(counter.tally('transitland').responses).toBe(0);
  });

  it('timeout (abort): a caller abort cancels the request at once and reports a cancelled timeout', async () => {
    const caller = new AbortController();
    const pending = httpGet(vehiclesRequest(), caller.signal, deps((_url, init) => rejectOnAbort(init.signal)));
    caller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({ kind: 'timeout', message: 'the request to transit.land was cancelled before it finished' });
  });

  it('timeout (abort): a caller that aborted before the request never reaches the network', async () => {
    const caller = new AbortController();
    caller.abort();
    const sent: boolean[] = [];
    const refusing = deps((_url, init) => {
      sent.push(init.signal.aborted);
      return Promise.reject(new Error('The operation was aborted.'));
    });
    const result = await httpGet(vehiclesRequest(), caller.signal, refusing);
    expect(sent).toEqual([true]);
    expect(!result.ok && result.error.kind).toBe('timeout');
    expect(!result.ok && result.error.message).toContain('cancelled');
  });
});

describe('httpGet (M4.8): network and non-2xx failures', () => {
  it('network: a rejected fetch (offline, DNS, TLS) gives { kind: "network" } with the reason', async () => {
    const offline = deps(() => Promise.reject(new Error('The Internet connection appears to be offline.')));
    const result = await httpGet(vehiclesRequest(), live(), offline);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      kind: 'network',
      message: 'transit.land could not be reached: The Internet connection appears to be offline.',
    });
  });

  it('network: a body that fails part-way gives { kind: "network" }, and no bytes are counted', async () => {
    const counter = new ByteCounter();
    const reset = deps(() => Promise.resolve(response(200, BODY, () => Promise.reject(new Error('connection reset')))), counter);
    const result = await httpGet(vehiclesRequest(), live(), reset);
    expect(!result.ok && result.error.kind).toBe('network');
    expect(counter.tally('transitland')).toEqual({ responses: 0, bytes: 0, lastBytes: null, lastAt: null });
  });

  it.each([401, 403, 404, 429, 500, 503])('non-2xx: HTTP %i gives { kind: "http" } with its status', async (status) => {
    const result = await httpGet(vehiclesRequest(), live(), deps(() => Promise.resolve(response(status, new Uint8Array([0x7b, 0x7d])))));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({ kind: 'http', status, message: `transit.land answered HTTP ${status}` });
  });

  it('non-2xx: a 3xx that was not followed is an http error too (only 200–299 is success)', async () => {
    const result = await httpGet(vehiclesRequest(), live(), deps(() => Promise.resolve(response(304, new Uint8Array(0)))));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind === 'http' && result.error.status).toBe(304);
  });
});

describe('httpGet (M4.8): byte counter', () => {
  it('byte counter: every body read — 2xx and non-2xx — is added to its provider\'s tally', async () => {
    const counter = new ByteCounter();
    const bodies = [response(200, new Uint8Array(1_000)), response(404, new Uint8Array(37)), response(200, new Uint8Array(56_000))];
    for (const next of bodies) {
      await httpGet(vehiclesRequest(), live(), deps(() => Promise.resolve(next), counter));
    }
    expect(counter.tally('transitland')).toEqual({ responses: 3, bytes: 57_037, lastBytes: 56_000, lastAt: NOW_S });
    expect(counter.snapshot()).toEqual({
      swiftly: { responses: 0, bytes: 0, lastBytes: null, lastAt: null },
      transitland: { responses: 3, bytes: 57_037, lastBytes: 56_000, lastAt: NOW_S },
    });
  });

  it('byte counter: a failed exchange (network, timeout) adds no bytes', async () => {
    const counter = new ByteCounter();
    await httpGet(vehiclesRequest(), live(), deps(() => Promise.reject(new Error('offline')), counter));
    await httpGet(vehiclesRequest(20), live(), deps((_url, init) => rejectOnAbort(init.signal), counter));
    expect(counter.tally('transitland').responses).toBe(0);
    expect(counter.tally('transitland').bytes).toBe(0);
  });
});
