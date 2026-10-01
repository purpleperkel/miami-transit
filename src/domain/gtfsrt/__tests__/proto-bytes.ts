import { invariant } from '../../../lib/invariant';

/**
 * A tiny protobuf ENCODER for hand-built test inputs. It is deliberately independent of the
 * decoder under test: varints are produced with BigInt arithmetic (not 32-bit halves), floats
 * with a DataView, and strings with the platform's TextEncoder.
 */

const MAX_VARINT_BYTES = 10;

export function varint(value: number | bigint): number[] {
  invariant(typeof value === 'bigint' || Number.isSafeInteger(value), 'varint() encodes integers');
  let rest = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const low7 = Number(rest & BigInt(0x7f));
    rest >>= BigInt(7);
    out.push(rest === BigInt(0) ? low7 : low7 | 0x80);
    if (rest === BigInt(0)) {
      break;
    }
  }
  invariant(out.length >= 1 && out.length <= MAX_VARINT_BYTES, 'a varint is 1 to 10 bytes');
  return out;
}

export function tag(fieldNumber: number, wireType: number): number[] {
  invariant(Number.isInteger(fieldNumber) && fieldNumber >= 0, 'field numbers are non-negative integers');
  invariant(wireType >= 0 && wireType <= 7, 'a wire type is three bits');
  return varint(fieldNumber * 8 + wireType);
}

export function varintField(fieldNumber: number, value: number | bigint): number[] {
  const out = [...tag(fieldNumber, 0), ...varint(value)];
  invariant(out.length >= 2, 'a varint field is a tag plus at least one byte');
  invariant(out.length <= 15, 'tag and payload together stay short');
  return out;
}

export function float32Field(fieldNumber: number, value: number): number[] {
  invariant(Number.isFinite(value), 'float32Field() encodes finite numbers');
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const out = [...tag(fieldNumber, 5), ...new Uint8Array(view.buffer)];
  invariant(out.length >= 5, 'an I32 field is a tag plus four bytes');
  return out;
}

export function fixed64Field(fieldNumber: number, value: number): number[] {
  invariant(Number.isFinite(value), 'fixed64Field() encodes finite numbers');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  const out = [...tag(fieldNumber, 1), ...new Uint8Array(view.buffer)];
  invariant(out.length >= 9, 'an I64 field is a tag plus eight bytes');
  return out;
}

export function lengthField(fieldNumber: number, payload: readonly number[]): number[] {
  invariant(payload.every((byte) => byte >= 0 && byte <= 0xff), 'a payload is bytes');
  const out = [...tag(fieldNumber, 2), ...varint(payload.length), ...payload];
  invariant(out.length > payload.length, 'a LEN field adds a tag and a length');
  return out;
}

export function stringField(fieldNumber: number, text: string): number[] {
  const utf8 = [...new TextEncoder().encode(text)];
  invariant(utf8.length >= text.length, 'UTF-8 takes at least one byte per UTF-16 code unit');
  const out = lengthField(fieldNumber, utf8);
  invariant(out.length > utf8.length, 'a string field adds a tag and a length');
  return out;
}

/** Concatenates encoded parts into the bytes a decoder reads. */
export function bytesOf(...parts: readonly (readonly number[])[]): Uint8Array {
  const flat = parts.flat();
  invariant(flat.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff), 'parts are bytes');
  const out = Uint8Array.from(flat);
  invariant(out.length === flat.length, 'every byte is copied');
  return out;
}
