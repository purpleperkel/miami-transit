import type { RuntimeNetwork } from '../data/live-network';
import type { ProviderStanding, Standings } from '../domain/live/chain';
import { isOnWifi, swiftlyAllowed } from '../domain/live/network-gate';
import type { LiveRequest } from '../domain/live/transports';
import { type ChainProviderId, type LiveProvider, PROVIDER_IDS, type ProviderId } from '../domain/live/types';
import { invariant } from '../lib/invariant';
import type { Result } from '../lib/result';
import { ByteCounter, type ByteTallies, EXPO_FETCH, type FetchFn, httpGet } from './http';
import { detach } from './detach';
import { clearKey, KEY_MASK, KEYCHAIN, type KeyError, type LiveKeys, maskKey, NO_KEYS, readLiveKeys, saveKey, saveSwiftlyAgency, type SecretStore } from './keys';
import { type NetworkSource, NetworkWatch } from './network-watch';
import { LivePoller, type LiveSnapshot } from './poller';
import type { ProviderDeps } from './providers/batches';
import { NONE_PROVIDER } from './providers/none';
import { createSwiftlyProvider } from './providers/swiftly';
import { createTransitlandProvider } from './providers/transitland';
import { callsThisMonth, type QuotaStore, recordCall } from './quota';
import { KvQuotaStore } from './quota-store';
import { readSwiftlyWifiOnly } from './swiftly-wifi';

/**
 * Plan M4.9: the live runtime, assembled — expo/fetch through http.ts (typed errors, byte counter),
 * keys from the Keychain (keys.ts), the quota meter in expo-sqlite/kv-store, the two providers over
 * the schedule's network, and the poller. live-context.tsx makes one per open schedule DB and
 * publishes its LiveState; use-live-polling.ts starts and stops it.
 *
 * mfix10 "Use Swiftly only on Wi-Fi": the runtime owns the app's one network watch (network-watch.ts,
 * over the `networkSource` live-context.tsx passes: expo-network), starts and stops it with itself, and
 * refreshes it on every resume: back from the background the reading is discarded (so Swiftly is gated)
 * and asked afresh, since the phone may have left Wi-Fi while the app was suspended. A runtime given
 * no source has no reading, so the phone counts as off Wi-Fi. Every time the chain takes the
 * providers' standings (each poll tick, each finished poll) the gate is read afresh: the rider's
 * setting from its kv item (swiftly-wifi.ts, ON by default) and the watch's latest reading. With the
 * setting on and the phone off Wi-Fi, Swiftly stands in the chain exactly as if it had no key, for
 * both capabilities: no request starts, no call is metered, no failure or backoff accrues, and
 * Transitland serves. The Keychain still holds the key, so `hasKey` and `keyHints` still show it, and
 * `swiftlyGated` says why it is not serving. A request already in flight when the gate closes may
 * finish, and the chain records nothing for it (poller.ts finish).
 *
 * LIFECYCLE: constructing a runtime does nothing observable. `start()` makes a fresh poller, loads
 * the keys and begins publishing; `stop()` aborts the poller's requests and publishing stops. A
 * stopped runtime can start again (React may run an effect twice). What outlives a stop: the keys,
 * the watched stations, the byte counter, and the quota (persisted).
 */

export type LiveState = LiveSnapshot & {
  /** Response bytes per provider this session (Diagnostics: bytes per poll, falsifier R19). */
  readonly bytes: ByteTallies;
  /** REST calls per provider this (UTC) month — the quota meter. */
  readonly callsThisMonth: Readonly<Record<ProviderId, number>>;
  /** Which providers have a key in the Keychain (never the key itself). */
  readonly hasKey: Readonly<Record<ProviderId, boolean>>;
  /** Each stored key as Data & Settings shows it — `••••` + its last 4 (keys.ts maskKey) — or null; never the key itself. */
  readonly keyHints: Readonly<Record<ProviderId, string | null>>;
  readonly swiftlyAgency: string;
  /** Why the Keychain could not be read when the runtime started, or null. */
  readonly keysError: KeyError | null;
  /** The latest BUG in the live runtime (a broken invariant in a poll or a key load), or null (detach.ts). */
  readonly internalError: string | null;
  /** Swiftly has a key, but "Use Swiftly only on Wi-Fi" holds it back: the setting is on and the phone is off Wi-Fi. */
  readonly swiftlyGated: boolean;
};

