import { type RefObject, useCallback, useEffect, useSyncExternalStore } from 'react';

import type { LatLon } from '@/lib/geo';
import { invariant } from '@/lib/invariant';

/**
 * Follow mode (plan M6.6): the vehicle sheet's Follow button asks the map to keep one vehicle in the
 * middle of the screen. ONE store, shared by the sheet (which starts and stops following) and the map
 * (which moves its camera): while a vehicle is followed, every frame that draws it glides the camera
 * to it; the rider's own pan, pinch or double-tap on the map ends follow mode, so the map never fights
 * a hand. Nothing is saved: follow mode lasts until a gesture, the button, or a relaunch.
 */

/** Each camera move glides this long — about one 250 ms frame tick, so the motion reads as continuous. */
export const FOLLOW_GLIDE_MS = 240;

/** Which vehicle the map follows (its frame key), with its listeners. */
export class FollowStore {
  private key: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** The followed vehicle's key, or null (stable between changes, as useSyncExternalStore requires). */
  readonly read = (): string | null => {
    const key = this.key;
    invariant(key === null || typeof key === 'string', 'follow mode holds a vehicle key or nothing');
    invariant(key === null || key.length > 0, 'a followed vehicle has a key');
    return key;
  };

  /** Follow `vehicleKey` (replacing any vehicle followed before). */
  follow(vehicleKey: string): void {
    invariant(vehicleKey.length > 0, 'follow names a vehicle');
    this.change(vehicleKey);
    invariant(this.key === vehicleKey, 'the vehicle is followed');
  }

  /** Stop following. */
  stop(): void {
    this.change(null);
    invariant(this.key === null, 'nothing is followed');
    invariant(this.read() === null, 'readers see follow mode end');
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    invariant(typeof listener === 'function', 'a listener is a function');
    this.listeners.add(listener);
    invariant(this.listeners.has(listener), 'the listener is registered');
    return () => this.listeners.delete(listener);
  };

  private change(key: string | null): void {
    invariant(key === null || key.length > 0, 'a followed vehicle has a key');
    const changed = key !== this.key;
    this.key = key;
    if (changed) {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }
    invariant(this.key === key, 'the store holds the new key');
  }
}

/** The app's one follow store. */
export const FOLLOW_STORE = new FollowStore();

export type UseFollow = {
  readonly followedKey: string | null;
  readonly follow: (vehicleKey: string) => void;
  readonly stop: () => void;
};

/** Follow mode, live: the vehicle sheet's button reads and changes it. */
export function useFollow(store: FollowStore = FOLLOW_STORE): UseFollow {
  const followedKey = useSyncExternalStore(store.subscribe, store.read);
  const follow = useCallback((vehicleKey: string) => store.follow(vehicleKey), [store]);
  const stop = useCallback(() => store.stop(), [store]);
  invariant(followedKey === null || followedKey.length > 0, 'a followed vehicle has a key');
  invariant(typeof follow === 'function' && typeof stop === 'function', 'follow mode can be changed');
  return { followedKey, follow, stop };
}

/** What follow mode needs from the map: react-native-maps' MapView camera. */
export type FollowCamera = { animateCamera(camera: { readonly center: LatLon }, options: { readonly duration: number }): void };

/** A vehicle as the map draws it this frame (VehicleFrame's key and place). */
export type FollowTarget = { readonly key: string; readonly coordinate: LatLon };

/**
 * The map's half of follow mode: each frame that draws the followed vehicle glides the camera to it,
 * and `onUserGesture` (the map's pan / double-tap handlers) ends follow mode.
 */
export function useFollowCamera(camera: RefObject<FollowCamera | null>, vehicles: readonly FollowTarget[], store: FollowStore = FOLLOW_STORE): { readonly onUserGesture: () => void } {
  const followedKey = useSyncExternalStore(store.subscribe, store.read);
  const target = followedKey === null ? null : (vehicles.find((vehicle) => vehicle.key === followedKey)?.coordinate ?? null);
  useEffect(() => {
    if (target !== null) {
      camera.current?.animateCamera({ center: target }, { duration: FOLLOW_GLIDE_MS });
    }
  }, [camera, target]);
  const onUserGesture = useCallback(() => store.stop(), [store]);
  invariant(target === null || followedKey !== null, 'the camera only moves for a followed vehicle');
  invariant(typeof onUserGesture === 'function', 'a gesture can end follow mode');
  return { onUserGesture };
}
