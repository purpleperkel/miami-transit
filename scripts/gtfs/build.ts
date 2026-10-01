import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { buildNetwork } from './build-network';
import { expandCalendar } from './calendar';
import { obtainFeed, type FeedBytes } from './feed-cache';
import { BUILDER_VERSION, decideBuild, sha256OfFile, type BuildDecision } from './idempotency';
import { loadFeed } from './load-feed';
import { buildManifest, readManifest, writeManifest, type Manifest } from './manifest';
import { FEED_URL, pipelinePaths, type PipelinePaths } from './paths';
import { buildScheduleRows } from './schedule-rows';
import type { ScheduleRows } from './schema';
import { unzipFeed } from './unzip-feed';
import { verifyScheduleDb } from './verify-db';
import { writeScheduleDb } from './write-db';

/**
 * `npm run gtfs:build [-- --force]` (plan §4 "GTFS pipeline", M2.18): the county zip → the bundled
 * schedule DB + manifest, idempotently.
 *
 *  1–2. Conditional GET through the cache (feed-cache.ts), SHA-256 the zip, decide (idempotency.ts):
 *       if the zip, builder version and DB hash all match the manifest, print UNCHANGED and write
 *       NOTHING (the DB and manifest keep their bytes and mtimes).
 *  3–12. Unzip, load, build the network and calendar, turn them into rows.
 *  13. Write the DB to a temp file in one transaction, VACUUM, integrity_check, verify-db, then
 *      rename it into place atomically.
 *  14. Write the manifest last (atomically), and print BUILT.
 *
 * Deterministic: the DB is a function of the zip bytes and the builder alone (no clock, no URL, no
 * HTTP headers inside it), so `--force` on the same zip reproduces it byte for byte.
 */

export type BuildOptions = {
  /** Absolute repo root; outputs go to <root>/assets/db, the zip cache to <root>/.cache/gtfs. */
  readonly root: string;
  readonly feedUrl: string;
  readonly force: boolean;
  readonly log: (line: string) => void;
};

export type BuildReport = {
  readonly status: 'BUILT' | 'UNCHANGED';
  readonly reason: BuildDecision['reason'];
  /** The manifest now on disk. */
  readonly manifest: Manifest;
};

export type BuildStep = 'manifest' | 'fetch' | 'unzip' | 'load' | 'network' | 'calendar' | 'rows' | 'write';
export type BuildError = { readonly kind: 'build'; readonly step: BuildStep; readonly message: string };

export async function runBuild(options: BuildOptions): Promise<Result<BuildReport, BuildError>> {
  invariant(isAbsolute(options.root) && existsSync(options.root), `the build root ${options.root} is an existing absolute path`);
  invariant(options.feedUrl.length > 0, 'the build has a feed URL');
  const paths = pipelinePaths(options.root);
  const stored = storedManifest(paths, options.force);
  if (!stored.ok) {
    return stored;
  }
  const feed = await obtainFeed(paths, options.feedUrl, stored.value);
  if (!feed.ok) {
    return err(buildError('fetch', feed.error.message));
  }
  options.log(fetchLine(feed.value, relative(options.root, paths.feedZip)));
  const decision = decideBuild(
    { feedSha256: feed.value.sha256, builderVersion: BUILDER_VERSION, dbSha256OnDisk: sha256OfFile(paths.scheduleDb), force: options.force },
    stored.value,
  );
  if (decision.action === 'skip') {
    invariant(stored.value !== null, 'only a stored manifest can be unchanged');
    options.log(`UNCHANGED: ${relative(options.root, paths.scheduleDb)} already holds feed ${feed.value.sha256.slice(0, 12)}… (builder ${BUILDER_VERSION}, DB sha256 matches the manifest); nothing written`);
    return ok({ status: 'UNCHANGED', reason: decision.reason, manifest: stored.value });
  }
  const built = buildOutputs(paths, feed.value, options.feedUrl);
  if (!built.ok) {
    return built;
  }
  options.log(builtLine(built.value, decision.reason, paths, options.root));
  return ok({ status: 'BUILT', reason: decision.reason, manifest: built.value });
}

/** The stored manifest; an unreadable one fails the build unless --force (which rebuilds it anyway). */
function storedManifest(paths: PipelinePaths, force: boolean): Result<Manifest | null, BuildError> {
  invariant(paths.manifest.endsWith('manifest.json'), 'the manifest path is the manifest');
  const stored = readManifest(paths.manifest);
  if (stored.ok) {
    return stored;
  }
  if (force) {
    return ok(null);
  }
  invariant(stored.error.message.length > 0, 'an unreadable manifest says why');
  return err(buildError('manifest', `${stored.error.message}; fix it or rebuild with --force`));
}

