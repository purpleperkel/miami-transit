import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { HEARTBEAT_MS } from '../domain/live/constants';
import { invariant } from '../lib/invariant';

/**
 * Plan M4.9 / §4 Polling: "one 1 s heartbeat, only while the app is active". The hook starts the
 * live runtime for as long as the component is mounted, and ties its heartbeat to AppState:
 *
 *   active               → resume() (everything due again, cadence floors kept), then tick() every 1 s;
 *                          the live runtime first holds its poller until a heartbeat finds the fresh
 *                          network reading in (mfix10, runtime.ts), so no request starts on a stale one
 *   inactive, background → the heartbeat stops: no new request starts until the app is active again;
 *                          and pause(), so the runtime's floor clock counts the phone's sleep while the
 *                          app is away (mfix10 fix round 4: on iOS performance.now() stops in sleep)
 *
 * A request already in flight when the app leaves the foreground ends by itself (8 s abort at most).
 * Unmounting stops the heartbeat, then the runtime (which aborts whatever is in flight).
 */

/** What the hook drives: the live runtime (runtime.ts) or a test double. */
export type PollingRuntime = {
  start(): void;
  stop(): void;
  tick(): void;
  resume(): void;
  /** The app left the foreground (inactive or background); told on every such AppState report. */
  pause(): void;
};

/** The part of React Native's AppState the binding reads. */
export type AppStateSource = {
  readonly currentState: AppStateStatus | null;
  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
};

/** A heartbeat that runs only while `appState` says the app is active. */
export class PollingBinding {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly subscription: { remove(): void };

  constructor(
    private readonly runtime: PollingRuntime,
    appState: AppStateSource,
    private readonly heartbeatMs: number = HEARTBEAT_MS,
  ) {
    invariant(Number.isFinite(heartbeatMs) && heartbeatMs > 0, 'the heartbeat has a positive period');
    this.subscription = appState.addEventListener('change', (state) => this.onAppState(state));
    this.onAppState(appState.currentState);
    invariant(this.running === (appState.currentState === 'active'), 'the heartbeat runs exactly while the app is active');
  }

  /** Whether the heartbeat is running now. */
  get running(): boolean {
    const running = this.timer !== null;
    invariant(typeof running === 'boolean', 'the heartbeat is running or not');
    invariant(this.heartbeatMs > 0, 'a running heartbeat has a period');
    return running;
  }

  onAppState(state: AppStateStatus | null): void {
    invariant(state === null || typeof state === 'string', 'an app state is a name');
    if (state === 'active') {
      this.start();
    } else {
      this.stop();
      this.runtime.pause();
    }
    invariant(this.running === (state === 'active'), 'the heartbeat follows the app state');
  }

  /** Stops the heartbeat and stops listening to AppState. */
  dispose(): void {
    this.subscription.remove();
    this.stop();
    invariant(!this.running, 'a disposed binding has no heartbeat');
    invariant(this.timer === null, 'the interval is cleared');
  }

  private start(): void {
    if (this.timer !== null) {
      return;
    }
    this.runtime.resume();
    this.timer = setInterval(() => this.runtime.tick(), this.heartbeatMs);
    invariant(this.timer !== null, 'the heartbeat is running');
    invariant(this.running, 'the heartbeat reports running');
  }

  private stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    invariant(!this.running, 'the heartbeat is stopped');
    invariant(this.timer === null, 'the interval is cleared');
  }
}

/** Starts `runtime` while mounted and runs its heartbeat while the app is active. Null = nothing to poll yet. */
export function useLivePolling(runtime: PollingRuntime | null): void {
  invariant(runtime === null || typeof runtime.tick === 'function', 'the hook drives a polling runtime');
  invariant(typeof AppState.addEventListener === 'function', 'React Native provides AppState');
  useEffect(() => (runtime === null ? undefined : bindRuntime(runtime, AppState)), [runtime]);
}

/** Starts the runtime and its AppState-gated heartbeat; returns the teardown (heartbeat first, then the runtime). */
export function bindRuntime(runtime: PollingRuntime, appState: AppStateSource, heartbeatMs: number = HEARTBEAT_MS): () => void {
  runtime.start();
  const binding = new PollingBinding(runtime, appState, heartbeatMs);
  invariant(binding.running === (appState.currentState === 'active'), 'the heartbeat follows the app state from the start');
  invariant(heartbeatMs > 0, 'the heartbeat has a period');
  return () => {
    binding.dispose();
    runtime.stop();
  };
}
