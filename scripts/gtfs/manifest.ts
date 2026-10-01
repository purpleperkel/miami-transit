import { existsSync, readFileSync } from 'node:fs';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { writeFileAtomically } from '../lib/atomic-file';
import { NodeSqlExecutor, sqlResult } from '../lib/node-sql-executor';
import { baseEpoch } from './calendar';
import type { FeedValidators } from './fetch-feed';
import { sha256Hex } from './idempotency';
import { MODE_CODES } from './schema';

/**
 * Plan §4 step 14 (M2.17): the manifest written LAST, next to the DB, describing it — what it was
 * built from, what it holds, and when each mode's schedule runs out:
 *   {schemaVersion, builderVersion, feedUrl, feedSha256, feedEtag, feedLastModified, dbSha256,
 *    dbBytes, sqliteVersion, serviceStartDate, serviceEnd:{rail:{date,epoch}, mover:{date,epoch}},
 *    counts:{stations,patterns,trips,stopTimes}}
 *
 * Every DB fact is READ BACK from the finished file with SQL (not from the builder's memory), so
 * the manifest describes the bytes on disk. A mode's service end is the last date any of its trips
 * runs, and its epoch is that service day's start + 86400 — start(date) being the M2.14 base epoch
 * (local noon − 12 h in America/New_York). There is deliberately no build timestamp: the same zip
 * gives the same manifest.
 */

export type ServiceEnd = { readonly date: number; readonly epoch: number };

export type Manifest = {
  readonly schemaVersion: number;
  readonly builderVersion: number;
  readonly feedUrl: string;
  readonly feedSha256: string;
  readonly feedEtag: string | null;
  readonly feedLastModified: string | null;
  readonly dbSha256: string;
  readonly dbBytes: number;
  readonly sqliteVersion: string;
  readonly serviceStartDate: number;
  readonly serviceEnd: { readonly rail: ServiceEnd; readonly mover: ServiceEnd };
  readonly counts: { readonly stations: number; readonly patterns: number; readonly trips: number; readonly stopTimes: number };
};

/** The manifest's top-level fields, in the order they are written. */
export const MANIFEST_FIELDS = [
  'schemaVersion',
  'builderVersion',
  'feedUrl',
  'feedSha256',
  'feedEtag',
  'feedLastModified',
  'dbSha256',
  'dbBytes',
  'sqliteVersion',
  'serviceStartDate',
  'serviceEnd',
  'counts',
] as const satisfies readonly (keyof Manifest)[];

/** Where the DB's zip came from: its URL, hash and the HTTP validators the next conditional GET sends. */
export type FeedSource = { readonly url: string; readonly sha256: string; readonly validators: FeedValidators };

export type ManifestError = { readonly kind: 'manifest'; readonly message: string };

const SECONDS_PER_DAY = 86_400;

/** start(date) + 86400: the instant a service date's schedule (and so the feed, on its last date) runs out. */
export function serviceEndEpoch(date: number): number {
  const epoch = baseEpoch(date) + SECONDS_PER_DAY;
  invariant(Number.isSafeInteger(epoch), 'a service-end epoch is a whole second');
  invariant(epoch > baseEpoch(date), 'a service day ends after it starts');
  return epoch;
}