/** Steps 3–14 on the zip in hand: rows → verified DB installed atomically → manifest last. */
function buildOutputs(paths: PipelinePaths, feed: FeedBytes, feedUrl: string): Result<Manifest, BuildError> {
  invariant(feed.bytes.length > 0, 'the zip has bytes');
  const rows = deriveRows(feed);
  if (!rows.ok) {
    return rows;
  }
  mkdirSync(paths.dbDir, { recursive: true });
  const written = writeScheduleDb(rows.value, paths.scheduleDb, verifyScheduleDb);
  if (!written.ok) {
    return err(buildError('write', written.error.message));
  }
  const manifest = buildManifest(paths.scheduleDb, { url: feedUrl, sha256: feed.sha256, validators: feed.validators });
  if (!manifest.ok) {
    return err(buildError('manifest', manifest.error.message));
  }
  writeManifest(paths.manifest, manifest.value);
  invariant(sha256OfFile(paths.scheduleDb) === manifest.value.dbSha256, 'the manifest describes the installed DB');
  return manifest;
}

/** Steps 3–12: unzip, load the in-scope feed, build the network and the calendar, and the table rows. */
function deriveRows(feed: FeedBytes): Result<ScheduleRows, BuildError> {
  invariant(/^[0-9a-f]{64}$/.test(feed.sha256), 'the zip is hashed');
  const files = unzipFeed(feed.bytes);
  if (!files.ok) {
    return err(buildError('unzip', files.error.message));
  }
  const loaded = loadFeed(files.value);
  if (!loaded.ok) {
    return err(buildError('load', loaded.error.message));
  }
  const network = buildNetwork(loaded.value);
  if (!network.ok) {
    return err(buildError('network', network.error.message));
  }
  const calendar = expandCalendar(loaded.value.calendar, loaded.value.calendarDates, loaded.value.timeZone);
  if (!calendar.ok) {
    return err(buildError('calendar', calendar.error.message));
  }
  const rows = buildScheduleRows({ feed: loaded.value, network: network.value, calendar: calendar.value, feedSha256: feed.sha256 });
  if (!rows.ok) {
    return err(buildError('rows', rows.error.message));
  }
  invariant(rows.value.trip.length === loaded.value.trips.length, 'every in-scope trip has a row');
  return rows;
}

function fetchLine(feed: FeedBytes, cachedZip: string): string {
  invariant(feed.bytes.length > 0, 'a fetched zip has bytes');
  const line =
    feed.source === 'cache'
      ? `fetch: 304 Not Modified — using the cached ${cachedZip} (${feed.bytes.length} bytes)`
      : `fetch: 200 — ${feed.bytes.length} bytes, sha256 ${feed.sha256.slice(0, 12)}…, last-modified ${feed.validators.lastModified ?? 'none'}`;
  invariant(line.startsWith('fetch: '), 'the fetch line is labelled');
  return line;
}

function builtLine(manifest: Manifest, reason: BuildDecision['reason'], paths: PipelinePaths, root: string): string {
  invariant(manifest.dbBytes > 0, 'a built DB has bytes');
  const { counts, serviceEnd } = manifest;
  const line =
    `BUILT (${reason}): ${relative(root, paths.scheduleDb)} ${manifest.dbBytes} bytes, sha256 ${manifest.dbSha256.slice(0, 12)}…; ` +
    `${counts.stations} stations, ${counts.patterns} patterns, ${counts.trips} trips, ${counts.stopTimes} stop times; ` +
    `rail ends ${serviceEnd.rail.date}, Mover ends ${serviceEnd.mover.date}; manifest written last`;
  invariant(line.startsWith('BUILT'), 'the built line leads with BUILT');
  return line;
}

function buildError(step: BuildStep, message: string): BuildError {
  invariant(message.length > 0, 'a build error explains itself');
  const error: BuildError = { kind: 'build', step, message: `gtfs:build failed at ${step}: ${message}` };
  invariant(error.message.endsWith(message), 'the cause is kept');
  return error;
}

/** `--force` is the only option; anything else is a usage error (null). */
export function parseArgs(argv: readonly string[]): { readonly force: boolean } | null {
  invariant(Array.isArray(argv), 'arguments are a list');
  const unknown = argv.filter((arg) => arg !== '--force');
  invariant(unknown.length <= argv.length, 'unknown arguments come from argv');
  return unknown.length === 0 ? { force: argv.includes('--force') } : null;
}

async function main(argv: readonly string[]): Promise<number> {
  invariant(FEED_URL.startsWith('https://'), 'the county feed is fetched over https');
  const args = parseArgs(argv);
  if (args === null) {
    console.error('usage: npm run gtfs:build [-- --force]');
    return 2;
  }
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, 'scripts/gtfs')), 'run gtfs:build from the repo root');
  const result = await runBuild({ root, feedUrl: FEED_URL, force: args.force, log: (line) => console.log(line) });
  if (!result.ok) {
    console.error(result.error.message);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // A broken invariant is a crash, not an outcome: rethrow so Node prints it and exits non-zero.
      throw error;
    },
  );
}
