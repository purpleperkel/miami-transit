import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { FetchFn, FetchResponseLike } from '../../../live/http';
import { runtimeNetwork } from '../../../live/__tests__/live-fakes';
import { LiveRuntime, type LiveState } from '../../../live/runtime';
import { DataSettingsView } from '../DataSettingsScreen';
import type { KvStoreFake, SecureStoreFake } from './native-fakes';

/**
 * Data & Settings under test, the way the app runs it: a REAL LiveRuntime (Keychain → runtime → state)
 * over the native-module fakes (native-fakes.ts — each test file mocks expo-secure-store and
 * expo-sqlite/kv-store with them), and the real DataSettingsView rendered from the runtime's latest
 * state. The runtime and the screen share one manual clock. Keys are fake.
 */

/** A fake Transitland key (last 4: WXYZ) and a second one (last 4: QRST). */
export const FAKE_KEY = 'fake-tl-K9q2Vx7Lm4WXYZ';
export const FAKE_KEY_2 = 'fake-tl-B3c8Hd1Jf6QRST';
/** 2026-10-01 16:00 UTC (noon in Miami), in epoch seconds. */
export const OCT_1_NOON_S = Date.UTC(2026, 9, 1, 16) / 1000;

/** Unless a test gives one, there is no network: every fetch fails as if the phone were offline. */
function offline(url: string): Promise<FetchResponseLike> {
  expect(typeof url).toBe('string');
  expect(url.startsWith('https://')).toBe(true);
  return Promise.reject(new Error('offline in this test'));
}

export type LiveRig = {
  readonly runtime: LiveRuntime;
  readonly keychain: SecureStoreFake;
  readonly kv: KvStoreFake;
  readonly clock: { now: number };
  /** The runtime's latest published state. */
  latest(): LiveState;
};

export type SettingsScreen = {
  tree(): ReactTestRenderer;
  /** Re-renders the screen from the runtime's latest state. */
  refresh(): Promise<void>;
  press(testID: string): Promise<void>;
  type(testID: string, text: string): Promise<void>;
  /** The text under every host node carrying `testID`. */
  textOf(testID: string): string;
  /** A prop of the first element carrying `testID` that has it. */
  prop(testID: string, name: string): unknown;
  /** The whole rendered tree as JSON: every text and every prop. */
  json(): string;
};

const mounted: { tree: ReactTestRenderer; runtime: LiveRuntime }[] = [];

/** Lets the Keychain calls, fetches and React updates finish. */
export async function settle(): Promise<void> {
  const before = Date.now();
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(Date.now()).toBeGreaterThanOrEqual(before);
  expect(mounted.length).toBeGreaterThanOrEqual(0);
}

/** A started runtime over the native fakes, seeded with Keychain items and kv-store entries. */
export async function liveRig(seed: { keychain?: Record<string, string>; kv?: Record<string, string>; fetch?: FetchFn } = {}): Promise<LiveRig> {
  const keychain = jest.requireMock<SecureStoreFake>('expo-secure-store');
  const kv = jest.requireMock<KvStoreFake>('expo-sqlite/kv-store');
  keychain.items.clear();
  kv.map.clear();
  Object.entries(seed.keychain ?? {}).forEach(([key, value]) => keychain.items.set(key, value));
  Object.entries(seed.kv ?? {}).forEach(([key, value]) => kv.map.set(key, value));
  const clock = { now: OCT_1_NOON_S };
  const states: LiveState[] = [];
  const runtime = new LiveRuntime({ network: runtimeNetwork(), onChange: (state) => void states.push(state), fetch: seed.fetch ?? offline, nowS: () => clock.now });
  await act(async () => {
    runtime.start();
    await settle();
  });
  keychain.setItemAsync.mockClear();
  keychain.deleteItemAsync.mockClear();
  expect(runtime.isStarted()).toBe(true);
  expect(states.length).toBeGreaterThan(0);
  return { runtime, keychain, kv, clock, latest: () => states[states.length - 1] as LiveState };
}

