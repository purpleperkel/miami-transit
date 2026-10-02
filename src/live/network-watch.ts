import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

import type { NetworkReading } from '../domain/live/network-gate';
import { invariant } from '../lib/invariant';
import { detach } from './detach';

/**
 * mfix10: the app's ONE network watch, over expo-network. The live runtime owns it: runtime.ts starts
 * it when the runtime starts and stops it when the runtime stops (LiveDataProvider mounting and
 * unmounting). live-context.tsx hands the runtime EXPO_NETWORK; a runtime given no source has no
 * watch, so it never has a reading and the phone counts as off Wi-Fi.
 *
 * Starting subscribes with addNetworkStateListener and asks getNetworkStateAsync once; stopping
 * removes the subscription. The Swiftly gate reads `reading()` at every poll tick. Every listener
 * event is the latest reading, an event without a type included (arbiter ruling: "any other value",
 * so not Wi-Fi). The first answer counts only while no listener event has come, so a late first
 * answer never overwrites a newer network. A first answer that fails is a bug (expo-network is in Expo
 * Go and its iOS getNetworkStateAsync does not reject): it goes to `onBug`, and until a listener event
 * comes the phone counts as off Wi-Fi.
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
  /** A listener event has come since start(): the first answer, if it lands later, is older. */
  private heard = false;
  private subscription: { remove(): void } | null = null;
  /** Bumped by every start() and stop(), so a reading for an earlier start is never taken. */
  private generation = 0;

  constructor(
    private readonly source: NetworkSource,
    private readonly onBug: (message: string) => void,
  ) {
    invariant(typeof source.addNetworkStateListener === 'function', 'the watch listens to a network source');
    invariant(typeof onBug === 'function', 'the watch reports a failed first reading');
  }

  /** Whether the watch is subscribed now. */
  get listening(): boolean {
    const listening = this.subscription !== null;
    invariant(listening || this.latest === null, 'a watch that is not listening has no reading');
    invariant(this.generation >= 0, 'starts and stops are counted');
    return listening;
  }

  /** The latest reading, or null before the first one (not on Wi-Fi). */
  reading(): NetworkReading | null {
    const reading = this.latest;
    invariant(reading === null || Object.isFrozen(reading), 'a reading is immutable');
    invariant(reading === null || reading.type === undefined || typeof reading.type === 'string', 'a reading names its type, if it has one');
    return reading;
  }

  /** Subscribes to network changes, then asks for the first reading. */
  start(): void {
    invariant(!this.listening, 'the watch starts once at a time');
    this.generation += 1;
    this.heard = false;
    const generation = this.generation;
    const subscription = this.source.addNetworkStateListener((state) => this.hear(generation, state, true));
    invariant(typeof subscription?.remove === 'function', 'expo-network hands back a removable subscription');
    this.subscription = subscription;
    detach(this.askFirst(generation), this.onBug);
    invariant(this.listening, 'a started watch listens');
  }

  /** Removes the subscription and forgets the reading; a first answer still in flight is then ignored. */
  stop(): void {
    const subscription = this.subscription;
    invariant(subscription !== null, 'only a started watch stops');
    this.generation += 1;
    this.subscription = null;
    this.latest = null;
    subscription.remove();
    invariant(!this.listening, 'a stopped watch no longer listens');
  }

  private async askFirst(generation: number): Promise<void> {
    invariant(generation === this.generation, 'the first reading is asked for the current start');
    const state = await this.source.getNetworkStateAsync();
    const current = generation === this.generation && !this.heard;
    this.hear(generation, state, false);
    invariant(!current || this.latest?.type === readingOf(state)?.type, 'the first answer is in effect unless a listener event came first');
  }

  /** Takes `state` as the latest reading — unless it is for an earlier start, or a first answer the listener has overtaken. */
  private hear(generation: number, state: NetworkState | undefined, fromListener: boolean): void {
    invariant(typeof fromListener === 'boolean', 'a reading comes from the listener or the first answer');
    if (generation !== this.generation || (!fromListener && this.heard)) {
      return;
    }
    this.heard = this.heard || fromListener;
    this.latest = readingOf(state);
    invariant(this.listening, 'only a listening watch takes a reading');
  }
}

/**
 * expo-network's state as the gate reads it: its type, if it has one ({} for an event without a type).
 * Not an object at all is no reading (null): jest-expo's automock answers undefined, and the gate
 * treats both as off Wi-Fi.
 */
function readingOf(state: NetworkState | undefined): NetworkReading | null {
  invariant(state === undefined || typeof state === 'object', 'expo-network reports an object');
  if (state === undefined || state === null) {
    return null;
  }
  const type: unknown = state.type;
  const reading: NetworkReading = Object.freeze(typeof type === 'string' ? { type } : {});
  invariant(reading.type === (typeof type === 'string' ? type : undefined), "a reading keeps expo-network's type, or has none");
  return reading;
}
