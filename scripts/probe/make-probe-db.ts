import { existsSync, mkdirSync } from 'node:fs';

import { invariant } from '../../src/lib/invariant';
import { buildProbeDb, PROBE_DB_FILE, PROBE_MANIFEST_FILE, PROBE_ROWS } from './probe-db';

/**
 * M1.14: writes assets/db/probe.db (with node:sqlite) and assets/db/probe-manifest.json.
 * Safe to rerun: both files are replaced atomically and come out byte-identical. From the repo root:
 *   npx tsx scripts/probe/make-probe-db.ts
 */
const OUTPUT_DIR = 'assets/db';

function main(): number {
  invariant(existsSync('package.json') && existsSync('src'), 'run the generator from the repo root');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifest = buildProbeDb(OUTPUT_DIR);
  invariant(manifest.rows === PROBE_ROWS, `the probe DB holds ${PROBE_ROWS} rows`);
  console.log(
    `wrote ${OUTPUT_DIR}/${PROBE_DB_FILE} (${manifest.rows} rows in ${manifest.table}, ${manifest.dbBytes} bytes, ` +
      `sha256 ${manifest.dbSha256.slice(0, 12)}…) and ${OUTPUT_DIR}/${PROBE_MANIFEST_FILE}`,
  );
  return 0;
}

process.exitCode = main();
