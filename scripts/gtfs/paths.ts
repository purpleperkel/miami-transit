import { isAbsolute, join, relative } from 'node:path';

import { invariant } from '../../src/lib/invariant';

/**
 * Where the GTFS pipeline reads and writes (plan §4 "GTFS pipeline"). Mac-side only.
 *
 * The schedule zip is public and keyless (plan §1: 200, 8,419,295 bytes, last modified 2026-07-31).
 * The downloaded zip lives in the gitignored `.cache/`; the generated DB and its manifest live in
 * `assets/db/` and are committed, because the phone bundles them.
 */
export const FEED_URL = 'https://www.miamidade.gov/transit/googletransit/current/google_transit.zip';

/** Repo-relative POSIX paths of every file the pipeline touches. */
export const REPO_PATHS = {
  cacheDir: '.cache/gtfs',
  feedZip: '.cache/gtfs/google_transit.zip',
  dbDir: 'assets/db',
  scheduleDb: 'assets/db/schedule.db',
  manifest: 'assets/db/manifest.json',
} as const;

export type PipelinePaths = { readonly [K in keyof typeof REPO_PATHS]: string };

/** REPO_PATHS resolved against an absolute repo root; every result stays inside the repo. */
export function pipelinePaths(repoRoot: string): PipelinePaths {
  invariant(isAbsolute(repoRoot), `the repo root must be an absolute path, got "${repoRoot}"`);
  const resolved = {
    cacheDir: join(repoRoot, REPO_PATHS.cacheDir),
    feedZip: join(repoRoot, REPO_PATHS.feedZip),
    dbDir: join(repoRoot, REPO_PATHS.dbDir),
    scheduleDb: join(repoRoot, REPO_PATHS.scheduleDb),
    manifest: join(repoRoot, REPO_PATHS.manifest),
  };
  invariant(
    Object.values(resolved).every((path) => !relative(repoRoot, path).startsWith('..')),
    'every pipeline path resolves inside the repo root',
  );
  return resolved;
}
