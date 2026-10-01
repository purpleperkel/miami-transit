import type { AppStateStatus } from 'react-native';

import { type AppStateSource, bindRuntime, PollingBinding, type PollingRuntime } from '../use-live-polling';

/**
 * M4.9: the AppState-gated heartbeat. A fake AppState stands in for React Native's (the binding
 * takes it as a parameter; the hook passes the real one), and jest's fake timers stand in for time.
 */

/** An AppState whose state the test sets; listeners hear every change. */
class FakeAppState implements AppStateSource {
  private readonly listeners = new Set<(state: AppStateStatus) => void>();

  constructor(public currentState: AppStateStatus | null) {
    expect(this.listeners.size).toBe(0);
    expect(currentState === null || typeof currentState === 'string').toBe(true);
  }

  get listening(): number {
    expect(this.listeners).toBeInstanceOf(Set);
    expect(this.listeners.size).toBeGreaterThanOrEqual(0);
    return this.listeners.size;
  }

  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void } {
    expect(type).toBe('change');
    expect(typeof listener).toBe('function');
    this.listeners.add(listener);
    return { remove: () => void this.listeners.delete(listener) };
  }

  set(state: AppStateStatus): void {
    expect(typeof state).toBe('string');
    expect(this.listening).toBeGreaterThan(0);
    this.currentState = state;
    this.listeners.forEach((listener) => listener(state));
  }
}

/** A runtime that logs what the binding asks of it. */
class LoggingRuntime implements PollingRuntime {
  readonly log: string[] = [];

  start(): void {
    this.log.push('start');
    expect(this.log.filter((entry) => entry === 'start').length).toBeGreaterThan(this.log.filter((entry) => entry === 'stop').length);
    expect(this.log.length).toBeGreaterThan(0);
  }

  stop(): void {
    this.log.push('stop');
    expect(this.log).toContain('start');
    expect(this.log.length).toBeGreaterThan(1);
  }

  tick(): void {
    this.log.push('tick');
    expect(this.log).toContain('resume');
    expect(this.log[this.log.length - 1]).toBe('tick');
  }

  resume(): void {
    this.log.push('resume');
    expect(this.log.length).toBeGreaterThan(0);
    expect(this.log[this.log.length - 1]).toBe('resume');
  }

  /** How many entries of `kind` were logged. */
  count(kind: string): number {
    const n = this.log.filter((entry) => entry === kind).length;
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(this.log.length);
    return n;
  }
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('use-live-polling (M4.9): the heartbeat runs only while the app is active', () => {
  it('active at mount: the runtime starts, resumes, then ticks once a second', () => {
    const runtime = new LoggingRuntime();
    const unbind = bindRuntime(runtime, new FakeAppState('active'), 1_000);
    jest.advanceTimersByTime(3_000);
    expect(runtime.log).toEqual(['start', 'resume', 'tick', 'tick', 'tick']);
    unbind();
    expect(runtime.log[runtime.log.length - 1]).toBe('stop');
  });

  it('background stops the heartbeat (no tick while away); active again resumes, then ticks', () => {
    const runtime = new LoggingRuntime();
    const appState = new FakeAppState('active');
    const binding = new PollingBinding(runtime, appState, 1_000);
    jest.advanceTimersByTime(1_000);
    appState.set('background');
    jest.advanceTimersByTime(60_000);
    expect(runtime.count('tick')).toBe(1);
    expect(binding.running).toBe(false);
    appState.set('active');
    jest.advanceTimersByTime(2_000);
    expect(runtime.log).toEqual(['resume', 'tick', 'resume', 'tick', 'tick']);
  });

  it('inactive (the app switcher, Control Center) stops it too', () => {
    const runtime = new LoggingRuntime();
    const appState = new FakeAppState('active');
    const binding = new PollingBinding(runtime, appState, 1_000);
    appState.set('inactive');
    jest.advanceTimersByTime(10_000);
    expect(runtime.count('tick')).toBe(0);
    expect(binding.running).toBe(false);
  });

  it('mounted in the background: the runtime starts but nothing ticks until the app is active', () => {
    const runtime = new LoggingRuntime();
    const appState = new FakeAppState('background');
    const unbind = bindRuntime(runtime, appState, 1_000);
    jest.advanceTimersByTime(10_000);
    expect(runtime.log).toEqual(['start']);
    appState.set('active');
    expect(runtime.log).toEqual(['start', 'resume']);
    unbind();
  });

  it('teardown stops the heartbeat, stops listening to AppState, then stops the runtime', () => {
    const runtime = new LoggingRuntime();
    const appState = new FakeAppState('active');
    const unbind = bindRuntime(runtime, appState, 1_000);
    unbind();
    jest.advanceTimersByTime(10_000);
    expect(runtime.log).toEqual(['start', 'resume', 'stop']);
    expect(appState.listening).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
