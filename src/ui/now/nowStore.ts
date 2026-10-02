import { useSyncExternalStore } from 'react';

import { invariant } from '@/lib/invariant';

import type { HomeContext } from './homeContext';

/**
 * Plan M7.7: the Now store — what the home screen knows about "now" beyond the clock, shared by the map
 * and the Now strip (ruling R2's bottom accessory):
 *
 *   lastGestureS  the rider's last pan or zoom on the map (TransitMap reports it): someone exploring the
 *                 map is never interrupted by an auto-presented sheet for a while (homeContext.ts)
 *   presentedKey  the station already auto-presented on this visit: shown once, not again on every tick,
 *                 until the rider leaves it
 *   context       the home context the Now strip computed last (homeContext.ts), which the Map tab acts on
 *
 * ONE store for the app, like follow mode's; nothing in it is saved.
 */

export type NowState = {
  readonly lastGestureS: number | null;
  readonly presentedKey: string | null;
  readonly context: HomeContext | null;
};

const EMPTY: NowState = Object.freeze({ lastGestureS: null, presentedKey: null, context: null });

export class NowStore {
  private state: NowState = EMPTY;
  private readonly listeners = new Set<() => void>();

  /** The current state (a new object only when something changed, as useSyncExternalStore requires). */
  readonly read = (): NowState => {
    const state = this.state;
    invariant(state.lastGestureS === null || Number.isSafeInteger(state.lastGestureS), 'a gesture is stamped with a whole second');
    invariant(state.presentedKey === null || state.presentedKey.includes(':'), 'a presented station is keyed mode:name');
    return state;
  };

  /** The rider panned, pinched or double-tapped the map at `nowS`. */
  noteMapGesture(nowS: number): void {
    invariant(Number.isSafeInteger(nowS), `a gesture is stamped with a whole second, got ${nowS}`);
    this.change({ ...this.state, lastGestureS: nowS });
    invariant(this.state.lastGestureS === nowS, 'the gesture is recorded');
  }

  /** `stationKey` was auto-presented: not again while the rider stays there. */
  markPresented(stationKey: string): void {
    invariant(stationKey.includes(':'), `a station is keyed mode:name, got "${stationKey}"`);
    this.change({ ...this.state, presentedKey: stationKey });
    invariant(this.state.presentedKey === stationKey, 'the station is marked presented');
  }

  /** The rider is no longer at the presented station: arriving again presents it again. */
  leftStation(): void {
    invariant(this.listeners.size >= 0, 'the store keeps its listeners');
    if (this.state.presentedKey !== null) {
      this.change({ ...this.state, presentedKey: null });
    }
    invariant(this.state.presentedKey === null, 'no station is marked presented');
  }

  /** The Now strip's latest home context. */
  publish(context: HomeContext): void {
    invariant(typeof context.kind === 'string', 'a home context has a kind');
    if (context !== this.state.context) {
      this.change({ ...this.state, context });
    }
    invariant(this.state.context === context, 'the context is published');
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    invariant(typeof listener === 'function', 'a listener is a function');
    this.listeners.add(listener);
    invariant(this.listeners.has(listener), 'the listener is registered');
    return () => this.listeners.delete(listener);
  };

  private change(next: NowState): void {
    invariant(next !== this.state, 'a change is a new state');
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
    invariant(this.state === next, 'the store holds the new state');
  }
}

/** The app's one Now store. */
export const NOW_STORE = new NowStore();

/** The Now store's state, live. */
export function useNowState(store: NowStore = NOW_STORE): NowState {
  const state = useSyncExternalStore(store.subscribe, store.read);
  invariant(state.lastGestureS === null || state.lastGestureS >= 0, 'a gesture is stamped after the epoch');
  invariant(typeof store.noteMapGesture === 'function', 'the store takes gestures');
  return state;
}