export type RuntimeOptions = {
  readonly network: RuntimeNetwork;
  /** Receives every new LiveState while the runtime is started. */
  readonly onChange: (state: LiveState) => void;
  /** Injected in tests; expo/fetch, the Keychain, kv-store and the wall clock by default. */
  readonly fetch?: FetchFn;
  readonly keychain?: SecretStore;
  readonly quotaStore?: QuotaStore;
  readonly nowS?: () => number;
  /** The phone's network for the Swiftly gate (live-context.tsx passes expo-network); without one there is never a reading, so never Wi-Fi. */
  readonly networkSource?: NetworkSource;
  /** The rider's "Use Swiftly only on Wi-Fi", read afresh every time the chain asks (swiftly-wifi.ts's kv item by default). */
  readonly swiftlyWifiOnly?: () => boolean;
};

/** The wall clock, in whole epoch seconds. */
export function wallClockS(): number {
  const nowS = Math.floor(Date.now() / 1000);
  invariant(Number.isSafeInteger(nowS), 'the wall clock reads a whole second');
  invariant(nowS > 0, 'the wall clock is past the epoch');
  return nowS;
}

export class LiveRuntime {
  private keys: LiveKeys = NO_KEYS;
  private keysError: KeyError | null = null;
  private internalError: string | null = null;
  private stations: readonly string[] = [];
  private poller: LivePoller | null = null;
  /** The gate as last published, so a tick that moved no chain status still shows a toggle or a network change. */
  private publishedGate = false;
  private readonly counter = new ByteCounter();
  private readonly providers: Readonly<Record<ChainProviderId, LiveProvider>>;
  private readonly keychain: SecretStore;
  private readonly quota: QuotaStore;
  private readonly nowS: () => number;
  private readonly watch: NetworkWatch | null;
  private readonly wifiOnly: () => boolean;

  constructor(private readonly options: RuntimeOptions) {
    this.keychain = options.keychain ?? KEYCHAIN;
    this.quota = options.quotaStore ?? new KvQuotaStore();
    this.nowS = options.nowS ?? wallClockS;
    this.wifiOnly = options.swiftlyWifiOnly ?? (() => readSwiftlyWifiOnly());
    this.watch = options.networkSource === undefined ? null : new NetworkWatch(options.networkSource, (message) => this.reportBug(message));
    const fetch = options.fetch ?? EXPO_FETCH;
    const deps: ProviderDeps = {
      get: (request: LiveRequest, signal: AbortSignal) => httpGet(request, signal, { fetch, counter: this.counter, nowS: this.nowS }),
      keys: () => this.keys,
      network: options.network,
      recordCall: (provider: ProviderId) => this.meter(provider),
      nowS: this.nowS,
    };
    this.providers = Object.freeze({ swiftly: createSwiftlyProvider(deps), transitland: createTransitlandProvider(deps), none: NONE_PROVIDER });
    invariant(PROVIDER_IDS.every((id) => this.providers[id].id === id), 'each provider is in its own slot');
    invariant(this.poller === null, 'a new runtime is stopped');
  }

  isStarted(): boolean {
    const started = this.poller !== null;
    invariant(!started || this.poller instanceof LivePoller, 'a started runtime has its poller');
    invariant(started || this.poller === null, 'a stopped runtime has none');
    invariant(this.watch === null || this.watch.listening === started, 'the network watch listens exactly while the runtime runs');
    return started;
  }

  /** Starts the network watch, the polling machinery and publishing; loads the keys from the Keychain. */
  start(): void {
    invariant(!this.isStarted(), 'the runtime is started once at a time');
    this.watch?.start(); // first: the gate reads the watch whenever the poller asks for standings
    const poller = new LivePoller({
      providers: this.providers,
      standings: () => this.standings(),
      nowS: this.nowS,
      onChange: () => this.emit(),
      onBug: (message) => this.reportBug(message),
    });
    this.poller = poller;
    poller.watchStations(this.stations);
    this.emit();
    detach(this.loadKeys(), (message) => this.reportBug(message));
    invariant(this.isStarted(), 'the runtime is started');
  }

  /** Aborts every request in flight and stops publishing. */
  stop(): void {
    const poller = this.poller;
    invariant(poller !== null, 'only a started runtime stops');
    this.poller = null;
    poller.dispose();
    this.watch?.stop();
    invariant(!this.isStarted(), 'the runtime is stopped');
  }

  /** The 1 s heartbeat (use-live-polling.ts, while the app is active); the chain reads the Swiftly gate afresh. */
  tick(): void {
    invariant(this.poller !== null, 'only a started runtime ticks');
    this.poller.tick();
    this.publishGateMove();
    invariant(this.isStarted(), 'a tick keeps the runtime started');
  }

