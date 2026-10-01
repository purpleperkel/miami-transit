import { existsSync, readFileSync } from 'node:fs';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { writeFileAtomically } from '../lib/atomic-file';
import { fetchFeed, NO_VALIDATORS, type FetchError, type FeedValidators } from './fetch-feed';
import { sha256Hex } from './idempotency';
import type { Manifest } from './manifest';

/**
 * Plan §4 steps 1–2 (M2.18): get the zip the build will hash, through the gitignored cache.
 *
 * The downloaded zip is kept at `.cache/gtfs/google_transit.zip`. The conditional GET sends the
 * stored manifest's ETag / Last-Modified ONLY when that cached zip is the very zip the manifest
 * was built from (same SHA-256). So a 304 always means "the cached bytes are current" and the
 * build — including `--force` — has the bytes in hand; a fresh clone (no cache) or a damaged cache
 * just downloads again. A 200 refreshes the cache when the bytes differ (never rewrites it
 * otherwise).
 */

export type FeedBytes = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** The validators that describe these bytes (stored in the manifest when the DB is rebuilt). */
  readonly validators: FeedValidators;
  /** 'cache' after a 304; 'download' after a 200. */
  readonly source: 'cache' | 'download';
};

export type CachePaths = { readonly feedZip: string };

export async function obtainFeed(paths: CachePaths, url: string, stored: Manifest | null): Promise<Result<FeedBytes, FetchError>> {
  invariant(paths.feedZip.endsWith('.zip'), 'the cache holds a zip');
  invariant(url.length > 0, 'the feed has a URL');
  const cached = existsSync(paths.feedZip) ? new Uint8Array(readFileSync(paths.feedZip)) : null;
  const cachedSha = cached === null ? null : sha256Hex(cached);
  const current = stored !== null && cached !== null && cachedSha === stored.feedSha256;
  const validators = current ? { etag: stored.feedEtag, lastModified: stored.feedLastModified } : NO_VALIDATORS;
  const fetched = await fetchFeed(url, validators);
  if (!fetched.ok) {
    return err(fetched.error);
  }
  if (fetched.value.kind === 'not-modified') {
    invariant(current && cached !== null && cachedSha !== null, 'a 304 only answers a request sent with the cached zip’s validators');
    return ok({ bytes: cached, sha256: cachedSha, validators, source: 'cache' });
  }
  const { bytes } = fetched.value;
  const sha256 = sha256Hex(bytes);
  if (sha256 !== cachedSha) {
    writeFileAtomically(paths.feedZip, bytes);
  }
  invariant(sha256Hex(new Uint8Array(readFileSync(paths.feedZip))) === sha256, 'the cache now holds exactly the downloaded zip');
  return ok({ bytes, sha256, validators: fetched.value.validators, source: 'download' });
}
