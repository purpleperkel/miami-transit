import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';

import type { HurryVerdict } from '@/domain/hurry/verdict';
import { invariant } from '@/lib/invariant';
import { detach } from '@/live/detach';

import { actionableVerdict } from './copy';

/**
 * Plan M7c.2: a JOG verdict fires ONE Warning haptic per departure — the moment to start moving is felt,
 * not just read. The departures already cued are remembered MODULE-WIDE, so a card re-rendering every
 * tick, a sheet re-opened, or two cards showing the same train never buzz twice for it; a new departure
 * that asks for a jog buzzes again. A departure is keyed by its merged-board row key (stable while live
 * predictions move its time), else by line, headsign and time.
 *
 * A haptic that fails to play is not swallowed: the card that asked for it says so (useJogCue).
 */

/** At most this many cued departures are remembered (the oldest is forgotten first): a few hours of trains. */
export const MAX_REMEMBERED_CUES = 64;

const CUED = new Set<string>();

/** The departure a verdict asks the rider to jog for, as a cue key; null when it asks for no jog. */
export function jogCueKey(verdict: HurryVerdict): string | null {
  const acted = actionableVerdict(verdict);
  const departure = acted.kind === 'JOG' ? acted.departure : null;
  invariant(acted.kind !== 'JOG' || departure !== null, 'a JOG verdict is about a departure');
  const key = departure === null ? null : (departure.key ?? `${departure.lineId ?? '?'}|${departure.headsign ?? '?'}|${departure.epoch}`);
  invariant(key === null || key.length > 0, 'a cue key is never empty');
  return key;
}

/** Plays the Warning haptic for `key` unless it has played for it already; a failure is handed to `onFailure`. */
export function cueJog(key: string, onFailure: (message: string) => void): void {
  invariant(key.length > 0, 'a cue is for a departure');
  invariant(typeof onFailure === 'function', 'a failed cue is reported');
  if (CUED.has(key)) {
    return;
  }
  CUED.add(key);
  const oldest = CUED.size > MAX_REMEMBERED_CUES ? CUED.values().next().value : undefined;
  if (oldest !== undefined) {
    CUED.delete(oldest);
  }
  detach(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning), (message) => onFailure(`The jog buzz did not play: ${message}`));
}

type CueProblem = { readonly key: string; readonly message: string };

/** Cues the verdict's JOG departure once (module-wide); returns why its haptic failed, or null. */
export function useJogCue(verdict: HurryVerdict): string | null {
  const key = jogCueKey(verdict);
  const [problem, setProblem] = useState<CueProblem | null>(null);
  useEffect(() => (key === null ? undefined : startCue(key, setProblem)), [key]);
  invariant(problem === null || problem.message.length > 0, 'a cue problem says why');
  invariant(key === null || key.length > 0, 'a cue key is never empty');
  return problem !== null && problem.key === key ? problem.message : null;
}

/** Cues `key` for a mounted card; a failure reaches the card only while it is still mounted. Returns the teardown. */
function startCue(key: string, report: (problem: CueProblem) => void): () => void {
  invariant(typeof report === 'function', 'a cue reports its failure to the card');
  const life = { mounted: true };
  cueJog(key, (message) => (life.mounted ? report({ key, message }) : undefined));
  invariant(life.mounted, 'the cue starts while the card is mounted');
  return () => {
    life.mounted = false;
  };
}
