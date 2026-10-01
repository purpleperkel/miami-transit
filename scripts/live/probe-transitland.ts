import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { transit_realtime } from 'gtfs-realtime-bindings';

import { readRuntimeNetwork } from '../../src/data/live-network';
import { decodeFeedMessage } from '../../src/domain/gtfsrt/decode-feed';
import type { FeedEntity, FeedMessage } from '../../src/domain/gtfsrt/types';
import { linesOfRoute } from '../../src/domain/lines/line-catalog';
import { vehiclesFromFeed } from '../../src/domain/live/from-gtfsrt';
import { predictionsFromDepartures } from '../../src/domain/live/from-transitland-departures';
import { type LiveRequest, transitlandDeparturesRequest, transitlandVehiclesRequest } from '../../src/domain/live/transports';
import type { LiveNetwork } from '../../src/domain/live/types';
import { invariant } from '../../src/lib/invariant';
import { err, ok, type Result } from '../../src/lib/result';
import { REPO_PATHS } from '../gtfs/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import { NodeSqlExecutor } from '../lib/node-sql-executor';

/**
 * Plan M8.2a: the Transitland probe, run on the Mac during service hours with the real key
 * (falsifiers R5, R7, R8, R19). It drives the app's OWN realtime pipeline end to end:
 *
 *   transports.ts request builders → GET (key in the `apikey` header, never in a URL)
 *   → decode-feed.ts (our decoder), checked entity by entity against gtfs-realtime-bindings (R5)
 *   → from-gtfsrt.ts (vehicles) and from-transitland-departures.ts (Government Center 9512 / 9513)
 *
 * and prints ONE JSON line on stdout: status, railMover (R7), matchRate against schedule.db (R8),
 * feedAgeS, bytesPerPoll (R19), oracleMatch (R5) and each platform's departures {rows, realtime}.
 * Logs go to stderr. It exits 0 only when every acceptance value holds.
 *
 * Calls: the county feed's vehicle-positions download and the two departures requests — never the
 * whole-agency trip-updates download (1 MB a poll, §3 R19′). A 404 on the download means Transitland
 * has no message cached yet: retry every 60 s, up to 5 times. A 401 means the key was refused: stop
 * at once, no retry.
 *
 * PUBLIC-REPO DATA RULE (plan §3): each run saves its REAL captures to the gitignored .cache/live/
 * and nowhere else; they are never committed. The committed live fixtures are synthetic
 * (scripts/fixtures/make-live-fixtures.ts). A response that echoes the key is never saved.
 *
 *   node --env-file=.env --import tsx scripts/live/probe-transitland.ts
 */

/** Each run's real captures (gitignored; plan §3 PUBLIC-REPO DATA RULE). */
export const CAPTURE_DIR = '.cache/live';
export const VEHICLES_CAPTURE = 'vehicle_positions.pb';
/** Government Center rail: 9512 southbound, 9513 northbound (§3 live check). */
export const GOVERNMENT_CENTER_RAIL = ['9512', '9513'] as const;
/** A 404 on the download = no message cached yet: wait this long, then retry… */
export const NOT_CACHED_RETRY_MS = 60_000;
/** …at most this many times. */
export const NOT_CACHED_RETRIES = 5;
/** Plan M8.2a acceptance: trip_id match rate (R8) and feed age. */
export const MIN_MATCH_RATE = 0.8;
export const MAX_FEED_AGE_S = 180;

export type ProbeResponse = { readonly status: number; arrayBuffer(): Promise<ArrayBuffer> };
export type ProbeInit = { readonly method: 'GET'; readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal };
/** The global fetch on the Mac; a fake in the tests (which run with the network off). */
export type ProbeFetch = (url: string, init: ProbeInit) => Promise<ProbeResponse>;

export type ProbeDeps = {
  readonly key: string | null;
  readonly fetch: ProbeFetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
  /** Absolute directory each run's captures are written to. */
  readonly captureDir: string;
  readonly network: LiveNetwork;
};

/** One Government Center platform's departures: HTTP status, body size, rows, realtime rows (null = not reached). */
export type StopReport = { readonly status: number | null; readonly bytes: number | null; readonly rows: number | null; readonly realtime: number | null };

