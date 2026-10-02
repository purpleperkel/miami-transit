import type { LatLon } from '../../lib/geo';
import { invariant } from '../../lib/invariant';
import type { Result } from '../../lib/result';
import type { LineId } from '../lines/line-catalog';
import type { Mode } from '../network/stations';

/**
 * Plan §4 "Live interface" (M4.1): the contract between the realtime providers (src/live, M4.9) and
 * the pure engine (this folder). A provider fetches; the domain maps, chains, schedules and merges.
 *
 *   LiveProvider { id, capabilities{vehicles,predictions}, fetchVehicles(signal),
 *                  fetchPredictions(stationKey, signal) } → Result<LiveBatch<…>, LiveError>
 *
 * Vehicles and predictions are separate CAPABILITIES because they come from different endpoints
 * (§3, live-verified 2026-10-01): Transitland's vehicles are `vehicle_positions.pb`, its predictions
 * are per-station `departures` JSON (its whole-agency trip-updates download is 1 MB and is never
 * fetched). The provider chain resolves each capability on its own (chain.ts).
 */

/** The realtime providers, in chain order (§3: swiftly ▸ transitland ▸ none). */
export const PROVIDER_IDS = ['swiftly', 'transitland'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** A provider or the end of the chain: `none` = no live data, the schedule alone. */
export type ChainProviderId = ProviderId | 'none';

export type Capability = 'vehicles' | 'predictions';
export type Capabilities = { readonly vehicles: boolean; readonly predictions: boolean };

/**
 * Neutral line ids for a vehicle on track two lines share, when no known trip says which line it
 * runs (arbiter ruling R-c, 2026-10-01): Green and Orange share the rail trunk (Earlington Heights
 * to Dadeland South); Omni and Brickell share the Metromover track into Government Center. The map
 * renders these in a neutral colour — a position alone cannot tell the two lines apart there.
 */
export const TRUNK_LINE_IDS = ['RAIL_TRUNK', 'MM_TRUNK'] as const;
export type TrunkLineId = (typeof TRUNK_LINE_IDS)[number];
export type LiveLineId = LineId | TrunkLineId;

/** Where a live vehicle's line came from: its route has one line, its trip's pattern, or its position. */
export type LineSource = 'route' | 'trip' | 'position';

/** VehiclePosition.VehicleStopStatus, named. */
export type StopStatus = 'incoming' | 'stopped' | 'in-transit';

export type LiveVehicle = {
  /** The provider's vehicle id (VehicleDescriptor.id, else the feed entity id): one per vehicle in a batch. */
  readonly vehicleId: string;
  readonly label: string | null;
  readonly tripId: string | null;
  /** In scope: 31009 (Metrorail), 14456 (Omni + Brickell) or 14457 (Inner Loop). */
  readonly routeId: string;
  readonly mode: Mode;
  readonly lineId: LiveLineId;
  readonly lineSource: LineSource;
  readonly directionId: number | null;
  readonly position: LatLon;
  /** Degrees clockwise from true north. */
  readonly bearing: number | null;
  readonly speedMps: number | null;
  readonly stopId: string | null;
  readonly stopStatus: StopStatus | null;
  /** Epoch second the position was measured (the feed header's timestamp when the vehicle has none). */
  readonly timestamp: number;
};

export type LivePrediction = {
  readonly tripId: string | null;
  readonly routeId: string;
  /** The trip's line from the schedule (trip → pattern), or null when the schedule does not know the trip. */
  readonly lineId: LineId | null;
  /** The stop predicted; null for a whole-trip cancellation (a canceled trip lists no stops). */
  readonly stopId: string | null;
  readonly stationKey: string | null;
  /** The predicted departure (epoch s), when the provider gave an absolute time. */
  readonly epoch: number | null;
  /** The scheduled departure (epoch s), when the provider gave one (Transitland does; GTFS-RT does not). */
  readonly scheduledEpoch: number | null;
  /** Seconds late (negative = early), when known. */
  readonly delayS: number | null;
  /** A realtime estimate; false flags a scheduled-only row (Transitland STATIC, or no estimate). */
  readonly realtime: boolean;
  /** The trip — or this stop of it — will not run: shown struck through, never removed. */
  readonly canceled: boolean;
  readonly headsign: string | null;
};

/** Why a mapper left a feed entity or row out. Counted, never silently lost (Diagnostics shows them). */
export type DropReason =
  | 'out-of-scope'
  | 'deleted'
  | 'no-position'
  | 'no-timestamp'
  | 'duplicate'
  | 'no-stop'
  | 'unknown-stop'
  | 'no-data'
  | 'malformed';
export type DropCounts = Readonly<Partial<Record<DropReason, number>>>;

/** What a pure mapper makes of one response: the items, the feed's own timestamp, what it dropped. */
export type MappedFeed<T> = {
  readonly items: readonly T[];
  /** The feed header's timestamp (epoch s), or null when the response carries none. */
  readonly feedTimestamp: number | null;
  readonly dropped: DropCounts;
};

/** One successful provider fetch: the mapped items plus when and how much was fetched. */
export type LiveBatch<T> = MappedFeed<T> & {
  readonly provider: ProviderId;
  /** Epoch second the response arrived. */
  readonly fetchedAt: number;
  /** Response body size — logged to Diagnostics (cellular budget, falsifier R19). */
  readonly bytes: number;
};

/** The five ways a live fetch fails (§4). */
export const LIVE_ERROR_KINDS = ['no-key', 'network', 'timeout', 'http', 'decode'] as const;
export type LiveErrorKind = (typeof LIVE_ERROR_KINDS)[number];

/**
 * How a fetch failed. `reused` (mfix10) marks a failure a provider hands out AGAIN, from a download
 * another poll started (Swiftly shares each download for its 30 s cache term, providers/swiftly.ts):
 * the poll that started the download records the failure in the chain once; every poll that gets
 * it, reused or not, still backs off (poller.ts).
 */
export type LiveError = (
  | { readonly kind: 'no-key'; readonly message: string }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'http'; readonly status: number; readonly message: string }
  | { readonly kind: 'decode'; readonly message: string }
) & { readonly reused?: true };

