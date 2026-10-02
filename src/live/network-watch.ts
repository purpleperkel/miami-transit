import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

import type { NetworkReading } from '../domain/live/network-gate';
import { invariant } from '../lib/invariant';
import { detach } from './detach';

/**
 * mfix10: the app's ONE network watch, over expo-network. The live runtime owns it (runtime.ts): the
 * watch starts when the runtime starts and stops when the runtime stops (LiveDataProvider mounting and
 * unmounting), and it is refreshed every time the runtime resumes, which use-live-polling.ts does as
 * the app becomes active: right after mount when the app is open, and on every return to the
 * foreground. live-context.tsx hands the runtime EXPO_NETWORK; a runtime given no source has no watch,
 * so it never has a reading and the phone counts as off Wi-Fi.
 *
 * Starting subscribes with addNetworkStateListener; stopping removes that subscription and forgets the
 * reading. Every listener event is the latest reading, an event without a type included (arbiter
 * ruling: "any other value", so not Wi-Fi). The Swiftly gate reads `reading()` at every poll tick.
 *
 * FOREGROUND REFRESH (arbiter, mfix10 fix round): iOS suspends the app's JavaScript in the background,
 * so the phone can leave Wi-Fi without a listener event reaching the app. `refresh()` therefore
 * DISCARDS the reading (no reading is not Wi-Fi, so Swiftly is gated) and asks getNetworkStateAsync
 * afresh; Swiftly can serve again only once that answer, or a listener event, says WIFI or ETHERNET.
 * Only the answer to the LATEST ask counts, and only while no listener event has come since that ask:
 * an answer to an ask made before the latest refresh, or one a listener event has overtaken, is
 * dropped. getNetworkStateAsync is thus asked once on mount (the first resume) and once per return to
 * the foreground.
 *
 * An ask that fails is a bug (expo-network is in Expo Go and its iOS getNetworkStateAsync does not
 * reject): it goes to `onBug`, and until a listener event comes the phone counts as off Wi-Fi.
 */

/** The part of expo-network the watch uses: the module itself (EXPO_NETWORK) or a test's stand-in. */
export type NetworkSource = {
  getNetworkStateAsync(): Promise<NetworkState>;
  addNetworkStateListener(listener: (state: NetworkState) => void): { remove(): void };
};

/** expo-network itself. */
export const EXPO_NETWORK: NetworkSource = Object.freeze({
  getNetworkStateAsync: () => getNetworkStateAsync(),
  addNetworkStateListener: (listener: (state: NetworkState) => void) => addNetworkStateListener(listener),
});

export class NetworkWatch {
  private latest: NetworkReading | null = null;
  private subscription: { remove(): void } | null = null;
  /** Bumped by every start() and stop() (odd while listening): an event or an answer from an earlier start is never taken. */
  private generation = 0;
  /** Bumped by every refresh(): only the answer to the latest ask can count. */
  private asks = 0;
  /** A listener event has come since the latest ask, so that ask's answer, if it lands later, is older. */
  private heard = false;

  constructor(
    private readonly source: NetworkSource,
    private readonly onBug: (message: string) => void,
  ) {
    invariant(typeof source.addNetworkStateListener === 'function', 'the watch listens to a network source');
    invariant(typeof onBug === 'function', 'the watch reports a failed ask');
  }

  /** Whether the watch is subscribed now. */
  get listening(): boolean {
    const listening = this.subscription !== null;
    invariant(listening || this.latest === null, 'a watch that is not listening has no reading');
    invariant((this.generation % 2 === 1) === listening, 'starts and stops alternate: the generation is odd exactly while the watch listens');
    return listening;
  }

  /** The latest reading, or null when there is none (before the first answer, after a refresh): not on Wi-Fi. */
  reading(): NetworkReading | null {
    const reading = this.latest;
    invariant(reading === null || Object.isFrozen(reading), 'a reading is immutable');
    invariant(reading === null || reading.type === undefined || typeof reading.type === 'string', 'a reading names its type as a string, or has none');
    return reading;
  }

  /** Subscribes to network changes. The reading stays empty until the first refresh() answers or an event comes. */
  start(): void {
    invariant(!this.listening, 'the watch starts once at a time');
    const generation = this.generation + 1;
    const subscription = this.source.addNetworkStateListener((state) => this.hear(generation, null, state));
    invariant(typeof subscription?.remove === 'function', 'expo-network hands back a removable subscription');
    this.generation = generation;
    this.subscription = subscription;
    this.heard = false;
  }

  /** Back in the foreground: forgets the reading (so not Wi-Fi) and asks the network afresh; an older answer still in flight no longer counts. */
  refresh(): void {
    invariant(this.listening, 'only a listening watch refreshes');
    invariant(typeof this.source.getNetworkStateAsync === 'function', 'the watch can ask its network source for a reading');
    this.latest = null;
    this.heard = false;
    this.asks += 1;
    detach(this.ask(this.generation, this.asks), this.onBug);
  }

  /** Removes the subscription and forgets the reading; an answer still in flight is then ignored. */
  stop(): void {
    const subscription = this.subscription;
    invariant(subscription !== null, 'only a started watch stops');
    invariant(this.generation % 2 === 1, 'a started watch is on an odd generation');
    this.generation += 1;
    this.subscription = null;
    this.latest = null;
    subscription.remove();
  }

  /** Asks the network for a reading, for the start `generation` and the ask numbered `ask`. */
  private async ask(generation: number, ask: number): Promise<void> {
    invariant(generation % 2 === 1, 'only a started watch asks');
    invariant(Number.isSafeInteger(ask) && ask >= 1, 'an ask is numbered from 1');
    const state = await this.source.getNetworkStateAsync();
    this.hear(generation, ask, state);
  }

  /**
   * Takes `state` as the latest reading: a listener event (`ask` null), or the answer to ask number
   * `ask` — unless it is for an earlier start, an answer to an earlier ask, or an answer a listener
   * event has overtaken. Not an object at all is no reading (jest-expo's automock answers undefined).
   */
  private hear(generation: number, ask: number | null, state: NetworkState | undefined): void {
    invariant(ask === null || (ask >= 1 && ask <= this.asks), 'an answer belongs to an ask this watch made');
    invariant(state === undefined || typeof state === 'object', 'expo-network reports a state object');
    if (generation !== this.generation || (ask !== null && (ask !== this.asks || this.heard))) {
      return;
    }
    this.heard = this.heard || ask === null;
    this.latest = state === undefined || state === null ? null : Object.freeze(typeof state.type === 'string' ? { type: state.type } : {});
  }
}