type FeedCensus = {
  readonly feedTimestamp: number | null;
  readonly feedAgeS: number | null;
  readonly vehicles: number | null;
  readonly railMover: number | null;
  readonly rail: number | null;
  readonly mover: number | null;
  readonly outOfScope: number | null;
  readonly matched: number | null;
  readonly keyed: number | null;
  readonly matchRate: number | null;
  readonly oracleMatch: boolean | null;
};

/** The probe's one stdout line. */
export type ProbeReport = FeedCensus & {
  /** HTTP status of the vehicle-positions download (its last attempt); null when no response came. */
  readonly status: number | null;
  readonly attempts: number;
  readonly bytesPerPoll: number | null;
  readonly departures: Readonly<Record<string, StopReport>>;
  /** Every acceptance value that does not hold, in words; empty when the probe passes. */
  readonly failures: readonly string[];
  readonly ok: boolean;
};

const NO_CENSUS: FeedCensus = Object.freeze({
  feedTimestamp: null,
  feedAgeS: null,
  vehicles: null,
  railMover: null,
  rail: null,
  mover: null,
  outOfScope: null,
  matched: null,
  keyed: null,
  matchRate: null,
  oracleMatch: null,
});

type Download = { readonly status: number | null; readonly body: Uint8Array | null; readonly attempts: number; readonly problem: string | null };
type Exchange = { readonly status: number; readonly body: Uint8Array };

/** The whole probe: the download, its census, both platforms' departures, and the verdict. */
export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  invariant(isAbsolute(deps.captureDir), 'captures go to an absolute directory');
  invariant(typeof deps.fetch === 'function' && typeof deps.sleep === 'function', 'the network and the clock are injected');
  const request = transitlandVehiclesRequest(deps.key);
  if (!request.ok) {
    return verdict({ ...NO_CENSUS, status: null, attempts: 0, bytesPerPoll: null, departures: {} }, [request.error.message]);
  }
  const download = await fetchFeedDownload(request.value, deps);
  const base = { status: download.status, attempts: download.attempts, bytesPerPoll: download.body?.length ?? null };
  if (download.body === null) {
    return verdict({ ...NO_CENSUS, ...base, departures: {} }, [download.problem ?? 'the vehicle-positions download returned no body']);
  }
  const problems: string[] = [];
  const saved = saveCapture(deps, VEHICLES_CAPTURE, download.body);
  if (!saved.ok) {
    problems.push(saved.error);
  }
  const census = feedCensus(download.body, deps);
  problems.push(...census.problems);
  const departures: Record<string, StopReport> = {};
  for (const stopId of GOVERNMENT_CENTER_RAIL) {
    const stop = await probeStop(stopId, deps);
    departures[stopId] = stop.report;
    problems.push(...stop.problems);
  }
  return verdict({ ...census.value, ...base, departures }, problems);
}

/**
 * GET the feed download; a 404 (no message cached yet) is retried every 60 s, up to 5 times. Any
 * other answer — a 401 above all — ends it at once.
 */
export async function fetchFeedDownload(request: LiveRequest, deps: ProbeDeps): Promise<Download> {
  invariant(request.body === 'protobuf', 'the download is GTFS-realtime protobuf');
  invariant(NOT_CACHED_RETRIES >= 0 && NOT_CACHED_RETRY_MS > 0, 'the retry policy is bounded');
  let answer = await fetchOnce(request, deps);
  let attempts = 1;
  while (answer.ok && answer.value.status === 404 && attempts <= NOT_CACHED_RETRIES) {
    deps.log(`probe: 404 = Transitland has no message cached yet; retry ${attempts} of ${NOT_CACHED_RETRIES} in ${NOT_CACHED_RETRY_MS / 1000} s`);
    await deps.sleep(NOT_CACHED_RETRY_MS);
    answer = await fetchOnce(request, deps);
    attempts += 1;
  }
  if (!answer.ok) {
    return { status: null, body: null, attempts, problem: answer.error };
  }
  const { status, body } = answer.value;
  const usable = status === 200 && body.length > 0;
  const download = usable ? { status, body, attempts, problem: null } : { status, body: null, attempts, problem: statusProblem(status, attempts) };
  invariant(attempts >= 1 && attempts <= NOT_CACHED_RETRIES + 1, 'one first try plus at most five retries');
  return download;
}

