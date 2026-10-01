import { invariant } from '@/lib/invariant';
import { err, type Result } from '@/lib/result';

/**
 * A device capability probe (plan M1.16–M1.17) either passes with one line of evidence for the
 * Diagnostics screen, or fails with the reason. Probes never throw and never hang: `settleProbe`
 * turns an exception into `err(...)` and fails a step that does not answer in time.
 */
export type ProbeOutcome = Result<string, string>;

/** One probe step: it may answer synchronously or asynchronously, and may throw. */
export type ProbeStep = () => ProbeOutcome | Promise<ProbeOutcome>;

export async function settleProbe(label: string, step: ProbeStep, timeoutMs: number): Promise<ProbeOutcome> {
  invariant(label.length > 0, 'a probe names itself in its failures');
  invariant(Number.isFinite(timeoutMs) && timeoutMs > 0, 'a probe step has a positive time limit');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve(err(`${label}: no answer within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  let outcome: ProbeOutcome;
  try {
    outcome = await Promise.race([step(), deadline]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    outcome = err(`${label}: ${reason.length > 0 ? reason : 'failed without a message'}`);
  } finally {
    clearTimeout(timer);
  }
  invariant(typeof outcome.ok === 'boolean', 'a settled probe is always a Result');
  return outcome;
}