/** The manifest for the finished DB at `dbPath`, built from `feed`. */
export function buildManifest(dbPath: string, feed: FeedSource): Result<Manifest, ManifestError> {
  invariant(existsSync(dbPath), `the DB ${dbPath} exists before it is described`);
  invariant(/^[0-9a-f]{64}$/.test(feed.sha256), 'the feed hash is a SHA-256 hex digest');
  const bytes = readFileSync(dbPath);
  const opened = NodeSqlExecutor.open(dbPath, 'read-only');
  if (!opened.ok) {
    return err({ kind: 'manifest', message: opened.error.message });
  }
  const facts = sqlResult(dbPath, () => readFacts(opened.value));
  opened.value.close();
  if (!facts.ok) {
    return err({ kind: 'manifest', message: facts.error.message });
  }
  if (facts.value.feedSha256 !== feed.sha256) {
    return err({ kind: 'manifest', message: `${dbPath} was built from zip ${facts.value.feedSha256}, not ${feed.sha256}` });
  }
  const { feedSha256, ...dbFacts } = facts.value;
  return ok({
    schemaVersion: dbFacts.schemaVersion,
    builderVersion: dbFacts.builderVersion,
    feedUrl: feed.url,
    feedSha256,
    feedEtag: feed.validators.etag,
    feedLastModified: feed.validators.lastModified,
    dbSha256: sha256Hex(bytes),
    dbBytes: bytes.length,
    sqliteVersion: dbFacts.sqliteVersion,
    serviceStartDate: dbFacts.serviceStartDate,
    serviceEnd: dbFacts.serviceEnd,
    counts: dbFacts.counts,
  });
}

type DbFacts = Pick<Manifest, 'schemaVersion' | 'builderVersion' | 'feedSha256' | 'sqliteVersion' | 'serviceStartDate' | 'serviceEnd' | 'counts'>;

function readFacts(db: NodeSqlExecutor): DbFacts {
  const meta = new Map(db.all<{ key: string; value: string }>('SELECT key, value FROM meta').map((row) => [row.key, row.value]));
  invariant(meta.has('feed_sha256') && meta.has('builder_version'), 'meta records the source zip and the builder');
  const counts = db.get<DbFacts['counts']>(`SELECT (SELECT count(*) FROM station) AS stations, (SELECT count(*) FROM pattern) AS patterns,
    (SELECT count(*) FROM trip) AS trips, (SELECT count(*) FROM stop_time) AS stopTimes`);
  const serviceStartDate = db.value('SELECT min(date) FROM service_day_active');
  invariant(counts !== null && typeof serviceStartDate === 'number', 'the DB has counts and at least one active service day');
  return {
    schemaVersion: Number(db.value('PRAGMA user_version')),
    builderVersion: Number(meta.get('builder_version')),
    feedSha256: meta.get('feed_sha256') ?? '',
    sqliteVersion: String(db.value('SELECT sqlite_version()')),
    serviceStartDate,
    serviceEnd: { rail: modeServiceEnd(db, MODE_CODES.rail), mover: modeServiceEnd(db, MODE_CODES.mover) },
    counts: { ...counts },
  };
}

/** The last date a trip of `mode` runs, and that service day's start + 86400 (read from service_day). */
function modeServiceEnd(db: NodeSqlExecutor, mode: number): ServiceEnd {
  const date = db.value(
    `SELECT max(a.date) FROM service_day_active a WHERE a.service_idx IN (
      SELECT t.service_idx FROM trip t JOIN pattern p ON p.pattern_idx = t.pattern_idx JOIN line l ON l.line_id = p.line_id WHERE l.mode = ?)`,
    [mode],
  );
  invariant(typeof date === 'number', `mode ${mode} runs on at least one service day`);
  const start = db.value('SELECT base_epoch FROM service_day WHERE date = ?', [date]);
  invariant(typeof start === 'number' && start === baseEpoch(date), `service_day ${date} holds the M2.14 base epoch`);
  return { date, epoch: start + SECONDS_PER_DAY };
}

/** The manifest as it is written: pretty JSON, fields in MANIFEST_FIELDS order, one trailing newline. */
export function manifestText(manifest: Manifest): string {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  invariant(JSON.stringify(Object.keys(JSON.parse(text) as object)) === JSON.stringify(MANIFEST_FIELDS), 'fields are written in order');
  invariant(text.endsWith('}\n'), 'the file ends with one newline');
  return text;
}

export function writeManifest(path: string, manifest: Manifest): void {
  invariant(path.endsWith('.json'), 'the manifest is a JSON file');
  writeFileAtomically(path, manifestText(manifest));
  invariant(existsSync(path), 'the manifest was written');
}

