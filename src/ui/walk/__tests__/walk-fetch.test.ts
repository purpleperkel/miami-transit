import type { FetchFn, HttpInit } from '../../../live/http';
import { fetchWalkJson, WALK_TIMEOUT_MS, type WalkGet } from '../walk-fetch';

/**
 * mfix9: the routed-walk provider's HTTP. The fetch is INJECTED (the provider hands in http.ts's EXPO_FETCH; here a
 * fake that answers, refuses, or never answers until its signal aborts): every way the exchange ends is a typed result.
 */

const REQUEST: WalkGet = {
  url: 'https://api.transitous.org/api/v1/one-to-many?one=25.772024;-80.193508&many=25.769165;-80.192248&mode=WALK&max=3600&maxMatchingDistance=250&arriveBy=false&withDistance=true',
  headers: { 'User-Agent': 'MiamiTransit/1.0.0 (+https://github.com/purpleperkel/miami-transit)' },
};

/** A fetch that answers `status` with `body` (the bytes of its text), recording what it was asked with. */
function answering(status: number, body: string): { readonly fetchFn: FetchFn; readonly asked: HttpInit[] } {
  expect(Number.isInteger(status) && status >= 100 && status <= 599).toBe(true);
  const asked: HttpInit[] = [];
  const bytes = new TextEncoder().encode(body);
  expect(new TextDecoder().decode(bytes)).toBe(body);
  return {
    asked,
    fetchFn: (url, init) => {
      asked.push(init);
      return url === REQUEST.url ? Promise.resolve({ ok: status >= 200 && status <= 299, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) : Promise.reject(new Error(`asked for ${url}`));
    },
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('fetchWalkJson', () => {
  it('GETs the walk URL with exactly its headers, under an abort signal, and reads a 2xx body as JSON', async () => {
    const { fetchFn, asked } = answering(200, '[{"duration":867.0,"distance":710.639274597168},{}]');
    const answer = await fetchWalkJson(fetchFn, REQUEST, new AbortController().signal);
    expect(answer).toEqual({ ok: true, value: [{ duration: 867, distance: 710.639274597168 }, {}] });
    expect(asked.map((init) => ({ method: init.method, headers: init.headers, aborted: init.signal.aborted }))).toEqual([{ method: 'GET', headers: REQUEST.headers, aborted: false }]);
  });

  it('turns a status outside 2xx, a refused fetch and a body that is not JSON into typed failures', async () => {
    const outcomes = [
      await fetchWalkJson(answering(429, '{"error":"slow down"}').fetchFn, REQUEST, new AbortController().signal),
      await fetchWalkJson(answering(503, '').fetchFn, REQUEST, new AbortController().signal),
      await fetchWalkJson(() => Promise.reject(new TypeError('Network request failed')), REQUEST, new AbortController().signal),
      await fetchWalkJson(answering(200, '<html>maintenance</html>').fetchFn, REQUEST, new AbortController().signal),
    ];
    expect(outcomes.map((o) => (o.ok ? 'ok' : o.error.kind))).toEqual(['http', 'http', 'network', 'decode']);
    expect(outcomes.map((o) => (!o.ok && o.error.kind === 'http' ? o.error.status : null))).toEqual([429, 503, null, null]);
  });

  it('gives up after WALK_TIMEOUT_MS, and when the provider cancels, as a timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    // expo/fetch rejects only when its signal aborts: a server that never answers.
    const slow = fetchWalkJson((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')))), REQUEST, new AbortController().signal);
    await jest.advanceTimersByTimeAsync(WALK_TIMEOUT_MS);
    const provider = new AbortController();
    const cancelled = fetchWalkJson((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')))), REQUEST, provider.signal);
    provider.abort();
    expect(await slow).toEqual({ ok: false, error: { kind: 'timeout', message: 'api.transitous.org did not answer within 15 s' } });
    expect(await cancelled).toEqual({ ok: false, error: { kind: 'timeout', message: 'the walk request to api.transitous.org was cancelled before it finished' } });
  });
});
