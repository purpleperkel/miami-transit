import type { NetworkState } from 'expo-network';

import { isOnWifi } from '../../domain/live/network-gate';
import { type NetworkSource, NetworkWatch } from '../network-watch';
import { networkState } from './live-fakes';

/**
 * mfix10: the reading rules of the app's one network watch (network-watch.ts), on a stand-in network
 * whose answers land (or fail) only when the test says. Starting only subscribes; every refresh (the
 * runtime's resume) discards the reading and asks afresh; every listener event is the latest reading,
 * an event without a type included; only the answer to the latest ask counts, and only until a
 * listener event overtakes it; a stopped watch forgets its reading and ignores late answers.
 */

type Settle = { readonly resolve: (state: NetworkState) => void; readonly reject: (error: Error) => void };

/** A network whose answers the test settles by hand, ask by ask; it keeps every listener and counts removals. */
class HandNetwork implements NetworkSource {
  readonly listeners: ((state: NetworkState) => void)[] = [];
  /** Every ask the watch made, in order; ask number n is asked[n - 1]. */
  readonly asked: Settle[] = [];
  removals = 0;

  getNetworkStateAsync(...args: unknown[]): Promise<NetworkState> {
    expect(args).toEqual([]); // expo-network's getNetworkStateAsync takes nothing
    expect(this.listeners.length - this.removals).toBe(1); // the watch asks only while its one subscription is open
    return new Promise<NetworkState>((resolve, reject) => void this.asked.push({ resolve, reject }));
  }

  addNetworkStateListener(listener: (state: NetworkState) => void): { remove(): void } {
    expect(typeof listener).toBe('function');
    expect(this.listeners.length).toBe(this.removals); // one watch: never a second subscription while one is open
    this.listeners.push(listener);
    return { remove: () => void (this.removals += 1) };
  }

  /** Ask number `ask` (1-based; the latest by default) lands: `type`'s state, or a failure. */
  async answer(outcome: string | Error, ask: number = this.asked.length): Promise<void> {
    const settle = this.asked[ask - 1];
    expect(settle).toBeDefined();
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

/** A watch over a fresh HandNetwork, started and refreshed once (as the runtime does on mount), and the bugs it reported. */
function started(): { readonly watch: NetworkWatch; readonly network: HandNetwork; readonly bugs: string[] } {
  const network = new HandNetwork();
  const bugs: string[] = [];
  const watch = new NetworkWatch(network, (message) => void bugs.push(message));
  watch.start();
  watch.refresh();
  expect([watch.listening, watch.reading(), network.asked.length]).toEqual([true, null, 1]);
  expect(network.listeners).toHaveLength(1);
  return { watch, network, bugs };
}

describe('the network watch (mfix10): which reading counts', () => {
  it('starting only subscribes: the watch asks nothing and has no reading until a refresh or an event', () => {
    const network = new HandNetwork();
    const watch = new NetworkWatch(network, () => undefined);
    watch.start();
    expect([watch.listening, network.listeners.length, network.asked.length, watch.reading()]).toEqual([true, 1, 0, null]);
    network.emit('WIFI');
    expect(isOnWifi(watch.reading())).toBe(true);
  });

  it('the answer is the reading until a listener event comes', async () => {
    const { watch, network } = started();
    await network.answer('WIFI');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'WIFI' }, true]);
    network.emit('CELLULAR');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'CELLULAR' }, false]);
  });

  it('a listener event overtakes a late answer', async () => {
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

describe('the network watch (mfix10): a refresh, back in the foreground', () => {
  it('a refresh discards the wi-fi reading and asks again; only the fresh answer counts', async () => {
    const { watch, network } = started();
    await network.answer('WIFI');
    expect(isOnWifi(watch.reading())).toBe(true);
    watch.refresh();
    expect([watch.reading(), isOnWifi(watch.reading()), network.asked.length]).toEqual([null, false, 2]);
    await network.answer('CELLULAR');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'CELLULAR' }, false]);
  });

  it('an answer to an ask from before the latest refresh is dropped, whenever it lands', async () => {
    const { watch, network } = started();
    watch.refresh();
    await network.answer('WIFI', 1);
    expect([watch.reading(), network.asked.length]).toEqual([null, 2]);
    await network.answer('CELLULAR', 2);
    expect(watch.reading()).toEqual({ type: 'CELLULAR' });
  });

  it('a listener event before a refresh neither survives it nor blocks its answer; one after it overtakes the answer', async () => {
    const { watch, network } = started();
    network.emit('WIFI');
    watch.refresh();
    expect(watch.reading()).toBeNull();
    await network.answer('CELLULAR');
    expect(watch.reading()).toEqual({ type: 'CELLULAR' });
    watch.refresh();
    network.emit('ETHERNET');
    await network.answer('CELLULAR');
    expect([watch.reading(), isOnWifi(watch.reading())]).toEqual([{ type: 'ETHERNET' }, true]);
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

  it('an ask that fails is reported as a bug, and the phone is off wi-fi until an event comes', async () => {
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