  /**
   * Back from the background (and on mount, as the app becomes active): the network reading is
   * discarded and asked afresh, so Swiftly stays gated until a fresh answer says Wi-Fi; then every
   * task is due again and the chain resolves at once.
   */
  resume(): void {
    invariant(this.poller !== null, 'only a started runtime resumes');
    this.watch?.refresh();
    this.poller.resume();
    this.publishGateMove();
    invariant(this.isStarted(), 'resuming keeps the runtime started');
  }

  /** The stations whose predictions are polled; remembered across stop/start. */
  watchStations(stationKeys: readonly string[]): void {
    invariant(new Set(stationKeys).size === stationKeys.length, 'each station is watched once');
    this.stations = [...stationKeys];
    this.poller?.watchStations(this.stations);
    invariant(this.stations.length === stationKeys.length, 'every station asked for is watched');
  }

  /** Reads every credential from the Keychain and puts it in effect (or records why it could not). */
  async loadKeys(): Promise<Result<LiveKeys, KeyError>> {
    const read = await readLiveKeys(this.keychain);
    if (read.ok) {
      this.applyKeys(read.value);
    } else {
      this.keysError = read.error;
      this.emit();
    }
    invariant(read.ok || this.keysError === read.error, 'a failed read is reported in the state');
    invariant(!read.ok || (this.keys.swiftly === read.value.swiftly && this.keys.transitland === read.value.transitland), 'a successful read is in effect');
    return read;
  }

  /** Stores a pasted API key in the Keychain and puts it in effect at once. */
  async saveKey(provider: ProviderId, pasted: string): Promise<Result<string, KeyError>> {
    const saved = await saveKey(provider, pasted, this.keychain);
    if (saved.ok) {
      this.applyKeys({ ...this.keys, [provider]: saved.value });
    }
    invariant(!saved.ok || this.keys[provider] === saved.value, 'a saved key is in effect');
    invariant(saved.ok || saved.error.message.length > 0, 'a refusal explains itself');
    return saved;
  }

  /** Removes `provider`'s key from the Keychain; the chain stops using it at the next heartbeat. */
  async clearKey(provider: ProviderId): Promise<Result<null, KeyError>> {
    const cleared = await clearKey(provider, this.keychain);
    if (cleared.ok) {
      this.applyKeys({ ...this.keys, [provider]: null });
    }
    invariant(!cleared.ok || this.keys[provider] === null, 'a cleared key is out of effect');
    invariant(cleared.ok || cleared.error.kind === 'keychain', 'clearing fails only in the Keychain');
    return cleared;
  }

  /** Stores Swiftly's agency key (blank = `miami`) and puts it in effect at once. */
  async saveSwiftlyAgency(pasted: string): Promise<Result<string, KeyError>> {
    const saved = await saveSwiftlyAgency(pasted, this.keychain);
    if (saved.ok) {
      this.applyKeys({ ...this.keys, swiftlyAgency: saved.value });
    }
    invariant(!saved.ok || this.keys.swiftlyAgency === saved.value, 'a saved agency key is in effect');
    invariant(saved.ok || saved.error.message.length > 0, 'a refusal explains itself');
    return saved;
  }

  private applyKeys(next: LiveKeys): void {
    const swiftlyChanged = next.swiftly !== this.keys.swiftly || next.swiftlyAgency !== this.keys.swiftlyAgency;
    const changed = PROVIDER_IDS.filter((id) => (id === 'swiftly' ? swiftlyChanged : next[id] !== this.keys[id]));
    this.keys = Object.freeze({ ...next });
    this.keysError = null;
    for (const provider of changed) {
      this.poller?.credentialsChanged(provider);
    }
    invariant(this.keys.swiftly === next.swiftly && this.keys.transitland === next.transitland, 'the new keys are in effect');
    invariant(changed.every((id) => PROVIDER_IDS.includes(id)), 'only providers are told of a change');
    this.emit();
  }

  /**
   * A bug surfaced by a detached task (detach.ts): kept in the state as internalError, so it shows in every build. The
   * app's other detached work reports here too — the routed-walk runtime (src/ui/walk/RoutedWalkProvider.tsx) — so a
   * bug has one channel.
   */
  reportBug(message: string): void {
    invariant(message.length > 0, 'a bug report says what broke');
    this.internalError = message;
    invariant(this.internalError === message, 'the latest bug is the one reported');
    this.emit();
  }

