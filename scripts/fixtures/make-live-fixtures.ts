import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ScheduleRepo } from '../../src/data/schedule-repo';
import { invariant } from '../../src/lib/invariant';
import { REPO_PATHS } from '../gtfs/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import { NodeSqlExecutor } from '../lib/node-sql-executor';
import { buildDepartures } from './live/departures';
import { SeededRandom } from './live/prng';
import { renderDeparturesFixture, renderVehicleFixture } from './live/render';
import { fixtureDay } from './live/schedule-facts';
import { buildVehicleFeed } from './live/vehicles';

/**
 * Generates the SYNTHETIC live fixtures (plan M8.3 under the §3 PUBLIC-REPO DATA RULE) from the
 * county's public static GTFS ALONE — assets/db/schedule.db, read-only — never from a capture:
 *
 *   src/domain/live/__fixtures__/synthetic-vehicle-positions.ts  SYNTHETIC_VEHICLE_POSITIONS_BYTES:
 *     a whole-agency GTFS-realtime VehiclePositions feed (rail and Mover on real trips, on their
 *     shapes; buses on synthetic routes; vehicles on no trip), encoded by the reference bindings and
 *     checked against our decoder;
 *   src/domain/live/__fixtures__/synthetic-departures.ts  SYNTHETIC_DEPARTURES: Transitland
 *     departures responses for Government Center rail 9512 and 9513, on real trips serving them.
 *
 * Deterministic: a fixed instant (Wednesday 2026-09-30, 08:15 New York — in the past, so no live
 * capture can share its dates), seeded randomness, no clock, no time zone, no network. A rerun
 * rewrites both files byte for byte; after a schedule.db refresh, rerun it and commit the result.
 *
 *   node --import tsx scripts/fixtures/make-live-fixtures.ts   (then git add both fixtures)
 */

const FIXTURE_DIR = 'src/domain/live/__fixtures__';
export const FIXTURE_FILES = {
  vehicles: `${FIXTURE_DIR}/synthetic-vehicle-positions.ts`,
  departures: `${FIXTURE_DIR}/synthetic-departures.ts`,
} as const;

/** The fixture instant: service day 2026-09-30 at 08:15 local, a weekday morning. */
const FIXTURE_SERVICE_DATE = 20_260_930;
const FIXTURE_LOCAL_S = 8 * 3_600 + 15 * 60;
/** One seeded sequence per fixture, so a change to one never shifts the other. */
const VEHICLE_SEED = 0x5f_76_70_31;
const DEPARTURES_SEED = 0x5f_64_70_31;

function writeFixture(root: string, path: string, text: string): void {
  invariant(path.startsWith(`${FIXTURE_DIR}/synthetic-`) && path.endsWith('.ts'), 'the generator writes only its synthetic fixtures');
  const absolute = join(root, path);
  writeFileAtomically(absolute, text);
  invariant(statSync(absolute).size === Buffer.byteLength(text, 'utf8'), `${path} was written in full`);
  console.log(`wrote ${path} (${Buffer.byteLength(text, 'utf8')} bytes)`);
}

function main(): number {
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, REPO_PATHS.scheduleDb)), 'run the generator from the repo root, beside assets/db/schedule.db');
  const opened = NodeSqlExecutor.open(join(root, REPO_PATHS.scheduleDb), 'read-only');
  invariant(opened.ok, `schedule.db opens read-only: ${opened.ok ? '' : opened.error.message}`);
  const db = opened.value;
  try {
    const repo = ScheduleRepo.open(db);
    invariant(repo.ok, `schedule.db is a schedule this engine reads: ${repo.ok ? '' : repo.error.message}`);
    const day = fixtureDay(db, FIXTURE_SERVICE_DATE);
    const feedEpoch = day.baseEpoch + FIXTURE_LOCAL_S;
    const vehicles = buildVehicleFeed({ db, repo: repo.value, rng: new SeededRandom(VEHICLE_SEED), day, feedEpoch });
    const departures = buildDepartures({ db, repo: repo.value, rng: new SeededRandom(DEPARTURES_SEED), day, feedEpoch });
    writeFixture(root, FIXTURE_FILES.vehicles, renderVehicleFixture(vehicles, day, feedEpoch));
    writeFixture(root, FIXTURE_FILES.departures, renderDeparturesFixture(departures, day, feedEpoch));
  } finally {
    db.close();
  }
  return 0;
}

process.exitCode = main();
