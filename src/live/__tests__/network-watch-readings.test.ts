import type { NetworkState } from 'expo-network';

import { isOnWifi } from '../../domain/live/network-gate';
import { type NetworkSource, NetworkWatch } from '../network-watch';
import { networkState } from './live-fakes';

/**
 * mfix10: the reading rules of the app's one network watch (network-watch.ts), on a stand-in network
 * whose first answer lands (or fails) only when the test says: every listener event is the latest
 * reading, an event without a type included; a first answer the listener has overtaken never counts;
 * a stopped watch forgets its reading and ignores late answers.
 */

/** A network whose first answer the test settles by hand; it keeps every listener and counts removals. */
class HandNetwork implements NetworkSource {
  readonly listeners: ((state: NetworkState) => void)[] = [];
  removals = 0;
  private settle: { resolve: (state: NetworkState) => void; reject: (error: Error) => void } | null = null;

  getNetworkStateAsync(): Promise<NetworkState> {
    expect(this.settle).toBeNull();
    const answer = new Promise<NetworkState>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    expect(this.settle).not.toBeNull();
    return answer;
  }

  addNetworkStateListener(listener: (state: NetworkState) => void): { remove(): void } {
    this.listeners.push(listener);
    expect(this.listeners).toContain(listener);
    expect(this.removals).toBeLessThanOrEqual(this.listeners.length);
    return { remove: () => void (this.removals += 1) };
  }

  /** The first answer lands: `type`'s state, or a failure. */
  async answer(outcome: string | Error): Promise<void> {
    const settle = this.settle;
    expect(settle).not.toBeNull();
    if (outcome instanceof Error) {
      settle?.reject(outcome);
    } else {
      settle?.resolve(networkState(outcome));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(this.listeners.length).toBeGreaterThan(0);
  }

  /** Every listener hears `type` (null: an event without a type). */
  emit(type: string | null): void {
    expect(this.listeners.length).toBeGreaterThan(0);
    expect(type === null || type.length > 0).toBe(true);
    this.listeners.forEach((listener) => listener(networkState(type)));
  }
}

/** A started watch over a fresh HandNetwork, and the bugs it reported. */
function started(): { readonly watch: NetworkWatch; readonly network: HandNetwork; readonly bugs: string[] } {
  const network = new HandNetwork();
  const bugs: string[] = [];
  const watch = new NetworkWatch(network, (message) => void bugs.push(message));
  watch.start();
  expect([watch.listening, watch.reading()]).toEqual([true, null]);
  expect(network.listeners).toHaveLength(1);
  return { watch, network, bugs };
}

describe('the network watch (mfix10): which reading counts', () => {
  it('the first answer is the reading until a listener event comes', async () => {
    const { watch, network } = started();
    await network.answer('WIFI');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'WIFI' }, true]);
    network.emit('CELLULAR');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'CELLULAR' }, false]);
  });

  it('a listener event overtakes a late first answer', async () => {
    const { watch, network } = started();
    network.emit('WIFI');
    await network.answer('CELLULAR');
    expect(watch.reading()).toEqual({ type: 'WIFI' });
    expect(isOnWifi(watch.reading())).toBe(true);
  });

  it('an event without a type replaces the wi-fi reading and is not wi-fi', async () => {
    const { watch, network } = started();
    await network.answer('WIFI');
    expect(isOnWifi(watch.reading())).toBe(true);
    network.emit(null);
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{}, false]);
  });
});

describe('the network watch (mfix10): its lifetime', () => {
  it('stopping removes the subscription once, forgets the reading and ignores a late answer', async () => {
    const { watch, network } = started();
    network.emit('WIFI');
    watch.stop();
    expect([watch.listening, watch.reading(), network.removals]).toEqual([false, null, 1]);
    await network.answer('WIFI');
    expect(watch.reading()).toBeNull();
  });

  it('a first answer that fails is reported as a bug, and the phone is off wi-fi until an event comes', async () => {
    const { watch, network, bugs } = started();
    await network.answer(new Error('the native module is missing'));
    expect([bugs, watch.reading()]).toEqual([['Error: the native module is missing'], null]);
    network.emit('ETHERNET');
    expect(isOnWifi(watch.reading())).toBe(true);
  });

  it('a subscription without remove() is refused at start', () => {
    const automock: NetworkSource = { getNetworkStateAsync: () => new Promise<NetworkState>(() => undefined), addNetworkStateListener: () => Promise.resolve() as unknown as { remove(): void } };
    const watch = new NetworkWatch(automock, () => undefined);
    expect(() => watch.start()).toThrow('expo-network hands back a removable subscription');
    expect(watch.listening).toBe(false);
  });
});
