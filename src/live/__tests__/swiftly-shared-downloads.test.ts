import type { RuntimeNetwork } from '../../data/live-network';
import { LIVE_TRIP_UPDATES_FIXTURE_BYTES, LIVE_TRIP_UPDATES_FIXTURE_DECODED } from '../../domain/gtfsrt/__fixtures__/live-feeds.fixture';
import { testNetwork } from '../../domain/live/__tests__/test-network';
import type { Standings } from '../../domain/live/chain';
import { predictionsFromFeed } from '../../domain/live/from-gtfsrt';
import type { LiveProvider } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { ByteCounter, httpGet } from '../http';
import { LivePoller, type LiveSnapshot } from '../poller';
import type { ProviderDeps } from '../providers/batches';
import { NONE_PROVIDER } from '../providers/none';
import { createSwiftlyProvider } from '../providers/swiftly';
import { createTransitlandProvider } from '../providers/transitland';
import { FAKE_KEYS, FakeServer, runtimeNetwork, SWIFTLY_TRIP_UPDATES_URL, SWIFTLY_VEHICLES_URL } from './live-fakes';

/**
 * mfix10 fix round 3 (R3, R5): Swiftly's ONE whole-agency trip-updates download, read by several watched
 * stations, under the REAL poller and the REAL Swiftly provider over a fake server — Swiftly the only
 * keyed provider, so it keeps serving while it fails (chain.ts, the lone-provider rule). Count once,
 * back off always: a failed download is ONE failure in the chain, recorded by the poll that started it,
 * while every station's task backs off on R-b's schedule (30, 30, 60, 120 s), whether its poll started
 * the download or reused it. The poller's wall clock and the provider's monotonic clock move together,
 * one heartbeat (1 s) at a time.
 */

const T0 = 1_790_872_200;
/** Three watched stations, every one reading the same trip-updates download. */
const STATIONS = ['rail:government-ctr', 'rail:brickell', 'mover:government-center'];
/** When each task polls under a persistent failure (s after T0): R-b's 30, 30, 60, 120 s. */
const BACKOFF_ATTEMPTS = [0, 30, 60, 120, 240];
const CAPABILITIES = { vehicles: true, predictions: true };
/** Swiftly keyed, Transitland not: Swiftly is the lone provider and keeps serving while it fails. */
const SWIFTLY_ALONE: Standings = {
  swiftly: { hasKey: true, capabilities: CAPABILITIES, callsThisMonth: 0 },
  transitland: { hasKey: false, capabilities: CAPABILITIES, callsThisMonth: 0 },
};
const SERVER_DOWN = { status: 503, body: new Uint8Array(0) };

/** One fetch the poller asked the provider for: 'vehicles' or a station key, and when (s after T0). */
type Fetch = { readonly what: string; readonly atS: number };
/** Every fetch asked for, and how many are still unanswered. */
type FetchLog = { readonly fetches: Fetch[]; pending: number };

/** `provider`, logging every fetch the poller asks of it, and when it is answered, around the fetch itself. */
function recorded(provider: LiveProvider, log: FetchLog, atS: () => number): LiveProvider {
  expect(provider.id).toBe('swiftly'); // the rig records Swiftly's fetches
  expect(provider.capabilities).toEqual({ vehicles: true, predictions: true }); // the rig polls both of Swiftly's feeds through it
  const asked = <T>(what: string, fetch: Promise<T>): Promise<T> => {
    expect(what === 'vehicles' || STATIONS.includes(what)).toBe(true); // the poller asks only for vehicles and the watched stations
    expect(log.pending).toBeLessThan(STATIONS.length + 1); // one poll per task at a time: polls never overlap
    log.fetches.push({ what, atS: atS() });
    log.pending += 1;
    return fetch.finally(() => void (log.pending -= 1));
  };
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    fetchVehicles: (signal) => asked('vehicles', provider.fetchVehicles(signal)),
    fetchPredictions: (stationKey, signal) => asked(stationKey, provider.fetchPredictions(stationKey, signal)),
  };
}

/** The real poller over the real Swiftly provider and `server`, the three stations watched. */
class SharedRig {
  wallS = T0;
  monoMs = 0;
  readonly log: FetchLog = { fetches: [], pending: 0 };
  readonly bugs: string[] = [];
  readonly snapshots: LiveSnapshot[] = [];
  readonly poller: LivePoller;

  constructor(
    readonly server: FakeServer,
    network: RuntimeNetwork = runtimeNetwork(),
  ) {
    const deps: ProviderDeps = {
      get: (request, signal) => httpGet(request, signal, { fetch: server.fetch, counter: new ByteCounter(), nowS: () => this.wallS }),
      keys: () => FAKE_KEYS,
      network,
      recordCall: () => undefined,
      monotonicMs: () => this.monoMs,
    };
    const swiftly = recorded(createSwiftlyProvider(deps), this.log, () => this.wallS - T0);
    this.poller = new LivePoller({
      providers: { swiftly, transitland: createTransitlandProvider(deps), none: NONE_PROVIDER },
      standings: () => SWIFTLY_ALONE,
      nowS: () => this.wallS,
      onChange: (snapshot) => void this.snapshots.push(snapshot),
      onBug: (message) => void this.bugs.push(message),
    });
    this.poller.watchStations(STATIONS);
    expect(STATIONS.every((station) => network.stopsOfStation(station).length > 0)).toBe(true); // each station reads the feed
    expect(server.urls()).toEqual([]); // nothing is requested before the first heartbeat
  }

