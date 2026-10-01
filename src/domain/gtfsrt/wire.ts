import { invariant } from '../../lib/invariant';
import { err, ok, type Result } from '../../lib/result';
import { decodeUtf8 } from './utf8';

/**
 * A minimal protobuf wire-format reader — enough for GTFS-realtime, and nothing that needs a
 * runtime code generator (this is what keeps protobufjs out of the Hermes bundle).
 *
 * `readField` reads one whole field — tag plus payload — so a message decoder is a bounded loop
 * that dispatches on `field.key` (field number and wire type together) and lets every other key
 * fall through: unknown fields, and known fields carrying an unexpected wire type, are skipped
 * exactly as protobuf requires. Groups (wire types 3 and 4) are deprecated and absent from
 * GTFS-realtime, so they are a decode error rather than something to skip.
 *
 * JS bit operators are 32-bit, so a varint is held as two unsigned 32-bit halves and only turned
 * into a number by the typed accessors; 64-bit integers outside ±2^53 are an error, never a
 * silently rounded number.
 */

export const WireType = { VARINT: 0, I64: 1, LEN: 2, SGROUP: 3, EGROUP: 4, I32: 5 } as const;

export type DecodeErrorKind =
  | 'truncated'
  | 'malformed-varint'
  | 'invalid-tag'
  | 'unsupported-wire-type'
  | 'unsafe-integer'
  | 'missing-required-field';

/** Why bytes are not a decodable message, and where (absolute byte offset into the input). */
export type DecodeError = { readonly kind: DecodeErrorKind; readonly offset: number; readonly message: string };

/** A cursor over `bytes[start, end)`; offsets stay absolute so errors point into the original input. */
export type Reader = { readonly bytes: Uint8Array; readonly start: number; readonly end: number; pos: number };

/** 64 bits as two unsigned 32-bit halves: value = hi * 2^32 + lo. */
export type Bits64 = { readonly lo: number; readonly hi: number };

type FieldHead = { readonly number: number; readonly key: number; readonly offset: number };
/** VARINT, I64 and I32 payloads, as raw bits (I32 has hi = 0). */
export type ScalarField = FieldHead & { readonly wireType: 0 | 1 | 5; readonly bits: Bits64 };
/** A LEN payload: `bytes[start, end)` holds a string, bytes or an embedded message. */
export type LengthField = FieldHead & {
  readonly wireType: 2;
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
};
export type Field = ScalarField | LengthField;

/** Protobuf field numbers run 1 … 2^29 − 1. */
const MAX_FIELD_NUMBER = 0x1fffffff;
const MAX_VARINT_BYTES = 10;
const TWO_POW_32 = 0x100000000;
/** |hi| below 2^21 keeps hi * 2^32 + lo inside ±2^53, where every integer is exact. */
const SAFE_HI_LIMIT = 0x200000;

const float32Scratch = new DataView(new ArrayBuffer(4));

/** The dispatch key a decoder switches on: the tag value `fieldNumber << 3 | wireType`. */
export function fieldKey(fieldNumber: number, wireType: number): number {
  invariant(Number.isInteger(fieldNumber) && fieldNumber >= 1 && fieldNumber <= MAX_FIELD_NUMBER, 'field numbers are 1 … 2^29 − 1');
  invariant(Number.isInteger(wireType) && wireType >= 0 && wireType <= 7, 'a wire type is three bits');
  return fieldNumber * 8 + wireType;
}

export function createReader(bytes: Uint8Array, start: number = 0, end: number = bytes.length): Reader {
  invariant(Number.isInteger(start) && Number.isInteger(end), 'reader bounds are integers');
  invariant(start >= 0 && start <= end && end <= bytes.length, 'the reader window lies inside the bytes');
  return { bytes, start, end, pos: start };
}

export function decodeError(kind: DecodeErrorKind, offset: number, message: string): DecodeError {
  invariant(Number.isInteger(offset) && offset >= 0, 'a decode error points at a byte offset');
  invariant(message.length > 0, 'a decode error explains itself');
  return { kind, offset, message };
}

/** One base-128 varint (at most 10 bytes, at most 64 bits) as two 32-bit halves. */
export function readVarint(reader: Reader): Result<Bits64, DecodeError> {
  invariant(reader.pos >= reader.start && reader.pos <= reader.end, 'the cursor is inside its window');
  invariant(reader.end <= reader.bytes.length, 'the window lies inside the bytes');
  const offset = reader.pos;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const byte = reader.bytes[reader.pos];
    if (reader.pos >= reader.end || byte === undefined) {
      return err(decodeError('truncated', offset, 'varint runs past the end of its message'));
    }
    reader.pos += 1;
    const payload = byte & 0x7f;
    if (i < 4) {
      lo |= payload << (7 * i);
    } else if (i === 4) {
      lo |= (payload & 0x0f) << 28;
      hi |= payload >>> 4;
    } else if (i < 9) {
      hi |= payload << (7 * i - 32);
    } else if (payload > 1) {
      return err(decodeError('malformed-varint', offset, 'varint carries more than 64 bits'));
    } else {
      hi |= payload << 31;
    }
    if ((byte & 0x80) === 0) {
      return ok({ lo: lo >>> 0, hi: hi >>> 0 });
    }
  }
  return err(decodeError('malformed-varint', offset, 'varint is longer than 10 bytes'));
}

