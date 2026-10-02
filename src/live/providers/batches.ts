import type { RuntimeNetwork } from '../../data/live-network';
import { decodeFeedMessage } from '../../domain/gtfsrt/decode-feed';
import { decodeUtf8 } from '../../domain/gtfsrt/utf8';
import { countDrop, type Drops } from '../../domain/live/drops';
import { predictionsFromFeed, vehiclesFromFeed } from '../../domain/live/from-gtfsrt';
import { predictionsFromDepartures } from '../../domain/live/from-transitland-departures';
import type { LiveRequest } from '../../domain/live/transports';
import type { DropReason, LiveBatch, LiveError, LiveNetwork, LivePrediction, LiveVehicle, MappedFeed, ProviderId } from '../../domain/live/types';
import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import type { HttpBody } from '../http';
import type { LiveKeys } from '../keys';

/**
 * What both realtime providers share (M4.9): the dependencies the runtime hands them, and the step
 * from a response body to a typed LiveBatch — GTFS-realtime protobuf through our own decoder and
 * the M4.2 mapper, Transitland departures JSON through the M4.3b mapper. A body that does not decode
 * is a `decode` LiveError, never a throw.
 */

export type ProviderDeps = {
  /** Performs one request: http.ts httpGet over the runtime's fetch, byte counter and clock. */
  readonly get: (request: LiveRequest, signal: AbortSignal) => Promise<Result<HttpBody, LiveError>>;
  /** The credentials in effect now (read from the Keychain by the runtime). */
  readonly keys: () => LiveKeys;
  readonly network: RuntimeNetwork;
  /** Records one REST call against the provider's monthly quota (quota.ts). */
  readonly recordCall: (provider: ProviderId) => void;
  /**
   * A clock in milliseconds that never runs backwards and ignores wall-clock corrections while the app
   * is open: the runtime's floor clock (floor-clock.ts), performance.now() plus the phone's sleep while
   * the app was away. Swiftly's 30 s floor is measured on it (providers/swiftly.ts).
   */
  readonly monotonicMs: () => number;
};

/** A vehicle-positions body as a batch of in-scope vehicles. */
export function vehiclesBatch(body: HttpBody, network: LiveNetwork): Result<LiveBatch<LiveVehicle>, LiveError> {
  invariant(body.status >= 200 && body.status <= 299, 'only a successful response is mapped');
  const feed = decodeFeedMessage(body.body);
  if (!feed.ok) {
    return err({ kind: 'decode', message: `${body.provider} vehicle positions: ${feed.error.message} (byte ${feed.error.offset})` });
  }
  const batch = batchOf(body, vehiclesFromFeed(feed.value, network));
  invariant(batch.items.every((vehicle) => vehicle.vehicleId.length > 0), 'every vehicle in a batch has an id');
  return ok(batch);
}

/** A trip-updates body as a batch of every in-scope prediction in the feed. */
export function tripUpdatesBatch(body: HttpBody, network: LiveNetwork): Result<LiveBatch<LivePrediction>, LiveError> {
  invariant(body.status >= 200 && body.status <= 299, 'only a successful response is mapped');
  const feed = decodeFeedMessage(body.body);
  if (!feed.ok) {
    return err({ kind: 'decode', message: `${body.provider} trip updates: ${feed.error.message} (byte ${feed.error.offset})` });
  }
  const batch = batchOf(body, predictionsFromFeed(feed.value, network));
  invariant(batch.provider === body.provider, 'the batch is the responding provider\'s');
  return ok(batch);
}

/** A Transitland departures body (JSON) as a batch of predictions at its stop. */
export function departuresBatch(body: HttpBody, network: LiveNetwork): Result<LiveBatch<LivePrediction>, LiveError> {
  invariant(body.status >= 200 && body.status <= 299, 'only a successful response is mapped');
  const json = parseJson(body);
  if (!json.ok) {
    return json;
  }
  const mapped = predictionsFromDepartures(json.value, network);
  invariant(mapped.ok || mapped.error.kind === 'decode', 'the departures mapper fails only as a decode error');
  return mapped.ok ? ok(batchOf(body, mapped.value)) : mapped;
}

/** The predictions in `batch` that apply at `stationKey`: its stops' rows, plus trip-wide cancellations (matched by trip later). */
export function stationBatch(batch: LiveBatch<LivePrediction>, stationKey: string): LiveBatch<LivePrediction> {
  invariant(stationKey.includes(':'), `"${stationKey}" is a station key (mode:name)`);
  const items = batch.items.filter((p) => p.stationKey === stationKey || (p.stopId === null && p.canceled));
  invariant(items.length <= batch.items.length, 'a station sees a subset of the feed');
  return { ...batch, items };
}

/** One station's batch from its stops' batches (one request each): every row, the bytes summed, the OLDEST fetch time. */
export function combineBatches(batches: readonly LiveBatch<LivePrediction>[]): LiveBatch<LivePrediction> {
  const [first] = batches;
  invariant(first !== undefined, 'a station has at least one stop');
  invariant(batches.every((batch) => batch.provider === first.provider), 'one provider answered for the station');
  const dropped: Drops = {};
  for (const batch of batches) {
    for (const reason of DROP_REASONS) {
      const n = batch.dropped[reason] ?? 0;
      if (n > 0) {
        countDrop(dropped, reason, n);
      }
    }
  }
  return {
    provider: first.provider,
    items: batches.flatMap((batch) => batch.items),
    feedTimestamp: first.feedTimestamp,
    dropped,
    fetchedAt: Math.min(...batches.map((batch) => batch.fetchedAt)),
    bytes: batches.reduce((sum, batch) => sum + batch.bytes, 0),
  };
}

/** Every reason a mapper counts. A Record over DropReason, so the compiler rejects a list that misses one. */
const DROP_REASON_FLAGS: Readonly<Record<DropReason, true>> = {
  'out-of-scope': true,
  deleted: true,
  'no-position': true,
  'no-timestamp': true,
  duplicate: true,
  'no-stop': true,
  'unknown-stop': true,
  'no-data': true,
  malformed: true,
};
const DROP_REASONS = Object.keys(DROP_REASON_FLAGS) as DropReason[];

function batchOf<T>(body: HttpBody, mapped: MappedFeed<T>): LiveBatch<T> {
  invariant(Number.isFinite(body.receivedAt), 'a response arrived at an instant');
  const batch: LiveBatch<T> = { ...mapped, provider: body.provider, fetchedAt: body.receivedAt, bytes: body.body.byteLength };
  invariant(batch.bytes === body.body.byteLength, 'a batch records its response size');
  return batch;
}

function parseJson(body: HttpBody): Result<unknown, LiveError> {
  invariant(body.body instanceof Uint8Array, 'a body is bytes');
  const text = decodeUtf8(body.body);
  invariant(typeof text === 'string', 'the body decodes to text');
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err({ kind: 'decode', message: `${body.provider} departures: the body is not JSON (${error instanceof Error ? error.message : String(error)})` });
  }
}
