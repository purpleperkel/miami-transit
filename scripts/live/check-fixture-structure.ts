import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { transit_realtime } from 'gtfs-realtime-bindings';

import { SYNTHETIC_DEPARTURES } from '../../src/domain/live/__fixtures__/synthetic-departures';
import { SYNTHETIC_VEHICLE_POSITIONS_BYTES } from '../../src/domain/live/__fixtures__/synthetic-vehicle-positions';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { CAPTURE_DIR, GOVERNMENT_CENTER_RAIL, VEHICLES_CAPTURE } from './probe-transitland';

/**
 * Plan M8.3 under the §3 PUBLIC-REPO DATA RULE: do the committed SYNTHETIC live fixtures have the
 * structure of the REAL captures the probe saved to the gitignored capture directory?
 *
 *   vehicle_positions.pb  every field path present ("entity[].vehicle.trip.tripId") and every enum
 *                         value used ("entity[].vehicle.currentStatus=STOPPED_AT"), as the reference
 *                         bindings spell them (protobufjs toObject, camelCase);
 *   departures-<stop>.json (9512 and 9513 together)  every key path ("stops[].departures[].trip.route")
 *                         and every schedule_relationship value used.
 *
 * Each must occur in the synthetic fixtures; the synthetic may hold more. It reads local files only
 * (no key, no network) and prints ONE stdout line, `{"conformant":bool,"missing":[…]}`, exiting 0
 * only when conformant. A field or enum value new to the live feed shows up here first: extend
 * scripts/fixtures/make-live-fixtures.ts and regenerate.
 *
 *   node --import tsx scripts/live/check-fixture-structure.ts [--captures <dir>]
 */

/** The documents compared: one VehiclePositions message and the departures responses. */
export type StructureInput = { readonly vehiclePositions: Uint8Array; readonly departures: readonly unknown[] };
export type StructureVerdict = { readonly conformant: boolean; readonly missing: readonly string[] };

/** A structure walk visits at most this many nodes (the real feed has ~10,000). */
const MAX_NODES = 5_000_000;
const ENUM_KEY = /(^|\.)schedule_relationship$/;

/**
 * Every path in `a` (arrays as "[]") and every enum value ("<path>=<VALUE>"). `b` is the same
 * document with enums as numbers (protobuf) — a leaf that is a string in `a` and a number in `b` is an
 * enum — or `a` itself (JSON), where `isEnumPath` names the enum keys. Iterative: no recursion.
 */
function shapeOf(a0: unknown, b0: unknown, isEnumPath: (path: string) => boolean): Set<string> {
  invariant(typeof isEnumPath === 'function', 'the enum rule is given');
  const out = new Set<string>();
  const stack: [unknown, unknown, string][] = [[a0, b0, '']];
  for (let steps = 0; stack.length > 0; steps++) {
    invariant(steps < MAX_NODES, 'the structure walk is bounded');
    const [a, b, path] = stack.pop() as [unknown, unknown, string];
    if (path !== '') {
      out.add(path);
    }
    if (Array.isArray(a)) {
      a.forEach((item, i) => stack.push([item, Array.isArray(b) ? b[i] : undefined, `${path}[]`]));
    } else if (a !== null && typeof a === 'object') {
      const other = b !== null && typeof b === 'object' ? (b as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(a)) {
        stack.push([value, other[key], path === '' ? key : `${path}.${key}`]);
      }
    } else if ((typeof a === 'string' && typeof b === 'number') || (isEnumPath(path) && (typeof a === 'string' || typeof a === 'number'))) {
      out.add(`${path}=${String(a)}`);
    }
  }
  return out;
}

/** The field paths and enum values of a GTFS-realtime FeedMessage, as the reference bindings read it. */
export function protobufStructure(bytes: Uint8Array): Set<string> {
  invariant(bytes.length > 0, 'a feed has bytes');
  const message = transit_realtime.FeedMessage.decode(bytes);
  const named = transit_realtime.FeedMessage.toObject(message, { enums: String, longs: Number });
  const numbered = transit_realtime.FeedMessage.toObject(message, { longs: Number });
  const shape = shapeOf(named, numbered, () => false);
  invariant(shape.has('header'), 'every FeedMessage has a header');
  return shape;
}