/**
 * mfix10 fix round 3 (R5): a shared download that REJECTED — a bug, such as a mapper's broken
 * invariant — as a fetch that did not start it gets it. It reads as the bug itself (the same name
 * and message, the original kept as `original`), so the poll that started the download records the
 * bug in the chain once, and a poll that gets this one records nothing there but still backs off.
 */
export class ReusedRejection extends Error {
  readonly reused = true;

  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = original instanceof Error ? original.name : 'Error';
    invariant(original instanceof Error, 'a download rejects only by a bug, and src/live throws a bug as an Error');
    invariant(!(original instanceof ReusedRejection), 'a rejection is marked reused once, by the provider that shares the download');
  }
}

export type LiveResult<T> = Result<LiveBatch<T>, LiveError>;

export type LiveProvider = {
  readonly id: ChainProviderId;
  readonly capabilities: Capabilities;
  fetchVehicles(signal: AbortSignal): Promise<LiveResult<LiveVehicle>>;
  fetchPredictions(stationKey: string, signal: AbortSignal): Promise<LiveResult<LivePrediction>>;
};

/**
 * What the pure mappers need from the schedule (M3's schedule.db), injected so this folder stays
 * pure. The runtime (M4.9) backs these with schedule.db queries; tests pass small fakes.
 */
export type LiveNetwork = {
  /** trip_id → its pattern's line (trip.pattern_idx → pattern.line_id), or null for a trip the schedule lacks. */
  readonly lineOfTrip: (tripId: string) => LineId | null;
  /** stop_id → its station key, or null for a stop outside the schedule. */
  readonly stationOfStop: (stopId: string) => string | null;
  /** Each line's track (line_shape → shape_point), to place a vehicle whose trip is unknown. */
  readonly tracks: readonly LineTrack[];
};

export type LineTrack = { readonly lineId: LineId; readonly points: readonly LatLon[] };
