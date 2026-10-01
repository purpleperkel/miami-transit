import { CsvError as CsvSyntaxError, parse } from 'csv-parse/sync';

import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';

/**
 * The tolerant GTFS CSV reader (plan §4 step 4), built on csv-parse. It takes the county feed as it
 * really is: CRLF line endings, a space before unpadded times (" 5:32:00"), and possibly a UTF-8
 * BOM. Quoted fields keep their embedded commas and inner spaces.
 *
 * Callers declare the columns they read. A missing REQUIRED column is an Err naming the file and
 * the column; an absent OPTIONAL column reads as ''. Each record carries its 1-based source line
 * so later checks can point at it. An optional `keep` filter drops rows (out-of-scope trips, say)
 * as they stream past, so a 47 MB stop_times.txt never sits in memory as a million objects.
 */

export type CsvError =
  | { readonly kind: 'missing-column'; readonly file: string; readonly column: string; readonly message: string }
  | { readonly kind: 'malformed'; readonly file: string; readonly line: number | null; readonly message: string }
  | { readonly kind: 'encoding'; readonly file: string; readonly message: string };

export type CsvColumns<R extends string, O extends string> = {
  readonly required: readonly R[];
  readonly optional?: readonly O[];
};

export type CsvFields<C extends string> = Readonly<Record<C, string>>;
export type CsvRecord<C extends string> = { readonly line: number; readonly fields: CsvFields<C> };
export type KeepRow<C extends string> = (fields: CsvFields<C>) => boolean;

/** Fatal: a byte sequence that is not UTF-8 is an Err, never silently replaced by U+FFFD. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function parseCsv<R extends string, O extends string = never>(
  file: string,
  input: string | Uint8Array,
  columns: CsvColumns<R, O>,
  keep?: KeepRow<R | O>,
): Result<CsvRecord<R | O>[], CsvError> {
  invariant(file.length > 0, 'parseCsv names the file it reads (errors cite it)');
  invariant(columns.required.length > 0, 'parseCsv reads at least one required column');
  const text = decodeText(file, input);
  if (!text.ok) {
    return text;
  }
  const wanted: readonly (R | O)[] = [...columns.required, ...(columns.optional ?? [])];
  // Until a header line proves otherwise, the first required column is missing: csv-parse never
  // calls `columns` for an input with no header line at all (an empty file).
  let missing: R | undefined = columns.required[0];
  let records: CsvRecord<R | O>[];
  try {
    records = parse<CsvRecord<R | O>, Record<string, string>>(text.value, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      columns: (header: string[]) => {
        missing = columns.required.find((column) => !header.includes(column));
        return header;
      },
      on_record: (row, context) => (missing === undefined ? keptRecord(row, context.lines, wanted, keep) : null),
    });
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      return err(malformed(file, error));
    }
    throw error;
  }
  if (missing !== undefined) {
    return err({ kind: 'missing-column', file, column: missing, message: `${file} is missing column ${missing}` });
  }
  invariant(records.every((record) => record.line >= 2), 'data records start after the header line');
  return ok(records);
}

function decodeText(file: string, input: string | Uint8Array): Result<string, CsvError> {
  invariant(file.length > 0, 'decodeText names the file it decodes');
  if (typeof input === 'string') {
    return ok(input);
  }
  invariant(input instanceof Uint8Array, 'non-string input is raw bytes');
  try {
    return ok(UTF8.decode(input));
  } catch (error) {
    return err({ kind: 'encoding', file, message: `${file} is not valid UTF-8: ${String(error)}` });
  }
}

/** The declared columns of one row (absent optional columns read ''), or null when `keep` drops it. */
function keptRecord<C extends string>(
  row: Readonly<Record<string, string>>,
  line: number,
  wanted: readonly C[],
  keep: KeepRow<C> | undefined,
): CsvRecord<C> | null {
  invariant(Number.isInteger(line) && line >= 1, 'csv-parse reports 1-based line numbers');
  const fields = {} as Record<C, string>;
  for (const column of wanted) {
    fields[column] = row[column] ?? '';
  }
  invariant(Object.keys(fields).length === new Set(wanted).size, 'a record holds exactly the declared columns');
  return keep === undefined || keep(fields) ? { line, fields } : null;
}

function malformed(file: string, error: CsvSyntaxError): CsvError {
  invariant(file.length > 0, 'a malformed-CSV error names the file');
  const line = typeof error.lines === 'number' ? error.lines : null;
  const where = line === null ? file : `${file} line ${line}`;
  const result: CsvError = { kind: 'malformed', file, line, message: `${where}: ${error.message} (${error.code})` };
  invariant(result.message.startsWith(file), 'the message leads with the file');
  return result;
}
