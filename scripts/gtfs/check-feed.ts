import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { fetchFeed, NO_VALIDATORS, type FeedValidators } from './fetch-feed';
import { sha256Hex } from './idempotency';
import { readManifest, type Manifest } from './manifest';
import { FEED_URL, REPO_PATHS } from './paths';

/**
 * `npx tsx scripts/gtfs/check-feed.ts` (plan M9.1): has the county republished the schedule zip
 * since the committed DB was built? It is READ-ONLY — it writes nothing anywhere, neither assets/db
 * nor the .cache zip: recording the new zip or its validators here would swallow the change before
 * any rebuild saw it.
 *
 *  1. Read assets/db/manifest.json: the SHA-256 of the zip the committed DB was built from, and the
 *     ETag / Last-Modified that came with that zip.
 *  2. A conditional GET with those validators (fetch-feed.ts). A 304 is UNCHANGED: the server
 *     vouches that the zip is still the one those validators describe.
 *  3. A 200 is hashed. The zip's SHA-256 decides, not its validators: equal to the manifest's
 *     feedSha256 is UNCHANGED (a new ETag or date on the same bytes is not a republish), different
 *     is CHANGED.
 *
 * Exit codes: 0 UNCHANGED, 10 CHANGED, 1 the check could not answer (no or unreadable manifest,
 * network, HTTP status, a body that is not a zip), 2 usage. A failed check is never 0 or 10.
 */

export const CHECK_EXIT = { unchanged: 0, changed: 10, failed: 1, usage: 2 } as const;

export type CheckOptions = {
  /** Absolute path of the manifest the committed DB was built with. */
  readonly manifestPath: string;
  readonly feedUrl: string;
};

/** The zip the server sent: its hash, size and validators. */
export type LiveZip = { readonly sha256: string; readonly bytes: number; readonly validators: FeedValidators };

export type FeedCheck = {
  readonly status: 'UNCHANGED' | 'CHANGED';
  /** The manifest's feedSha256: the zip the committed DB was built from. */
  readonly builtFrom: string;
  /** The validators sent as If-None-Match / If-Modified-Since. */
  readonly sent: FeedValidators;
  /** The downloaded zip after a 200; null after a 304 (no bytes were sent). */
  readonly live: LiveZip | null;
};

export type CheckStep = 'manifest' | 'fetch';
export type CheckError = { readonly kind: 'check'; readonly step: CheckStep; readonly message: string };