/** The stored manifest, null when there is none yet; unreadable JSON or a missing/mistyped field is an Err. */
export function readManifest(path: string): Result<Manifest | null, ManifestError> {
  invariant(path.endsWith('.json'), 'the manifest is a JSON file');
  if (!existsSync(path)) {
    return ok(null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return err({ kind: 'manifest', message: `${path} is not JSON: ${error.message}` });
  }
  const problem = manifestProblem(parsed);
  invariant(problem === null || problem.length > 0, 'a problem is described');
  return problem === null ? ok(parsed as Manifest) : err({ kind: 'manifest', message: `${path}: ${problem}` });
}

/** How each field is checked: a whole number, non-empty text (or null), a SHA-256, or one of the two groups. */
type FieldKind = 'int' | 'text' | 'text?' | 'sha' | 'ends' | 'counts';

const FIELD_KINDS: Readonly<Record<(typeof MANIFEST_FIELDS)[number], FieldKind>> = {
  schemaVersion: 'int',
  builderVersion: 'int',
  feedUrl: 'text',
  feedSha256: 'sha',
  feedEtag: 'text?',
  feedLastModified: 'text?',
  dbSha256: 'sha',
  dbBytes: 'int',
  sqliteVersion: 'text',
  serviceStartDate: 'int',
  serviceEnd: 'ends',
  counts: 'counts',
};

/** The first field that is missing or of the wrong type, or null for a complete manifest. */
function manifestProblem(parsed: unknown): string | null {
  invariant(Object.keys(FIELD_KINDS).length === MANIFEST_FIELDS.length, 'every field has a kind');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the manifest is not a JSON object';
  }
  const record = parsed as Record<string, unknown>;
  const bad = MANIFEST_FIELDS.find((field) => !(field in record) || !fieldFits(FIELD_KINDS[field], record[field]));
  invariant(bad === undefined || MANIFEST_FIELDS.includes(bad), 'a bad field is a manifest field');
  return bad === undefined ? null : `field ${bad} is ${bad in record ? `malformed (${JSON.stringify(record[bad])})` : 'missing'}`;
}

function fieldFits(kind: FieldKind, value: unknown): boolean {
  invariant(kind.length > 0, 'a field has a kind');
  let fits: boolean;
  switch (kind) {
    case 'int':
      fits = typeof value === 'number' && Number.isSafeInteger(value);
      break;
    case 'text':
      fits = typeof value === 'string' && value.length > 0;
      break;
    case 'text?':
      fits = value === null || (typeof value === 'string' && value.length > 0);
      break;
    case 'sha':
      fits = typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
      break;
    case 'ends':
      fits = isGroup(value, ['rail', 'mover']) && ['rail', 'mover'].every((mode) => wholeNumbers((value as Record<string, unknown>)[mode], ['date', 'epoch']));
      break;
    case 'counts':
      fits = wholeNumbers(value, ['stations', 'patterns', 'trips', 'stopTimes']);
      break;
  }
  invariant(typeof fits === 'boolean', 'every kind decides');
  return fits;
}

/** An object that has every one of `keys`. */
function isGroup(value: unknown, keys: readonly string[]): boolean {
  invariant(keys.length > 0, 'a group has keys');
  const group = typeof value === 'object' && value !== null && !Array.isArray(value) && keys.every((key) => key in value);
  invariant(!group || typeof value === 'object', 'a group is an object');
  return group;
}

/** An object whose `keys` are all whole numbers. */
function wholeNumbers(value: unknown, keys: readonly string[]): boolean {
  invariant(keys.length > 0, 'at least one number is required');
  const whole = isGroup(value, keys) && keys.every((key) => Number.isSafeInteger((value as Record<string, unknown>)[key]));
  invariant(!whole || isGroup(value, keys), 'whole numbers sit in a group');
  return whole;
}
