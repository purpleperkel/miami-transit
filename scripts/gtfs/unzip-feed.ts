import { unzipSync } from 'fflate';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';

/**
 * Step 3 of the GTFS pipeline (plan §4): unzip the feed with fflate, keeping only the files the
 * pipeline reads (the 47 MB stop_times.txt is the one big entry; nothing else is inflated).
 *
 * The 7 REQUIRED files (arbiter ruling, plan §4 step 3) must all be present — a missing one is an
 * Err naming it. The OPTIONAL files are carried through when present and absent otherwise:
 *  - calendar_dates.txt — absent reads as no exceptions; the county feed has it (the Labor Day swap).
 *  - feed_info.txt — loaded when present; the county feed has none.
 *  - frequencies.txt — read only to assert it is empty (plan §4 step 5); the county feed has none.
 */

export const REQUIRED_FEED_FILES = [
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'stops.txt',
  'calendar.txt',
  'shapes.txt',
] as const;
export const OPTIONAL_FEED_FILES = ['calendar_dates.txt', 'feed_info.txt', 'frequencies.txt'] as const;

export type RequiredFeedFile = (typeof REQUIRED_FEED_FILES)[number];
export type OptionalFeedFile = (typeof OPTIONAL_FEED_FILES)[number];
export type FeedFileName = RequiredFeedFile | OptionalFeedFile;

/** Raw bytes of each extracted file: every required file, and the optional ones the zip had. */
export type FeedFiles = { readonly [F in RequiredFeedFile]: Uint8Array } & {
  readonly [F in OptionalFeedFile]?: Uint8Array;
};

export type UnzipError =
  | { readonly kind: 'corrupt-zip'; readonly message: string }
  | { readonly kind: 'missing-file'; readonly file: RequiredFeedFile; readonly message: string };

const WANTED: ReadonlySet<string> = new Set<string>([...REQUIRED_FEED_FILES, ...OPTIONAL_FEED_FILES]);

export function unzipFeed(zip: Uint8Array): Result<FeedFiles, UnzipError> {
  invariant(zip instanceof Uint8Array, 'unzipFeed reads raw zip bytes');
  invariant(WANTED.size === REQUIRED_FEED_FILES.length + OPTIONAL_FEED_FILES.length, 'no file is both required and optional');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter: (file) => WANTED.has(file.name) });
  } catch (error) {
    if (!isCorruptZipError(error)) {
      throw error;
    }
    return err({ kind: 'corrupt-zip', message: `the feed zip cannot be read: ${error.message}` });
  }
  const missing = REQUIRED_FEED_FILES.find((name) => entries[name] === undefined);
  if (missing !== undefined) {
    return err({ kind: 'missing-file', file: missing, message: `the feed zip has no ${missing}` });
  }
  const files = entries as FeedFiles;
  invariant(REQUIRED_FEED_FILES.every((name) => files[name] instanceof Uint8Array), 'every required file was extracted');
  return ok(files);
}

/**
 * fflate reports bad data as an Error carrying a numeric `code` (its FlateError); a corrupt size
 * field can also surface as a RangeError when a typed array is allocated. Anything else is a bug.
 */
function isCorruptZipError(error: unknown): error is Error {
  const flate = error instanceof Error && typeof (error as { code?: unknown }).code === 'number';
  const corrupt = flate || error instanceof RangeError;
  invariant(!corrupt || error instanceof Error, 'a corrupt-zip error is an Error');
  invariant(!corrupt || (error as Error).message.length > 0, 'a corrupt-zip error explains itself');
  return corrupt;
}