/** The key paths and schedule_relationship values of a departures response. */
export function jsonStructure(body: unknown): Set<string> {
  invariant(body !== undefined, 'a JSON document is given');
  const shape = shapeOf(body, body, (path) => ENUM_KEY.test(path));
  invariant([...shape].every((path) => path.length > 0), 'every path is named');
  return shape;
}

/** The union of several departures responses' structures (the two platforms are compared together). */
function departuresStructure(bodies: readonly unknown[]): Set<string> {
  invariant(bodies.length > 0, 'at least one response');
  const shape = new Set(bodies.flatMap((body) => [...jsonStructure(body)]));
  invariant(shape.size > 0, 'a response has keys');
  return shape;
}

/** What of the real structure the synthetic lacks ("vehicle_positions …" / "departures …"), sorted. */
export function structureGaps(real: StructureInput, synthetic: StructureInput): StructureVerdict {
  invariant(real.departures.length > 0 && synthetic.departures.length > 0, 'departures responses are compared');
  const synVp = protobufStructure(synthetic.vehiclePositions);
  const synDep = departuresStructure(synthetic.departures);
  const missing = [
    ...[...protobufStructure(real.vehiclePositions)].filter((path) => !synVp.has(path)).map((path) => `vehicle_positions ${path}`),
    ...[...departuresStructure(real.departures)].filter((path) => !synDep.has(path)).map((path) => `departures ${path}`),
  ].sort();
  const verdict = { conformant: missing.length === 0, missing };
  invariant(verdict.conformant === (verdict.missing.length === 0), 'conformant exactly when nothing is missing');
  return verdict;
}

/** The committed synthetic fixtures, as structure input. */
export function syntheticInput(): StructureInput {
  const departures = GOVERNMENT_CENTER_RAIL.map((stopId) => SYNTHETIC_DEPARTURES[stopId]);
  invariant(SYNTHETIC_VEHICLE_POSITIONS_BYTES.length > 0, 'the synthetic feed has bytes');
  invariant(departures.every((body) => body !== undefined), 'a synthetic response per Government Center platform');
  return { vehiclePositions: SYNTHETIC_VEHICLE_POSITIONS_BYTES, departures };
}

/** The real captures in `dir` (the probe's last run), or why they cannot be read. */
export function readCaptures(dir: string): Result<StructureInput, string> {
  invariant(dir.length > 0, 'a capture directory is named');
  const files = [VEHICLES_CAPTURE, ...GOVERNMENT_CENTER_RAIL.map((stopId) => `departures-${stopId}.json`)].map((name) => join(dir, name));
  const absent = files.filter((file) => !existsSync(file));
  if (absent.length > 0) {
    return err(`no capture at ${absent.join(', ')} — run scripts/live/probe-transitland.ts first (service hours, real key)`);
  }
  try {
    const departures: unknown[] = files.slice(1).map((file) => JSON.parse(readFileSync(file, 'utf8')) as unknown);
    const vehiclePositions = new Uint8Array(readFileSync(files[0] as string));
    // Decoded here so bytes that are no FeedMessage fail as a read error, not mid-comparison.
    const decoded = transit_realtime.FeedMessage.decode(vehiclePositions);
    invariant(Array.isArray(decoded.entity), 'the vehicles capture is a FeedMessage');
    invariant(departures.length === GOVERNMENT_CENTER_RAIL.length, 'one response per platform');
    return ok({ vehiclePositions, departures });
  } catch (error) {
    return err(`a capture cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The CLI's verdict on the captures in `dir` against the committed synthetic fixtures. */
export function checkCaptures(dir: string): StructureVerdict & { readonly error?: string } {
  invariant(dir.length > 0, 'a capture directory is named');
  const real = readCaptures(dir);
  const verdict = real.ok ? structureGaps(real.value, syntheticInput()) : { conformant: false, missing: [], error: real.error };
  invariant(!verdict.conformant || verdict.missing.length === 0, 'a conformant verdict misses nothing');
  return verdict;
}

function main(argv: readonly string[]): number {
  invariant(existsSync('package.json'), 'run the checker from the repo root');
  const at = argv.indexOf('--captures');
  const dir = at >= 0 ? argv[at + 1] : CAPTURE_DIR;
  invariant(dir !== undefined && dir.length > 0, 'usage: check-fixture-structure.ts [--captures <dir>]');
  const verdict = checkCaptures(dir);
  console.log(JSON.stringify(verdict));
  return verdict.conformant ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