function statusProblem(status: number, attempts: number): string {
  invariant(Number.isInteger(status), 'an HTTP status is a whole number');
  invariant(attempts >= 1, 'a status came from an attempt');
  if (status === 200) {
    return 'HTTP 200 with an empty body from the vehicle-positions download';
  }
  if (status === 401) {
    return 'HTTP 401: Transitland refused the key — stopped at once, no retry (check TRANSITLAND_API_KEY in .env)';
  }
  if (status === 404) {
    return `HTTP 404 on all ${attempts} attempts: Transitland has no vehicle-positions message cached — re-run later`;
  }
  return `HTTP ${status} from the vehicle-positions download`;
}

/** One GET, key in the header only; the body read in full; a thrown fetch becomes an Err naming the endpoint. */
async function fetchOnce(request: LiveRequest, deps: ProbeDeps): Promise<Result<Exchange, string>> {
  const key = request.headers.apikey;
  invariant(key !== undefined && key.length > 0, 'the Transitland key travels in the apikey header');
  invariant(!request.url.includes(key), 'the key never travels in a URL');
  const endpoint = endpointOf(request.url);
  try {
    const response = await deps.fetch(request.url, { method: 'GET', headers: request.headers, signal: AbortSignal.timeout(request.timeoutMs) });
    const body = new Uint8Array(await response.arrayBuffer());
    deps.log(`probe: GET ${endpoint} → HTTP ${response.status}, ${body.length} bytes`);
    return ok({ status: response.status, body });
  } catch (error) {
    return err(`GET ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The endpoint's path after the REST root, for logs (a URL here never holds the key anyway). */
function endpointOf(url: string): string {
  invariant(url.startsWith('https://'), 'Transitland is called over https');
  const path = new URL(url).pathname.replace(/^\/api\/v2\/rest\//, '');
  invariant(path.length > 0, 'an endpoint has a path');
  return path;
}

/** Writes one capture under the capture directory — unless the body echoes the key, which is never saved. */
function saveCapture(deps: ProbeDeps, name: string, body: Uint8Array): Result<string, string> {
  invariant(/^[A-Za-z0-9_.-]+$/.test(name), 'a capture is a plain file name');
  invariant(body.length > 0, 'a capture has bytes');
  if (deps.key !== null && deps.key.trim() !== '' && Buffer.from(body).includes(Buffer.from(deps.key.trim(), 'utf8'))) {
    return err(`the ${name} response echoed the key — it was NOT saved`);
  }
  const path = join(deps.captureDir, name);
  writeFileAtomically(path, body);
  deps.log(`probe: saved ${body.length} bytes to ${name} in the capture directory`);
  return ok(path);
}

/** Our decoder against the oracle, then the app's vehicle mapper over the feed: the census and anything wrong. */
function feedCensus(bytes: Uint8Array, deps: ProbeDeps): { readonly value: FeedCensus; readonly problems: readonly string[] } {
  invariant(bytes.length > 0, 'a downloaded feed has bytes');
  const decoded = decodeFeedMessage(bytes);
  if (!decoded.ok) {
    return { value: { ...NO_CENSUS, oracleMatch: false }, problems: [`R5: our decoder rejects the live bytes: ${decoded.error.message}`] };
  }
  const feed = decoded.value;
  const disagreement = oracleDisagreement(bytes, feed);
  const header = feed.header.timestamp;
  const census: FeedCensus = {
    ...vehicleCounts(feed, deps.network),
    feedTimestamp: header,
    feedAgeS: header === null ? null : Math.round(deps.nowMs() / 1000 - header),
    oracleMatch: disagreement === null,
  };
  const problems = disagreement === null ? [] : [`R5: our decoder disagrees with gtfs-realtime-bindings: ${disagreement}`];
  invariant(census.vehicles !== null && census.vehicles <= feed.entity.length, 'every vehicle is an entity');
  return { value: census, problems };
}

type VehicleCounts = Pick<FeedCensus, 'vehicles' | 'railMover' | 'rail' | 'mover' | 'outOfScope' | 'matched' | 'keyed' | 'matchRate'>;

/**
 * railMover = the vehicles the app's mapper keeps (R7). matchRate (R8) = of the vehicles whose route
 * is rail or Mover and that report a trip_id, the share whose trip_id schedule.db knows.
 */
function vehicleCounts(feed: FeedMessage, network: LiveNetwork): VehicleCounts {
  invariant(typeof network.lineOfTrip === 'function', 'the schedule trip lookup is injected');
  const mapped = vehiclesFromFeed(feed, network);
  let vehicles = 0;
  let keyed = 0;
  let matched = 0;
  for (const entity of feed.entity) {
    const trip = entity.vehicle?.trip ?? null;
    vehicles += entity.vehicle === null ? 0 : 1;
    if (trip !== null && linesOfRoute(trip.routeId ?? '').length > 0 && (trip.tripId ?? '') !== '') {
      keyed += 1;
      matched += network.lineOfTrip(trip.tripId ?? '') === null ? 0 : 1;
    }
  }
  const railMover = mapped.items.length;
  invariant(railMover <= vehicles && matched <= keyed, 'the counts nest');
  return {
    vehicles,
    railMover,
    rail: mapped.items.filter((v) => v.mode === 'rail').length,
    mover: mapped.items.filter((v) => v.mode === 'mover').length,
    outOfScope: mapped.dropped['out-of-scope'] ?? 0,
    matched,
    keyed,
    matchRate: keyed === 0 ? null : Math.round((matched / keyed) * 1000) / 1000,
  };
}

type OracleTrip = { tripId?: string; routeId?: string; directionId?: number; startTime?: string; startDate?: string; scheduleRelationship?: number };
type OracleVehicle = {
  trip?: OracleTrip;
  vehicle?: { id?: string; label?: string; licensePlate?: string };
  position?: { latitude?: number; longitude?: number; bearing?: number; speed?: number };
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: number;
  timestamp?: number;
};
type OracleFeed = {
  header?: { gtfsRealtimeVersion?: string; incrementality?: number; timestamp?: number };
  entity?: { id?: string; isDeleted?: boolean; tripUpdate?: object; vehicle?: OracleVehicle }[];
};

/** R5: every field our decoder models, entity by entity, against the reference bindings; null = identical. */
export function oracleDisagreement(bytes: Uint8Array, ours: FeedMessage): string | null {
  invariant(bytes.length > 0, 'the oracle reads bytes');
  const oracle = oracleRead(bytes);
  if (!oracle.ok) {
    return oracle.error;
  }
  const theirs = oracle.value.entity ?? [];
  const head = oracle.value.header;
  const ourHead = JSON.stringify([ours.header.gtfsRealtimeVersion, ours.header.incrementality, ours.header.timestamp]);
  const theirHead = JSON.stringify([head?.gtfsRealtimeVersion ?? null, head?.incrementality ?? null, head?.timestamp ?? null]);
  if (ourHead !== theirHead) {
    return `header: ours ${ourHead} vs oracle ${theirHead}`;
  }
  if (theirs.length !== ours.entity.length) {
    return `entity count: ours ${ours.entity.length}, oracle ${theirs.length}`;
  }
  const a = ours.entity.map((entity) => JSON.stringify(ourFacts(entity)));
  const b = theirs.map((entity) => JSON.stringify(oracleFacts(entity)));
  const at = a.findIndex((facts, i) => facts !== b[i]);
  invariant(a.length === b.length, 'both decoders listed the same number of entities');
  return at < 0 ? null : `entity #${at}: ours ${a[at]} vs oracle ${b[at]}`;
}

function oracleRead(bytes: Uint8Array): Result<OracleFeed, string> {
  invariant(bytes instanceof Uint8Array, 'the oracle decodes bytes');
  try {
    const feed = transit_realtime.FeedMessage.toObject(transit_realtime.FeedMessage.decode(bytes), { longs: Number }) as OracleFeed;
    invariant(typeof feed === 'object' && feed !== null, 'the oracle returns a message object');
    return ok(feed);
  } catch (error) {
    return err(`the oracle cannot decode the bytes: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ourFacts(entity: FeedEntity): unknown[] {
  invariant(entity.id.length > 0, 'an entity has an id');
  const v = entity.vehicle;
  const facts = [entity.id, entity.isDeleted, entity.tripUpdate !== null, v !== null, v?.trip?.tripId ?? null, v?.trip?.routeId ?? null,
    v?.trip?.directionId ?? null, v?.trip?.startTime ?? null, v?.trip?.startDate ?? null, v?.trip?.scheduleRelationship ?? null,
    v?.vehicle?.id ?? null, v?.vehicle?.label ?? null, v?.vehicle?.licensePlate ?? null, v?.position?.latitude ?? null,
    v?.position?.longitude ?? null, v?.position?.bearing ?? null, v?.position?.speed ?? null, v?.currentStopSequence ?? null,
    v?.stopId ?? null, v?.currentStatus ?? null, v?.timestamp ?? null];
  invariant(facts.length === 21, 'every modelled field is compared');
  return facts;
}

function oracleFacts(entity: NonNullable<OracleFeed['entity']>[number]): unknown[] {
  invariant(typeof entity === 'object' && entity !== null, 'an oracle entity is an object');
  const v = entity.vehicle;
  const facts = [entity.id ?? null, entity.isDeleted ?? null, entity.tripUpdate !== undefined, v !== undefined, v?.trip?.tripId ?? null,
    v?.trip?.routeId ?? null, v?.trip?.directionId ?? null, v?.trip?.startTime ?? null, v?.trip?.startDate ?? null,
    v?.trip?.scheduleRelationship ?? null, v?.vehicle?.id ?? null, v?.vehicle?.label ?? null, v?.vehicle?.licensePlate ?? null,
    v?.position?.latitude ?? null, v?.position?.longitude ?? null, v?.position?.bearing ?? null, v?.position?.speed ?? null,
    v?.currentStopSequence ?? null, v?.stopId ?? null, v?.currentStatus ?? null, v?.timestamp ?? null];
  invariant(facts.length === 21, 'every modelled field is compared');
  return facts;
}

type StopProbe = { readonly report: StopReport; readonly problems: readonly string[] };

/** One platform's departures through the app's departures mapper: rows, realtime rows, and anything wrong. */
async function probeStop(stopId: string, deps: ProbeDeps): Promise<StopProbe> {
  const request = transitlandDeparturesRequest(deps.key, stopId);
  invariant(request.ok, 'the key that built the vehicles request builds this one');
  const answer = await fetchOnce(request.value, deps);
  if (!answer.ok) {
    return { report: { status: null, bytes: null, rows: null, realtime: null }, problems: [answer.error] };
  }
  const { status, body } = answer.value;
  if (status !== 200 || body.length === 0) {
    return unreadStop(stopId, status, body, status === 200 ? 'HTTP 200 with an empty body' : `HTTP ${status}`);
  }
  const saved = saveCapture(deps, `departures-${stopId}.json`, body);
  const json = parseJson(body);
  if (!json.ok) {
    return unreadStop(stopId, status, body, json.error);
  }
  const mapped = predictionsFromDepartures(json.value, deps.network);
  if (!mapped.ok) {
    return unreadStop(stopId, status, body, mapped.error.message);
  }
  const rows = departureRowCount(json.value);
  const realtime = mapped.value.items.filter((p) => p.realtime && p.stopId === stopId).length;
  invariant(realtime <= rows, 'realtime rows are rows of the response');
  const problems = [...(saved.ok ? [] : [saved.error]), ...(realtime >= 1 ? [] : [`departures ${stopId}: no realtime row among ${rows}`])];
  return { report: { status, bytes: body.length, rows, realtime }, problems };
}

/** A platform whose answer could not be counted: what came back, and why. */
function unreadStop(stopId: string, status: number, body: Uint8Array, why: string): StopProbe {
  invariant(stopId.length > 0 && why.length > 0, 'a failed platform is named and explained');
  const probe: StopProbe = { report: { status, bytes: body.length, rows: null, realtime: null }, problems: [`departures ${stopId}: ${why}`] };
  invariant(probe.problems.length === 1, 'exactly one problem is reported');
  return probe;
}

function parseJson(body: Uint8Array): Result<unknown, string> {
  invariant(body.length > 0, 'a JSON body has bytes');
  try {
    const value: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    invariant(value !== undefined, 'JSON.parse returns a value');
    return ok(value);
  } catch (error) {
    return err(`the body is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every row of a `{ stops: [{ departures: [...] }] }` response. */
function departureRowCount(json: unknown): number {
  const stops = typeof json === 'object' && json !== null ? (json as { stops?: unknown }).stops : undefined;
  invariant(stops === undefined || stops !== null, 'stops is an array when present');
  let rows = 0;
  for (const stop of Array.isArray(stops) ? stops : []) {
    const departures = typeof stop === 'object' && stop !== null ? (stop as { departures?: unknown }).departures : undefined;
    rows += Array.isArray(departures) ? departures.length : 0;
  }
  invariant(Number.isSafeInteger(rows) && rows >= 0, 'a row count is a whole number');
  return rows;
}

type ReportBody = Omit<ProbeReport, 'failures' | 'ok'>;

/** The acceptance values of plan M8.2a against the measurements; the report says which do not hold. */
function verdict(body: ReportBody, problems: readonly string[]): ProbeReport {
  invariant(Number.isSafeInteger(body.attempts) && body.attempts >= 0, 'attempts is a whole number');
  const checks: (readonly [holds: boolean, why: string])[] = [
    [body.status === 200, `status ${body.status} (want 200)`],
    [body.railMover !== null && body.railMover > 0, `railMover ${body.railMover} (want > 0; R7)`],
    [body.matchRate !== null && body.matchRate >= MIN_MATCH_RATE, `matchRate ${body.matchRate} (want >= ${MIN_MATCH_RATE}; R8)`],
    [body.feedAgeS !== null && body.feedAgeS <= MAX_FEED_AGE_S, `feedAgeS ${body.feedAgeS} (want <= ${MAX_FEED_AGE_S})`],
    [body.oracleMatch === true, `oracleMatch ${body.oracleMatch} (want true; R5)`],
  ];
  for (const stopId of GOVERNMENT_CENTER_RAIL) {
    const stop = body.departures[stopId];
    checks.push([stop !== undefined && stop.realtime !== null && stop.realtime >= 1, `departures ${stopId}: ${JSON.stringify(stop ?? null)} (want >= 1 realtime row)`]);
  }
  const unique = [...new Set([...problems, ...checks.filter(([holds]) => !holds).map(([, why]) => why)])];
  const report: ProbeReport = { ...body, failures: unique, ok: unique.length === 0 };
  invariant(report.ok === (report.failures.length === 0), 'the probe passes exactly when nothing failed');
  return report;
}

async function main(): Promise<number> {
  const root = process.cwd();
  invariant(existsSync(join(root, 'package.json')) && existsSync(join(root, REPO_PATHS.scheduleDb)), 'run the probe from the repo root');
  const opened = NodeSqlExecutor.open(join(root, REPO_PATHS.scheduleDb), 'read-only');
  if (!opened.ok) {
    console.error(`probe: cannot open the schedule DB: ${opened.error.message}`);
    return 1;
  }
  const db = opened.value;
  try {
    const report = await runProbe({
      key: process.env.TRANSITLAND_API_KEY ?? null,
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      nowMs: () => Date.now(),
      log: (line) => console.error(line),
      captureDir: join(root, CAPTURE_DIR),
      network: readRuntimeNetwork(db),
    });
    for (const failure of report.failures) {
      console.error(`probe: FAIL ${failure}`);
    }
    console.log(JSON.stringify(report));
    invariant(report.ok === (report.failures.length === 0), 'the exit code follows the failures');
    return report.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // A broken invariant is a crash, not an outcome: rethrow so Node prints it and exits non-zero.
      throw error;
    },
  );
}