/** One whole field: the tag, then the payload its wire type implies (always fully consumed). */
export function readField(reader: Reader): Result<Field, DecodeError> {
  invariant(reader.pos < reader.end, 'readField is only called while the message has bytes left');
  const offset = reader.pos;
  const tag = readVarint(reader);
  if (!tag.ok) {
    return tag;
  }
  const number = tag.value.lo >>> 3;
  const wireType = tag.value.lo & 7;
  if (tag.value.hi !== 0 || number === 0) {
    return err(decodeError('invalid-tag', offset, `tag ${tag.value.hi}:${tag.value.lo} has no valid field number`));
  }
  const head: FieldHead = { number, key: tag.value.lo, offset };
  const field = readPayload(reader, head, wireType);
  invariant(!field.ok || field.value.key === fieldKey(number, field.value.wireType), 'the key encodes number and wire type');
  return field;
}

/**
 * Hands every field of one message to `apply`, in wire order, stopping at the first error. `apply`
 * returns null once it has used (or deliberately ignored) a field, or the error that ends decoding.
 */
export function readMessage(reader: Reader, apply: (field: Field) => DecodeError | null): DecodeError | null {
  invariant(reader.pos === reader.start, 'a message is read from the start of its payload');
  while (reader.pos < reader.end) {
    const field = readField(reader);
    if (!field.ok) {
      return field.error;
    }
    const failure = apply(field.value);
    if (failure !== null) {
      return failure;
    }
  }
  invariant(reader.pos === reader.end, 'the message consumed exactly its payload');
  return null;
}

/** For an `apply` callback: store a successful sub-decode through `store`, or hand its error back. */
export function settle<T>(result: Result<T, DecodeError>, store: (value: T) => void): DecodeError | null {
  invariant(typeof result.ok === 'boolean', 'settle needs a Result');
  invariant(typeof store === 'function', 'settle needs somewhere to store the value');
  if (!result.ok) {
    return result.error;
  }
  store(result.value);
  return null;
}

function readPayload(reader: Reader, head: FieldHead, wireType: number): Result<Field, DecodeError> {
  invariant(head.offset < reader.pos && reader.pos <= reader.end, 'the tag has been consumed');
  invariant(wireType >= 0 && wireType <= 7, 'a wire type is three bits');
  switch (wireType) {
    case WireType.VARINT: {
      const bits = readVarint(reader);
      return bits.ok ? ok({ ...head, wireType: WireType.VARINT, bits: bits.value }) : bits;
    }
    case WireType.I64: {
      const bits = readFixed(reader, 8);
      return bits.ok ? ok({ ...head, wireType: WireType.I64, bits: bits.value }) : bits;
    }
    case WireType.I32: {
      const bits = readFixed(reader, 4);
      return bits.ok ? ok({ ...head, wireType: WireType.I32, bits: bits.value }) : bits;
    }
    case WireType.LEN:
      return readLength(reader, head);
    default:
      return err(
        decodeError(
          'unsupported-wire-type',
          head.offset,
          `field ${head.number} uses wire type ${wireType}; groups (3, 4) and 6, 7 are not supported`,
        ),
      );
  }
}

/** A little-endian fixed-width payload (I32 or I64) as raw bits. */
function readFixed(reader: Reader, size: 4 | 8): Result<Bits64, DecodeError> {
  invariant(size === 4 || size === 8, 'fixed payloads are 4 or 8 bytes');
  invariant(reader.pos <= reader.end, 'the cursor is inside its window');
  const at = reader.pos;
  if (reader.end - at < size) {
    return err(decodeError('truncated', at, `${size}-byte fixed field runs past the end of its message`));
  }
  reader.pos += size;
  return ok({ lo: uint32LittleEndian(reader.bytes, at), hi: size === 8 ? uint32LittleEndian(reader.bytes, at + 4) : 0 });
}

function uint32LittleEndian(bytes: Uint8Array, at: number): number {
  const [b0, b1, b2, b3] = bytes.subarray(at, at + 4);
  invariant(b0 !== undefined && b1 !== undefined && b2 !== undefined && b3 !== undefined, 'four bytes are in range');
  const value = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  invariant(value >= 0 && value < TWO_POW_32, 'a little-endian word is an unsigned 32-bit value');
  return value;
}

