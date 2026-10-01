import { act } from 'react-test-renderer';

import { renderPrimitive, unmountAll } from '../../primitives/__tests__/render-primitive';
import { DEFAULT_LAYERS, LAYER_IDS, layersReducer, type LayersState, parseLayers, serializeLayers } from '../layers';
import { LAYERS_ITEM, LayersStore, type LayersStorage } from '../layers-store';
import { LayersSheet } from '../LayersSheet';

/**
 * M5.12 Layers: the pure reducer and its saved form (layers.ts), the store that keeps them in the
 * kv-store (over an in-memory storage here), and the sheet's switches.
 */

afterEach(async () => {
  await unmountAll();
});

/** An in-memory kv-store holding only the layers item; `failWrites` makes every write throw as a full disk would. */
class MemoryStorage implements LayersStorage {
  readonly items: Map<string, string>;

  constructor(initial: Record<string, string> = {}, private readonly failWrites = false) {
    this.items = new Map(Object.entries(initial));
    expect(this.items.size).toBe(Object.keys(initial).length);
    expect([...this.items.keys()].every((key) => key === LAYERS_ITEM)).toBe(true);
  }

  getItemSync(key: string): string | null {
    expect(key).toBe(LAYERS_ITEM);
    const value = this.items.get(key) ?? null;
    expect(value === null || typeof value === 'string').toBe(true);
    return value;
  }

  setItemSync(key: string, value: string): void {
    expect(key).toBe(LAYERS_ITEM);
    expect(value.length).toBeGreaterThan(0);
    if (this.failWrites) {
      throw new Error('database or disk is full');
    }
    this.items.set(key, value);
  }
}

describe('layers reducer (M5.12)', () => {
  it('toggle flips only that layer', () => {
    for (const layer of LAYER_IDS) {
      const next = layersReducer(DEFAULT_LAYERS, { kind: 'toggle', layer });
      for (const other of LAYER_IDS) {
        expect([other, next[other]]).toEqual([other, other === layer ? !DEFAULT_LAYERS[other] : DEFAULT_LAYERS[other]]);
      }
      expect(layersReducer(next, { kind: 'toggle', layer })).toEqual(DEFAULT_LAYERS);
    }
  });

  it('persisted state round-trips', () => {
    const states: LayersState[] = [DEFAULT_LAYERS, ...LAYER_IDS.map((layer) => layersReducer(DEFAULT_LAYERS, { kind: 'toggle', layer }))];
    states.push(LAYER_IDS.reduce((state, layer) => layersReducer(state, { kind: 'toggle', layer }), DEFAULT_LAYERS));
    expect(states).toHaveLength(LAYER_IDS.length + 2);
    for (const state of states) {
      const back = parseLayers(serializeLayers(state));
      expect(back).toEqual({ ok: true, value: state });
    }
  });

  it('a corrupt, foreign or incomplete saved state is an Err, never a throw', () => {
    expect(parseLayers('{"version":1,"layers":{')).toMatchObject({ ok: false, error: { kind: 'corrupt' } });
    expect(parseLayers('{"version":2,"layers":{}}')).toMatchObject({ ok: false, error: { kind: 'version' } });
    expect(parseLayers('{"version":1,"layers":{"rail":true}}')).toMatchObject({ ok: false, error: { kind: 'shape' } });
    expect(parseLayers('null')).toMatchObject({ ok: false, error: { kind: 'version' } });
  });
});

describe('layers store (M5.12)', () => {
  it('a corrupt saved state falls back to every layer, and says so', () => {
    const store = new LayersStore(new MemoryStorage({ [LAYERS_ITEM]: 'not json' }));
    const { layers, problem } = store.read();
    expect(layers).toEqual(DEFAULT_LAYERS);
    expect(problem).toContain('not readable JSON');
  });

  it('a toggle is saved, and read back by the next launch', () => {
    const storage = new MemoryStorage();
    const store = new LayersStore(storage);
    const heard = jest.fn();
    store.subscribe(heard);
    store.dispatch({ kind: 'toggle', layer: 'mover' });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(new LayersStore(storage).read()).toEqual({ layers: { ...DEFAULT_LAYERS, mover: false }, problem: null });
  });

  it('a failed save keeps the change on screen and reports it', () => {
    const store = new LayersStore(new MemoryStorage({}, true));
    const after = store.dispatch({ kind: 'toggle', layer: 'stations' });
    expect(after.layers.stations).toBe(false);
    expect(after.problem).toContain('database or disk is full');
  });
});

describe('layers sheet (M5.12)', () => {
  it('one switch per layer, each flipping its own layer', async () => {
    const onToggle = jest.fn();
    const tree = await renderPrimitive(<LayersSheet layers={{ ...DEFAULT_LAYERS, vehicles: false }} problem={null} onToggle={onToggle} />);
    const switches = LAYER_IDS.map((layer) => tree.root.findByProps({ testID: `layer-switch-${layer}` }));
    expect(switches.map((control) => control.props.value)).toEqual(LAYER_IDS.map((layer) => layer !== 'vehicles'));
    // Scheduled positions are vehicles: with vehicles off, their switch is disabled.
    expect(switches.map((control) => Boolean(control.props.disabled))).toEqual(LAYER_IDS.map((layer) => layer === 'scheduled'));
    await act(async () => {
      tree.root.findByProps({ testID: 'layer-switch-rail' }).props.onValueChange(false);
    });
    expect(onToggle).toHaveBeenCalledWith('rail');
  });
});