  /** One REST call against `provider`'s monthly quota. */
  private meter(provider: ProviderId): void {
    const count = recordCall(this.quota, provider, this.nowS());
    invariant(count >= 1, 'the call was counted');
    invariant(Number.isSafeInteger(count), 'a call count is a whole number');
  }

  /**
   * Whether "Use Swiftly only on Wi-Fi" holds a keyed Swiftly back now: the setting is on and the phone
   * is off Wi-Fi (or has no reading: none yet, or discarded by a resume). Read afresh on every call,
   * never cached: the setting from its kv item (only when Swiftly has a key), the network from the
   * watch's latest reading.
   */
  private swiftlyGated(): boolean {
    invariant(this.watch === null || this.watch.listening, 'the gate is read only while the runtime runs, its network watch listening');
    if (this.keys.swiftly === null) {
      return false; // nothing to hold back, so the setting is not even read
    }
    const wifiOnly = this.wifiOnly();
    invariant(typeof wifiOnly === 'boolean', 'the Wi-Fi only setting reads on or off');
    return !swiftlyAllowed({ wifiOnly, onWifi: isOnWifi(this.watch === null ? null : this.watch.reading()) });
  }

  /** Publishes when the Swiftly gate moved but no chain status did (e.g. Swiftly benched for failing: Transitland serves either way). */
  private publishGateMove(): void {
    invariant(this.poller !== null, 'only a running runtime publishes');
    const gated = this.swiftlyGated();
    if (gated !== this.publishedGate) {
      this.emit();
    }
    invariant(this.publishedGate === gated, 'the published state shows the gate in effect');
  }

  /** Every provider's standing for the chain: key present (a gated Swiftly stands as key-less), capabilities, calls this month. */
  private standings(): Standings {
    invariant(this.poller !== null, 'the chain takes standings only while the runtime runs');
    const nowS = this.nowS();
    const gated = this.swiftlyGated();
    const standings = { swiftly: this.standing('swiftly', nowS, gated), transitland: this.standing('transitland', nowS, false) };
    invariant(PROVIDER_IDS.every((id) => Number.isSafeInteger(standings[id].callsThisMonth) && standings[id].callsThisMonth >= 0), 'call counts are whole and never negative');
    return standings;
  }

  private standing(provider: ProviderId, nowS: number, gated: boolean): ProviderStanding {
    invariant(Number.isFinite(nowS), 'a standing is taken at an instant');
    invariant(!gated || provider === 'swiftly', 'only Swiftly is gated');
    const standing: ProviderStanding = {
      hasKey: this.keys[provider] !== null && !gated,
      capabilities: this.providers[provider].capabilities,
      callsThisMonth: callsThisMonth(this.quota, provider, nowS),
    };
    invariant(standing.capabilities === this.providers[provider].capabilities, 'a standing carries the provider\'s own capabilities');
    return standing;
  }

  private emit(): void {
    const poller = this.poller;
    if (poller === null) {
      return; // stopped: nothing is published (a Keychain read can finish after a stop)
    }
    const nowS = this.nowS();
    this.publishedGate = this.swiftlyGated();
    const state: LiveState = Object.freeze({
      ...poller.snapshot,
      bytes: this.counter.snapshot(),
      callsThisMonth: Object.freeze({ swiftly: callsThisMonth(this.quota, 'swiftly', nowS), transitland: callsThisMonth(this.quota, 'transitland', nowS) }),
      hasKey: Object.freeze({ swiftly: this.keys.swiftly !== null, transitland: this.keys.transitland !== null }),
      keyHints: Object.freeze({ swiftly: hintOf(this.keys.swiftly), transitland: hintOf(this.keys.transitland) }),
      swiftlyAgency: this.keys.swiftlyAgency,
      keysError: this.keysError,
      internalError: this.internalError,
      swiftlyGated: this.publishedGate,
    });
    invariant(state.status === poller.snapshot.status, 'the state carries the poller\'s status');
    invariant(Object.values(state.hasKey).every((has) => typeof has === 'boolean'), 'the state says only whether a key exists');
    invariant(PROVIDER_IDS.every((id) => (state.keyHints[id] === null) === !state.hasKey[id]), 'a key has a masked hint, and only a key has one');
    this.options.onChange(state);
  }
}

/** A key's masked hint (`••••` + its last 4), or null for no key. */
function hintOf(key: string | null): string | null {
  const hint = key === null ? null : maskKey(key);
  invariant(hint === null || hint.startsWith(KEY_MASK), 'a hint is masked');
  invariant(hint === null || key === null || hint.length - KEY_MASK.length < key.length, 'a hint never shows the whole key');
  return hint;
}
