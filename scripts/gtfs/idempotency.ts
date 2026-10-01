import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { invariant } from '../../src/lib/invariant';

/**
 * Step 2 of the GTFS pipeline (plan §4): decide whether a build is needed. The build is skipped —
 * the CLI prints UNCHANGED and writes nothing — only when ALL of these hold:
 *  - the downloaded zip's SHA-256 equals the one the stored manifest was built from,
 *  - the builder version equals the stored one (new builder code may emit a different DB), and
 *  - the DB on disk still hashes to the stored dbSha256 (nobody replaced or damaged it).
 * Anything else — a mismatch, no manifest yet, no DB on disk, or --force — builds.
 */

/**
 * Bump whenever the builder's output for the SAME zip changes (schema, derivation, rounding…).
 * 1: the first schedule DB (M2.15–M2.20). 2: shape extension recorded per end (extended_start_m /
 * extended_end_m, arbiter ruling 2026-10-01).
 */
export const BUILDER_VERSION = 2;

/** The fields of the stored manifest this decision reads. */
export type BuildFingerprint = {
  readonly feedSha256: string;
  readonly builderVersion: number;
  readonly dbSha256: string;
};

export type BuildInputs = {
  readonly feedSha256: string;
  readonly builderVersion: number;
  /** SHA-256 of the DB file on disk now, or null when there is no DB file. */
  readonly dbSha256OnDisk: string | null;
  readonly force: boolean;
};

export type BuildReason = 'force' | 'no-manifest' | 'zip-changed' | 'builder-version-changed' | 'db-missing' | 'db-changed';
export type BuildDecision =
  | { readonly action: 'skip'; readonly reason: 'unchanged' }
  | { readonly action: 'build'; readonly reason: BuildReason };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function decideBuild(current: BuildInputs, stored: BuildFingerprint | null): BuildDecision {
  invariant(SHA256_HEX.test(current.feedSha256), 'the current zip hash is a lowercase SHA-256 hex digest');
  invariant(current.dbSha256OnDisk === null || SHA256_HEX.test(current.dbSha256OnDisk), 'the DB hash is null or SHA-256 hex');
  invariant(Number.isInteger(current.builderVersion) && current.builderVersion > 0, 'builder versions are positive integers');
  const decision = firstReasonToBuild(current, stored);
  invariant(decision.action === 'build' || !current.force, '--force never skips');
  return decision;
}

/** The checks in priority order: the first that fails names the reason to build. */
function firstReasonToBuild(current: BuildInputs, stored: BuildFingerprint | null): BuildDecision {
  invariant(typeof current.force === 'boolean', 'force is a flag');
  invariant(stored === null || SHA256_HEX.test(stored.dbSha256), 'a stored manifest records a SHA-256 of its DB');
  if (current.force) {
    return { action: 'build', reason: 'force' };
  }
  if (stored === null) {
    return { action: 'build', reason: 'no-manifest' };
  }
  if (stored.feedSha256 !== current.feedSha256) {
    return { action: 'build', reason: 'zip-changed' };
  }
  if (stored.builderVersion !== current.builderVersion) {
    return { action: 'build', reason: 'builder-version-changed' };
  }
  if (current.dbSha256OnDisk === null) {
    return { action: 'build', reason: 'db-missing' };
  }
  if (current.dbSha256OnDisk !== stored.dbSha256) {
    return { action: 'build', reason: 'db-changed' };
  }
  return { action: 'skip', reason: 'unchanged' };
}

export function sha256Hex(bytes: Uint8Array): string {
  invariant(bytes instanceof Uint8Array, 'sha256Hex hashes raw bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  invariant(SHA256_HEX.test(digest), 'a SHA-256 digest is 64 lowercase hex characters');
  return digest;
}

/** SHA-256 of a file's bytes, or null when the file does not exist (a read error still throws). */
export function sha256OfFile(path: string): string | null {
  invariant(path.length > 0, 'sha256OfFile needs a path');
  if (!existsSync(path)) {
    return null;
  }
  const digest = sha256Hex(readFileSync(path));
  invariant(digest.length === 64, 'a file digest is a full SHA-256');
  return digest;
}