  /**
   * Ticks once a second through T0 + `untilS`, both clocks moving together (nobody corrects this phone's
   * clock), and lets each tick's polls end before the next: the fake server answers at once, so every
   * step of a poll is a microtask that runs before the zero timer.
   */
  async stepThrough(untilS: number): Promise<void> {
    expect(T0 + untilS).toBeGreaterThanOrEqual(this.wallS); // the heartbeat only moves forward
    for (; this.wallS <= T0 + untilS; this.wallS += 1, this.monoMs += 1_000) {
      this.poller.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(this.log.pending).toBe(0); // every fetch the heartbeats asked for has been answered, so every poll has ended
  }

  /** When the poller asked for `what` (s after T0). */
  attempts(what: string): number[] {
    expect(what === 'vehicles' || STATIONS.includes(what)).toBe(true);
    expect(this.log.fetches.length).toBeGreaterThan(0); // the poller has polled, so an empty answer would mean something
    return this.log.fetches.filter((fetch) => fetch.what === what).map((fetch) => fetch.atS);
  }

  /** How many downloads of `url` the server has seen. */
  downloads(url: string): number {
    expect(url === SWIFTLY_VEHICLES_URL || url === SWIFTLY_TRIP_UPDATES_URL).toBe(true);
    expect(this.server.urls().every((seen) => seen.startsWith('https://api.goswift.ly/'))).toBe(true); // Swiftly alone was asked
    return this.server.urls().filter((seen) => seen === url).length;
  }
}

/** The chain's consecutive failures for each capability after each round of attempts, beside the downloads made by then. */
async function roundsOf(rig: SharedRig): Promise<{ downloads: number[]; failures: number[] }[]> {
  const rounds: { downloads: number[]; failures: number[] }[] = [];
  for (const atS of BACKOFF_ATTEMPTS) {
    await rig.stepThrough(atS);
    const { vehicles, predictions } = rig.poller.snapshot.status;
    rounds.push({ downloads: [rig.downloads(SWIFTLY_VEHICLES_URL), rig.downloads(SWIFTLY_TRIP_UPDATES_URL)], failures: [vehicles.consecutiveFailures, predictions.consecutiveFailures] });
  }
  expect(rig.poller.snapshot.status.predictions.provider).toBe('swiftly'); // the lone provider keeps serving while it fails
  expect(rig.poller.snapshot.status.predictions.failing).toBe(true); // and says its data is stale
  return rounds;
}

describe('Swiftly\'s shared downloads under the poller (mfix10 fix round 3): count once, back off always', () => {
  it('3 watched stations and a persistent swiftly failure: every station\'s next attempts follow the backoff schedule, and the chain records exactly one failure per download', async () => {
    const rig = new SharedRig(new FakeServer({ [SWIFTLY_VEHICLES_URL]: SERVER_DOWN, [SWIFTLY_TRIP_UPDATES_URL]: SERVER_DOWN }));
    const rounds = await roundsOf(rig);
    expect(rounds.map(({ downloads, failures }) => [downloads, failures])).toEqual(BACKOFF_ATTEMPTS.map((_, i) => [[i + 1, i + 1], [i + 1, i + 1]]));
    expect(['vehicles', ...STATIONS].map((what) => [what, rig.attempts(what)])).toEqual(['vehicles', ...STATIONS].map((what) => [what, BACKOFF_ATTEMPTS]));
    expect(rig.poller.snapshot.status.predictions.lastError).toEqual({ kind: 'http', status: 503, message: 'api.goswift.ly answered HTTP 503' }); // the download's own failure, unmarked
    expect(rig.bugs).toEqual([]);
  });

  it('a shared download that rejects (a throwing mapper) is counted once, and every station\'s next attempts still follow the backoff schedule', async () => {
    const BROKEN = 'the schedule knows no such stop (a mapper invariant, broken on purpose)';
    const network: RuntimeNetwork = {
      ...runtimeNetwork(),
      stationOfStop: (stopId) => {
        invariant(stopId.length === 0, BROKEN);
        return null;
      },
    };
    expect(predictionsFromFeed(LIVE_TRIP_UPDATES_FIXTURE_DECODED, testNetwork()).items.length).toBeGreaterThan(0); // the feed has stop updates for the broken mapper to trip over
    const rig = new SharedRig(new FakeServer({ [SWIFTLY_VEHICLES_URL]: SERVER_DOWN, [SWIFTLY_TRIP_UPDATES_URL]: { status: 200, body: LIVE_TRIP_UPDATES_FIXTURE_BYTES } }), network);
    const rounds = await roundsOf(rig);
    expect(rounds.map(({ downloads, failures }) => [downloads[1], failures[1]])).toEqual(BACKOFF_ATTEMPTS.map((_, i) => [i + 1, i + 1]));
    expect(STATIONS.map((station) => [station, rig.attempts(station)])).toEqual(STATIONS.map((station) => [station, BACKOFF_ATTEMPTS]));
    expect(new Set(rig.bugs)).toEqual(new Set([`InvariantError: ${BROKEN}`])); // every poll that saw the bug reports it as itself
    expect(rig.poller.snapshot.status.predictions.lastError).toBeNull(); // a bug is not a provider error
  });
});