export async function checkFeed(options: CheckOptions): Promise<Result<FeedCheck, CheckError>> {
  invariant(isAbsolute(options.manifestPath) && options.manifestPath.endsWith('.json'), 'the manifest is an absolute .json path');
  invariant(/^https?:\/\//.test(options.feedUrl), `the feed URL is http(s), got "${options.feedUrl}"`);
  const manifest = committedManifest(options.manifestPath);
  if (!manifest.ok) {
    return manifest;
  }
  const builtFrom = manifest.value.feedSha256;
  const sent = validatorsFor(manifest.value, options.feedUrl);
  const fetched = await fetchFeed(options.feedUrl, sent);
  if (!fetched.ok) {
    return err(checkError('fetch', fetched.error.message));
  }
  if (fetched.value.kind === 'not-modified') {
    return ok({ status: 'UNCHANGED', builtFrom, sent, live: null });
  }
  const live: LiveZip = { sha256: sha256Hex(fetched.value.bytes), bytes: fetched.value.bytes.length, validators: fetched.value.validators };
  const check: FeedCheck = { status: live.sha256 === builtFrom ? 'UNCHANGED' : 'CHANGED', builtFrom, sent, live };
  invariant((check.status === 'CHANGED') === (live.sha256 !== builtFrom), 'CHANGED exactly when the zip bytes differ from the manifest');
  return ok(check);
}

/** The manifest on disk; a missing or unreadable one is a failed check, never a verdict. */
function committedManifest(path: string): Result<Manifest, CheckError> {
  invariant(isAbsolute(path) && path.endsWith('.json'), 'the manifest is an absolute .json path');
  const read = readManifest(path);
  if (!read.ok) {
    return err(checkError('manifest', read.error.message));
  }
  if (read.value === null) {
    return err(checkError('manifest', `no manifest at ${path}: there is no committed DB to compare the feed with`));
  }
  invariant(/^[0-9a-f]{64}$/.test(read.value.feedSha256), 'a readable manifest records the SHA-256 of its zip');
  return ok(read.value);
}

/** The manifest's validators belong to the URL it was built from; another URL gets an unconditional GET. */
function validatorsFor(manifest: Manifest, feedUrl: string): FeedValidators {
  invariant(manifest.feedUrl.length > 0 && feedUrl.length > 0, 'both the built-from URL and the checked URL are known');
  const sent = manifest.feedUrl === feedUrl ? { etag: manifest.feedEtag, lastModified: manifest.feedLastModified } : NO_VALIDATORS;
  invariant(manifest.feedUrl === feedUrl || (sent.etag === null && sent.lastModified === null), 'validators are only sent to the URL they came from');
  return sent;
}

/** The process exit code for a finished check: 0 UNCHANGED, 10 CHANGED. */
function exitCodeOf(check: FeedCheck): number {
  invariant(check.status === 'UNCHANGED' || check.live !== null, 'a CHANGED verdict always has the live zip');
  const code = check.status === 'CHANGED' ? CHECK_EXIT.changed : CHECK_EXIT.unchanged;
  invariant((code === CHECK_EXIT.changed) === (check.status === 'CHANGED'), 'exit 10 exactly for CHANGED, 0 exactly for UNCHANGED');
  return code;
}

/** The one line a finished check prints. */
function verdictLine(check: FeedCheck): string {
  invariant(/^[0-9a-f]{64}$/.test(check.builtFrom), 'the built-from hash is a SHA-256');
  const built = `${check.builtFrom.slice(0, 12)}…`;
  const { live } = check;
  let line: string;
  if (live === null) {
    line = `UNCHANGED: 304 Not Modified to the manifest's validators (ETag ${check.sent.etag ?? 'none'}, Last-Modified ${check.sent.lastModified ?? 'none'}); the feed is still the zip the committed DB was built from (sha256 ${built})`;
  } else if (check.status === 'UNCHANGED') {
    line = `UNCHANGED: 200, ${live.bytes} bytes, sha256 ${live.sha256.slice(0, 12)}… equals the manifest's feedSha256 (ETag ${live.validators.etag ?? 'none'}); the committed DB is current`;
  } else {
    line = `CHANGED: 200, ${live.bytes} bytes, sha256 ${live.sha256.slice(0, 12)}…, last-modified ${live.validators.lastModified ?? 'none'}; the committed DB was built from sha256 ${built}. Run npm run gtfs:refresh, then commit assets/db`;
  }
  invariant(line.startsWith(check.status), 'the line leads with the verdict');
  return line;
}

export type CheckRun = CheckOptions & {
  /** Where the verdict goes (stdout in the CLI). */
  readonly log: (line: string) => void;
  /** Where a failed check goes (stderr in the CLI). */
  readonly warn: (line: string) => void;
};

/** Run the check, print its verdict or failure, and return the process exit code. */
export async function runCheckFeed(run: CheckRun): Promise<number> {
  invariant(typeof run.log === 'function' && typeof run.warn === 'function', 'the run has somewhere to print');
  const result = await checkFeed(run);
  if (!result.ok) {
    run.warn(`check-feed: FAILED at ${result.error.step}: ${result.error.message} (exit ${CHECK_EXIT.failed}: neither unchanged nor changed)`);
    return CHECK_EXIT.failed;
  }
  run.log(verdictLine(result.value));
  const code = exitCodeOf(result.value);
  invariant(code === CHECK_EXIT.unchanged || code === CHECK_EXIT.changed, 'a finished check exits 0 or 10');
  return code;
}

function checkError(step: CheckStep, message: string): CheckError {
  invariant(message.length > 0, 'a check error explains itself');
  const error: CheckError = { kind: 'check', step, message };
  invariant(error.message === message, 'the cause is kept verbatim');
  return error;
}

const USAGE = 'usage: npx tsx scripts/gtfs/check-feed.ts   (no arguments; exit 0 unchanged, 10 changed, 1 the check failed)';

async function main(argv: readonly string[]): Promise<number> {
  invariant(FEED_URL.startsWith('https://'), 'the county feed is fetched over https');
  if (argv.length > 0) {
    console.error(USAGE);
    return CHECK_EXIT.usage;
  }
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, 'scripts/gtfs')), 'run check-feed from the repo root');
  return runCheckFeed({
    manifestPath: join(root, REPO_PATHS.manifest),
    feedUrl: FEED_URL,
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // A broken invariant is a crash, not an outcome: rethrow so Node prints it and exits 1 (never 0 or 10).
      throw error;
    },
  );
}