/** The real DataSettingsView over `rig`'s runtime, drawn at the rig's clock. */
export async function renderSettings(rig: LiveRig): Promise<SettingsScreen> {
  let tree: ReactTestRenderer | null = null;
  await act(async () => {
    tree = create(settingsView(rig));
    await settle();
  });
  expect(tree).not.toBeNull();
  const renderer = tree as unknown as ReactTestRenderer;
  mounted.push({ tree: renderer, runtime: rig.runtime });
  expect(renderer.toJSON()).not.toBeNull();
  return screenOf(renderer, () => settingsView(rig));
}

/** The screen as the app renders it, from the runtime's latest state. */
function settingsView(rig: LiveRig): ReactElement {
  expect(rig.runtime.isStarted()).toBe(true);
  expect(Number.isFinite(rig.clock.now)).toBe(true);
  return <DataSettingsView live={{ state: rig.latest(), runtime: rig.runtime }} clock={() => rig.clock.now} />;
}

function screenOf(renderer: ReactTestRenderer, view: () => ReactElement): SettingsScreen {
  expect(renderer.toJSON()).not.toBeNull();
  expect(typeof view).toBe('function');
  return {
    tree: () => renderer,
    refresh: () => refresh(renderer, view),
    press: (testID) => press(renderer, view, testID),
    type: (testID, text) => typeText(renderer, testID, text),
    textOf: (testID) => hostText(renderer, testID),
    prop: (testID, name) => findProp(renderer, testID, name),
    json: () => JSON.stringify(renderer.toJSON()),
  };
}

async function refresh(renderer: ReactTestRenderer, view: () => ReactElement): Promise<void> {
  expect(typeof view).toBe('function');
  await act(async () => {
    await settle();
    renderer.update(view());
    await settle();
  });
  expect(renderer.toJSON()).not.toBeNull();
}

/** Presses the control carrying `testID` (its onPress, as a tap would), lets the action finish, then re-renders. */
async function press(renderer: ReactTestRenderer, view: () => ReactElement, testID: string): Promise<void> {
  const onPress = findProp(renderer, testID, 'onPress');
  expect(typeof onPress).toBe('function');
  await act(async () => {
    (onPress as (event: unknown) => void)({ nativeEvent: {} });
    await settle();
  });
  await refresh(renderer, view);
  expect(renderer.toJSON()).not.toBeNull();
}

/** Types (or pastes) `text` into the field carrying `testID`. */
async function typeText(renderer: ReactTestRenderer, testID: string, text: string): Promise<void> {
  const onChangeText = findProp(renderer, testID, 'onChangeText');
  expect(typeof onChangeText).toBe('function');
  await act(async () => {
    (onChangeText as (value: string) => void)(text);
    await settle();
  });
  expect(renderer.toJSON()).not.toBeNull();
}

/** The first element carrying `testID` whose `name` prop is set. */
function findProp(renderer: ReactTestRenderer, testID: string, name: string): unknown {
  const hits = renderer.root.findAll((node) => node.props.testID === testID && node.props[name] !== undefined);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.props[name]).toBeDefined();
  return hits[0]?.props[name];
}

/** The text under the host nodes carrying `testID`, read with an explicit stack. */
function hostText(renderer: ReactTestRenderer, testID: string): string {
  const hosts = renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
  expect(hosts.length).toBeGreaterThan(0);
  const parts: string[] = [];
  const stack: unknown[] = hosts.map((host) => host.children).reverse();
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') {
      parts.push(next);
    } else if (Array.isArray(next)) {
      stack.push(...[...next].reverse());
    } else if (next !== null && typeof next === 'object' && 'children' in next) {
      stack.push((next as { children: unknown }).children);
    }
  }
  expect(parts.length).toBeGreaterThan(0);
  return parts.join('');
}

/** Unmounts every screen and stops every runtime a test started (afterEach). */
export async function unmountAll(): Promise<void> {
  const all = mounted.splice(0, mounted.length);
  for (const { tree, runtime } of all) {
    await act(async () => {
      tree.unmount();
      await settle();
    });
    if (runtime.isStarted()) {
      runtime.stop();
    }
  }
  expect(mounted).toHaveLength(0);
  expect(all.every(({ runtime }) => !runtime.isStarted())).toBe(true);
}
