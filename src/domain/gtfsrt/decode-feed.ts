import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { decodeTripUpdate } from './decode-trip-update';
import { decodeVehiclePosition } from './decode-vehicle';
import type { Draft, FeedEntity, FeedHeader, FeedMessage } from './types';
import {
  createReader,
  type DecodeError,
  decodeError,
  type Field,
  fieldBool,
  fieldInt32,
  fieldKey,
  fieldMessage,
  fieldString,
  fieldUint64,
  type Reader,
  readMessage,
  settle,
  WireType,
} from './wire';

/**
 * The entry point: GTFS-realtime FeedMessage bytes → `FeedMessage`, or the first decode error.
 * Pure and synchronous; no recursion — each message level is its own decoder, nested a fixed
 * number of levels deep by the schema itself.
 */

const HEADER = fieldKey(1, WireType.LEN);
const ENTITY = fieldKey(2, WireType.LEN);

const GTFS_REALTIME_VERSION = fieldKey(1, WireType.LEN);
const INCREMENTALITY = fieldKey(2, WireType.VARINT);
const HEADER_TIMESTAMP = fieldKey(3, WireType.VARINT);

const ENTITY_ID = fieldKey(1, WireType.LEN);
const IS_DELETED = fieldKey(2, WireType.VARINT);
const TRIP_UPDATE = fieldKey(3, WireType.LEN);
const VEHICLE = fieldKey(4, WireType.LEN);

/** Required fields (`header`, `gtfs_realtime_version`, `id`) may only be missing mid-decode. */
type FeedDraft = { header: FeedHeader | null; entity: FeedEntity[] };
type HeaderDraft = Draft<Omit<FeedHeader, 'gtfsRealtimeVersion'>> & { gtfsRealtimeVersion: string | null };
type EntityDraft = Draft<Omit<FeedEntity, 'id'>> & { id: string | null };

const EMPTY_HEADER: HeaderDraft = Object.freeze({ gtfsRealtimeVersion: null, incrementality: null, timestamp: null });

export function decodeFeedMessage(bytes: Uint8Array): Result<FeedMessage, DecodeError> {
  invariant(bytes instanceof Uint8Array, 'a feed is decoded from bytes');
  const reader = createReader(bytes);
  const draft: FeedDraft = { header: null, entity: [] };
  const failure = readMessage(reader, (field) => applyFeedField(draft, field));
  if (failure !== null) {
    return err(failure);
  }
  const { header } = draft;
  if (header === null) {
    return err(decodeError('missing-required-field', 0, 'FeedMessage.header is required'));
  }
  invariant(reader.pos === bytes.length, 'a decoded feed consumed every byte');
  return ok({ header, entity: draft.entity });
}

function applyFeedField(draft: FeedDraft, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case HEADER:
      return settle(decodeFeedHeader(fieldMessage(field), draft.header), (header) => {
        draft.header = header;
      });
    case ENTITY:
      return settle(decodeFeedEntity(fieldMessage(field)), (entity) => {
        draft.entity.push(entity);
      });
    default:
      return null; // an unknown field or an unexpected wire type: already consumed, skipped
  }
}

export function decodeFeedHeader(reader: Reader, base: FeedHeader | null): Result<FeedHeader, DecodeError> {
  invariant(reader.pos === reader.start, 'a FeedHeader is decoded from the start of its payload');
  const draft: HeaderDraft = { ...(base ?? EMPTY_HEADER) };
  const failure = readMessage(reader, (field) => applyHeaderField(draft, field));
  if (failure !== null) {
    return err(failure);
  }
  const { gtfsRealtimeVersion } = draft;
  if (gtfsRealtimeVersion === null) {
    return err(decodeError('missing-required-field', reader.start, 'FeedHeader.gtfs_realtime_version is required'));
  }
  invariant(reader.pos === reader.end, 'a decoded FeedHeader consumed its payload');
  return ok({ ...draft, gtfsRealtimeVersion });
}

function applyHeaderField(draft: HeaderDraft, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case GTFS_REALTIME_VERSION:
      draft.gtfsRealtimeVersion = fieldString(field);
      return null;
    case INCREMENTALITY:
      draft.incrementality = fieldInt32(field);
      return null;
    case HEADER_TIMESTAMP:
      return settle(fieldUint64(field), (timestamp) => {
        draft.timestamp = timestamp;
      });
    default:
      return null; // not modelled (feed_version) or an unexpected wire type: skipped
  }
}

/** One FeedEntity. `entity` is a repeated field, so every occurrence decodes fresh (no merge). */
export function decodeFeedEntity(reader: Reader): Result<FeedEntity, DecodeError> {
  invariant(reader.pos === reader.start, 'a FeedEntity is decoded from the start of its payload');
  const draft: EntityDraft = { id: null, isDeleted: null, tripUpdate: null, vehicle: null };
  const failure = readMessage(reader, (field) => applyEntityField(draft, field));
  if (failure !== null) {
    return err(failure);
  }
  const { id } = draft;
  if (id === null) {
    return err(decodeError('missing-required-field', reader.start, 'FeedEntity.id is required'));
  }
  invariant(reader.pos === reader.end, 'a decoded FeedEntity consumed its payload');
  return ok({ ...draft, id });
}

function applyEntityField(draft: EntityDraft, field: Field): DecodeError | null {
  invariant(field.number >= 1, 'fields have positive numbers');
  invariant(field.key === fieldKey(field.number, field.wireType), 'the key encodes number and wire type');
  switch (field.key) {
    case ENTITY_ID:
      draft.id = fieldString(field);
      return null;
    case IS_DELETED:
      draft.isDeleted = fieldBool(field);
      return null;
    case TRIP_UPDATE:
      return settle(decodeTripUpdate(fieldMessage(field), draft.tripUpdate), (tripUpdate) => {
        draft.tripUpdate = tripUpdate;
      });
    case VEHICLE:
      return settle(decodeVehiclePosition(fieldMessage(field), draft.vehicle), (vehicle) => {
        draft.vehicle = vehicle;
      });
    default:
      return null; // not modelled (alert, shape, stop, trip_modifications) or an unexpected wire type: skipped
  }
}