function readLength(reader: Reader, head: FieldHead): Result<LengthField, DecodeError> {
  invariant(reader.pos <= reader.end, 'the cursor is inside its window');
  invariant(head.offset < reader.pos, 'the tag has been consumed');
  const length = readVarint(reader);
  if (!length.ok) {
    return length;
  }
  const remaining = reader.end - reader.pos;
  if (length.value.hi !== 0 || length.value.lo > remaining) {
    const claimed = length.value.hi * TWO_POW_32 + length.value.lo;
    return err(decodeError('truncated', head.offset, `field ${head.number} claims ${claimed} bytes; ${remaining} remain`));
  }
  const start = reader.pos;
  reader.pos += length.value.lo;
  return ok({ ...head, wireType: WireType.LEN, bytes: reader.bytes, start, end: reader.pos });
}

// ---- typed accessors. A decoder dispatches on `field.key`, so the wire type is already known;
// ---- a mismatch here is a bug in the decoder, not bad input, hence invariant().

/** uint32: the low 32 bits of the varint. */
export function fieldUint32(field: Field): number {
  invariant(field.wireType === WireType.VARINT, `field ${field.number} is not a varint`);
  const value = field.bits.lo;
  invariant(value >= 0 && value < TWO_POW_32, 'a uint32 is in [0, 2^32)');
  return value;
}

/** int32 and enums: the low 32 bits as two's complement (negatives arrive sign-extended to 10 bytes). */
export function fieldInt32(field: Field): number {
  invariant(field.wireType === WireType.VARINT, `field ${field.number} is not a varint`);
  const value = field.bits.lo | 0;
  invariant(value >= -0x80000000 && value <= 0x7fffffff, 'an int32 is in [−2^31, 2^31)');
  return value;
}

export function fieldBool(field: Field): boolean {
  invariant(field.wireType === WireType.VARINT, `field ${field.number} is not a varint`);
  invariant(Number.isInteger(field.bits.lo) && Number.isInteger(field.bits.hi), 'varint halves are integers');
  return field.bits.lo !== 0 || field.bits.hi !== 0;
}

/** uint64 as a number; an error above 2^53 − 1 rather than a silently rounded value. */
export function fieldUint64(field: Field): Result<number, DecodeError> {
  invariant(field.wireType === WireType.VARINT, `field ${field.number} is not a varint`);
  const { lo, hi } = field.bits;
  if (hi >= SAFE_HI_LIMIT) {
    return err(decodeError('unsafe-integer', field.offset, `field ${field.number}: uint64 exceeds 2^53 − 1`));
  }
  const value = hi * TWO_POW_32 + lo;
  invariant(Number.isSafeInteger(value) && value >= 0, 'a decoded uint64 is a safe non-negative integer');
  return ok(value);
}

/** int64 as a number (two's complement over 64 bits); an error outside ±(2^53 − 1). */
export function fieldInt64(field: Field): Result<number, DecodeError> {
  invariant(field.wireType === WireType.VARINT, `field ${field.number} is not a varint`);
  const { lo, hi } = field.bits;
  const signedHi = hi | 0;
  const value = signedHi * TWO_POW_32 + lo;
  if (signedHi >= SAFE_HI_LIMIT || signedHi < -SAFE_HI_LIMIT || !Number.isSafeInteger(value)) {
    return err(decodeError('unsafe-integer', field.offset, `field ${field.number}: int64 is outside ±(2^53 − 1)`));
  }
  invariant(Number.isSafeInteger(value), 'a decoded int64 is a safe integer');
  invariant((value < 0) === (signedHi < 0), 'the sign comes from bit 63');
  return ok(value);
}

/** float: the I32 bits reinterpreted as an IEEE-754 single through a DataView. */
export function fieldFloat32(field: Field): number {
  invariant(field.wireType === WireType.I32, `field ${field.number} is not a 32-bit fixed field`);
  invariant(field.bits.hi === 0, 'an I32 payload has no high word');
  float32Scratch.setUint32(0, field.bits.lo, true);
  return float32Scratch.getFloat32(0, true);
}

/** string: the LEN payload decoded as UTF-8 (invalid sequences become U+FFFD). */
export function fieldString(field: Field): string {
  invariant(field.wireType === WireType.LEN, `field ${field.number} is not length-delimited`);
  invariant(field.start <= field.end && field.end <= field.bytes.length, 'the payload lies inside the bytes');
  return decodeUtf8(field.bytes, field.start, field.end);
}

/** An embedded message: a fresh reader over exactly the LEN payload. */
export function fieldMessage(field: Field): Reader {
  invariant(field.wireType === WireType.LEN, `field ${field.number} is not length-delimited`);
  const reader = createReader(field.bytes, field.start, field.end);
  invariant(reader.pos === field.start && reader.end === field.end, 'the sub-reader covers exactly the payload');
  return reader;
}
