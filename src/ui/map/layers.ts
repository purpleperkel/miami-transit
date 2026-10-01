import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';

/**
 * The map's layers (plan M5.12, the Layers sheet): which parts of the map are drawn. PURE — the
 * reducer the sheet's toggles dispatch to, and the serializer for the saved state. Storage I/O lives
 * in layers-store.ts; this module imports no react, react-native or expo.
 *
 *   rail       Metrorail: its lines, stations and trains
 *   mover      Metromover: its loops, stations and cars
 *   stations   station markers
 *   vehicles   vehicle markers, live and scheduled
 *   scheduled  scheduled (hollow) vehicles: timetable positions where no live data covers them
 */

export const LAYER_IDS = ['rail', 'mover', 'stations', 'vehicles', 'scheduled'] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayersState = Readonly<Record<LayerId, boolean>>;

/** Everything drawn: the map as it first opens. */
export const DEFAULT_LAYERS: LayersState = Object.freeze({ rail: true, mover: true, stations: true, vehicles: true, scheduled: true });

export type LayersAction = { readonly kind: 'toggle'; readonly layer: LayerId } | { readonly kind: 'reset' };

/** The layers after one action: a toggle flips that layer alone; reset restores the defaults. */
export function layersReducer(state: LayersState, action: LayersAction): LayersState {
  invariant(isLayersState(state), 'the reducer starts from a complete layers state');
  const next: LayersState = action.kind === 'reset' ? DEFAULT_LAYERS : Object.freeze({ ...state, [action.layer]: !state[action.layer] });
  invariant(isLayersState(next), 'the reducer ends at a complete layers state');
  return next;
}

/** The saved form's version: a stored state of another version is not read. */
export const LAYERS_FORMAT_VERSION = 1;

/** The saved form: `{"version":1,"layers":{"rail":true,…}}`, every layer named, in LAYER_IDS order. */
export function serializeLayers(state: LayersState): string {
  invariant(isLayersState(state), 'only a complete layers state is saved');
  const layers = Object.fromEntries(LAYER_IDS.map((id) => [id, state[id]]));
  const text = JSON.stringify({ version: LAYERS_FORMAT_VERSION, layers });
  invariant(text.startsWith(`{"version":${LAYERS_FORMAT_VERSION},`), 'the saved form leads with its version');
  return text;
}

/** Why a saved layers state was not read (the defaults apply, and the sheet says so). */
export type LayersParseError = { readonly kind: 'corrupt' | 'version' | 'shape'; readonly message: string };

/** The state a saved form holds, or why it cannot be read: not JSON, another version, or not every layer a yes/no. */
export function parseLayers(text: string): Result<LayersState, LayersParseError> {
  invariant(typeof text === 'string', 'a saved form is text');
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== LAYERS_FORMAT_VERSION) {
    return err({ kind: 'version', message: `the saved layers are not version ${LAYERS_FORMAT_VERSION}` });
  }
  const layers = 'layers' in value ? value.layers : undefined;
  if (typeof layers !== 'object' || layers === null || !LAYER_IDS.every((id) => typeof (layers as Record<string, unknown>)[id] === 'boolean')) {
    return err({ kind: 'shape', message: `the saved layers do not say yes or no for each of ${LAYER_IDS.join(', ')}` });
  }
  const state: LayersState = Object.freeze(Object.fromEntries(LAYER_IDS.map((id) => [id, (layers as Record<string, boolean>)[id]])) as Record<LayerId, boolean>);
  invariant(isLayersState(state), 'a parsed state is complete');
  return ok(state);
}

/** JSON.parse as a Result: malformed text is an Err, never a throw. */
function parseJson(text: string): Result<unknown, LayersParseError> {
  invariant(typeof JSON.parse === 'function', 'the runtime parses JSON');
  try {
    const value: unknown = JSON.parse(text);
    invariant(value !== undefined, 'JSON.parse returns a value');
    return ok(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return err({ kind: 'corrupt', message: `the saved layers are not readable JSON (${error.message})` });
  }
}

/** Whether `state` names every layer with a yes/no, and nothing else. */
export function isLayersState(state: LayersState): boolean {
  invariant(typeof state === 'object' && state !== null, 'a layers state is an object');
  const keys = Object.keys(state);
  invariant(keys.every((key) => typeof key === 'string'), 'layer names are strings');
  return keys.length === LAYER_IDS.length && LAYER_IDS.every((id) => typeof state[id] === 'boolean');
}
