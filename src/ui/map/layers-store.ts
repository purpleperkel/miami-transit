import Storage from 'expo-sqlite/kv-store';
import { useCallback, useSyncExternalStore } from 'react';

import { invariant } from '@/lib/invariant';
import { err, ok, type Result } from '@/lib/result';

import { DEFAULT_LAYERS, type LayerId, type LayersAction, layersReducer, type LayersState, parseLayers, serializeLayers } from './layers';

/**
 * The map's layers, kept (plan M5.12): one store shared by the Layers sheet and the map, so a toggle
 * in the sheet changes the map under it at once, and saved in expo-sqlite/kv-store (bundled in Expo
 * Go, read synchronously, like the quota meter and the walking paces) so the choice survives a
 * relaunch. The pure reducer and the saved form are layers.ts; this module is the I/O.
 *
 * A saved state this app cannot read, or a save that fails, is never swallowed: the defaults (or the
 * new state, unsaved) apply, and the snapshot's `problem` says why — the sheet shows it.
 */

/** The kv-store key holding the saved layers. */
export const LAYERS_ITEM = 'map.layers';

/** The part of expo-sqlite/kv-store the layers use (tests pass an in-memory one). */
export type LayersStorage = {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
};

export type LayersSnapshot = {
  readonly layers: LayersState;
  /** Why the saved layers could not be read, or the last change saved; null when all is well. */
  readonly problem: string | null;
};

/** The saved layers — or the defaults, with why, when nothing readable is saved. */
export function loadLayers(storage: LayersStorage): LayersSnapshot {
  invariant(typeof storage.getItemSync === 'function', 'the layers are read synchronously');
  const text = storage.getItemSync(LAYERS_ITEM);
  const parsed = text === null ? null : parseLayers(text);
  const snapshot: LayersSnapshot =
    parsed === null || parsed.ok
      ? { layers: parsed?.value ?? DEFAULT_LAYERS, problem: null }
      : { layers: DEFAULT_LAYERS, problem: `${parsed.error.message}, so every layer is shown` };
  invariant(snapshot.problem === null || snapshot.layers === DEFAULT_LAYERS, 'an unreadable save falls back to the defaults');
  return snapshot;
}

/** Saves the layers; a storage failure is an Err carrying why. */
export function saveLayers(storage: LayersStorage, layers: LayersState): Result<null, string> {
  invariant(typeof storage.setItemSync === 'function', 'the layers are written synchronously');
  const text = serializeLayers(layers);
  invariant(text.length > 0, 'the saved form is never empty');
  try {
    storage.setItemSync(LAYERS_ITEM, text);
    return ok(null);
  } catch (error) {
    return err(`the layers could not be saved (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The layers state, loaded on first read, saved on every change, with its listeners. */
export class LayersStore {
  private snapshot: LayersSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: LayersStorage) {
    invariant(typeof storage.getItemSync === 'function', 'the store reads synchronously');
    invariant(typeof storage.setItemSync === 'function', 'the store writes synchronously');
  }

  /** The current layers (stable between changes, as useSyncExternalStore requires). */
  readonly read = (): LayersSnapshot => {
    const snapshot = this.snapshot ?? loadLayers(this.storage);
    this.snapshot = snapshot;
    invariant(this.snapshot === snapshot, 'the loaded layers are kept');
    invariant(snapshot.layers !== undefined, 'a snapshot carries the layers');
    return snapshot;
  };

  /** Applies an action, saves the result and tells every listener. */
  dispatch(action: LayersAction): LayersSnapshot {
    const layers = layersReducer(this.read().layers, action);
    const saved = saveLayers(this.storage, layers);
    this.snapshot = { layers, problem: saved.ok ? null : saved.error };
    for (const listener of [...this.listeners]) {
      listener();
    }
    invariant(this.snapshot.layers === layers, 'the store holds the new layers');
    invariant(saved.ok || this.snapshot.problem !== null, 'a failed save is reported');
    return this.snapshot;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    invariant(typeof listener === 'function', 'a listener is a function');
    this.listeners.add(listener);
    invariant(this.listeners.has(listener), 'the listener is registered');
    return () => this.listeners.delete(listener);
  };
}

/** The app's one layers store, over expo-sqlite/kv-store. */
export const LAYERS_STORE = new LayersStore(Storage);

export type UseLayers = LayersSnapshot & {
  readonly toggle: (layer: LayerId) => void;
  readonly reset: () => void;
};

/** The layers, live: the sheet toggles them, the map draws them. */
export function useLayers(store: LayersStore = LAYERS_STORE): UseLayers {
  const snapshot = useSyncExternalStore(store.subscribe, store.read);
  const toggle = useCallback((layer: LayerId) => void store.dispatch({ kind: 'toggle', layer }), [store]);
  const reset = useCallback(() => void store.dispatch({ kind: 'reset' }), [store]);
  invariant(snapshot.layers !== undefined, 'the layers are known');
  invariant(typeof toggle === 'function' && typeof reset === 'function', 'the layers can be changed');
  return { ...snapshot, toggle, reset };
}
