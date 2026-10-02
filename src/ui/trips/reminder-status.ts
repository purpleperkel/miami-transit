import { useSyncExternalStore } from 'react';

import { invariant } from '@/lib/invariant';

/**
 * What the last reminder sync (ReminderSync.tsx) left to say: null when it worked, else why the phone's
 * reminders may be wrong (the native calls failed, or notifications are off for Expo Go). ONE store for
 * the app, written by the sync and shown on the Trips tab, so a failed sync is never silent.
 */
export class ReminderStatusStore {
  private problem: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** The last sync's problem, or null (stable between changes, as useSyncExternalStore requires). */
  readonly read = (): string | null => {
    const problem = this.problem;
    invariant(problem === null || problem.length > 0, 'a problem says why');
    invariant(this.listeners.size >= 0, 'the store keeps its listeners');
    return problem;
  };

  /** Records the outcome of a sync: null for one that worked. */
  report(problem: string | null): void {
    invariant(problem === null || problem.trim().length > 0, 'a problem says why');
    const changed = problem !== this.problem;
    this.problem = problem;
    if (changed) {
      for (const listener of [...this.listeners]) {
        listener();
      }
    }
    invariant(this.problem === problem, 'the store holds the latest outcome');
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    invariant(typeof listener === 'function', 'a listener is a function');
    this.listeners.add(listener);
    invariant(this.listeners.has(listener), 'the listener is registered');
    return () => this.listeners.delete(listener);
  };
}

/** The app's one reminder status. */
export const REMINDER_STATUS = new ReminderStatusStore();

/** The last reminder sync's problem, live; null when it worked (or none has run). */
export function useReminderStatus(store: ReminderStatusStore = REMINDER_STATUS): string | null {
  const problem = useSyncExternalStore(store.subscribe, store.read);
  invariant(problem === null || problem.length > 0, 'a problem says why');
  invariant(typeof store.report === 'function', 'the status can be written');
  return problem;
}
