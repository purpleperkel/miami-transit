import {
  createReader,
  type Field,
  fieldBool,
  fieldFloat32,
  fieldInt32,
  fieldInt64,
  fieldKey,
  fieldString,
  fieldUint32,
  fieldUint64,
  readField,
  readMessage,
  readVarint,
  WireType,
} from '../wire';
import { bytesOf, fixed64Field, float32Field, stringField, tag, varint, varintField } from './proto-bytes';

/** The one field in `bytes`, which must decode cleanly and use every byte. */
function onlyField(bytes: Uint8Array): Field {
  const reader = createReader(bytes);
  const field = readField(reader);
  if (!field.ok) {
    throw new Error(`expected a field, got ${field.error.kind}: ${field.error.message}`);
  }
  expect(reader.pos).toBe(bytes.length);
  expect(field.value.offset).toBe(0);
  return field.value;
}

const TEN_BYTE_MINUS_ONE = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];

describe('wire reader: varints', () => {
  it('reads [0xAC, 0x02] as 300', () => {
    const reader = createReader(Uint8Array.of(0xac, 0x02));
    expect(readVarint(reader)).toEqual({ ok: true, value: { lo: 300, hi: 0 } });
    expect(reader.pos).toBe(2);
    expect(fieldUint32(onlyField(bytesOf(tag(1, WireType.VARINT), [0xac, 0x02])))).toBe(300);
  });

  it('reads the ten-byte negative varint for -1 as int32 -1 (and int64 -1)', () => {
    const field = onlyField(bytesOf(tag(1, WireType.VARINT), TEN_BYTE_MINUS_ONE));
    expect(varint(-1)).toEqual(TEN_BYTE_MINUS_ONE);
    expect(fieldInt32(field)).toBe(-1);
    expect(fieldInt64(field)).toEqual({ ok: true, value: -1 });
  });

  it('truncates a negative int32 such as -45 from its sign-extended 64 bits', () => {
    const encoded = varint(-45);
    expect(encoded).toHaveLength(10);
    expect(fieldInt32(onlyField(bytesOf(tag(5, WireType.VARINT), encoded)))).toBe(-45);
  });

  it('keeps all 32 bits of a uint32 (bits 28-31 come from the fifth byte)', () => {
    expect(fieldUint32(onlyField(bytesOf(varintField(1, 0xffffffff))))).toBe(0xffffffff);
    expect(fieldUint32(onlyField(bytesOf(varintField(1, 0x80000000))))).toBe(0x80000000);
    expect(fieldInt32(onlyField(bytesOf(varintField(1, -0x80000000))))).toBe(-0x80000000);
  });

  it('reads uint64 values past 2^32 exactly, up to 2^53 - 1', () => {
    expect(fieldUint64(onlyField(bytesOf(varintField(1, 5_000_000_000))))).toEqual({ ok: true, value: 5_000_000_000 });
    const max = Number.MAX_SAFE_INTEGER;
    expect(fieldUint64(onlyField(bytesOf(varintField(1, max))))).toEqual({ ok: true, value: max });
    expect(fieldInt64(onlyField(bytesOf(varintField(1, -max))))).toEqual({ ok: true, value: -max });
  });

  it('refuses 64-bit integers beyond 2^53 rather than rounding them', () => {
    const tooBig = onlyField(bytesOf(varintField(1, BigInt(2) ** BigInt(53))));
    expect(fieldUint64(tooBig)).toMatchObject({ ok: false, error: { kind: 'unsafe-integer' } });
    expect(fieldInt64(tooBig)).toMatchObject({ ok: false, error: { kind: 'unsafe-integer' } });
    const tooNegative = onlyField(bytesOf(varintField(1, -(BigInt(2) ** BigInt(53)))));
    expect(fieldInt64(tooNegative)).toMatchObject({ ok: false, error: { kind: 'unsafe-integer' } });
  });

  it('reads bools from varints', () => {
    expect(fieldBool(onlyField(bytesOf(varintField(2, 1))))).toBe(true);
    expect(fieldBool(onlyField(bytesOf(varintField(2, 0))))).toBe(false);
  });

  it('rejects a varint longer than 10 bytes or wider than 64 bits', () => {
    const eleven = Uint8Array.of(...Array.from({ length: 10 }, () => 0x80), 0x01);
    expect(readVarint(createReader(eleven))).toMatchObject({ ok: false, error: { kind: 'malformed-varint' } });
    const wide = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02);
    expect(readVarint(createReader(wide))).toMatchObject({ ok: false, error: { kind: 'malformed-varint' } });
  });
});

describe('wire reader: fixed-width and length-delimited fields', () => {
  it('reads float32 25.77 accurate to 1e-5 (and a negative longitude)', () => {
    const latitude = fieldFloat32(onlyField(bytesOf(float32Field(1, 25.77))));
    expect(Math.abs(latitude - 25.77)).toBeLessThanOrEqual(1e-5);
    const longitude = fieldFloat32(onlyField(bytesOf(float32Field(2, -80.1937))));
    expect(Math.abs(longitude - -80.1937)).toBeLessThanOrEqual(1e-5);
  });

  it('reads a length-delimited string', () => {
    const field = onlyField(bytesOf(stringField(4, '9513')));
    expect(field.wireType).toBe(WireType.LEN);
    expect(fieldString(field)).toBe('9513');
  });

  it('keys a field by number and wire type together', () => {
    const field = onlyField(bytesOf(varintField(1000, 7)));
    expect(field.number).toBe(1000);
    expect(field.key).toBe(fieldKey(1000, WireType.VARINT));
    expect(fieldKey(1, WireType.LEN)).toBe(0x0a);
  });
});

describe('wire reader: malformed input is an Err, never a throw', () => {
  it('rejects wire type 3 (start group) with an Err', () => {
    const result = readField(createReader(bytesOf(tag(1, WireType.SGROUP), [0x00])));
    expect(result).toMatchObject({ ok: false, error: { kind: 'unsupported-wire-type', offset: 0 } });
    const endGroup = readField(createReader(bytesOf(tag(1, WireType.EGROUP))));
    expect(endGroup).toMatchObject({ ok: false, error: { kind: 'unsupported-wire-type' } });
  });

  it('returns an Err for reading past the end of a varint, a fixed field or a LEN payload', () => {
    const cases = [
      bytesOf(tag(1, WireType.VARINT), [0x80]),
      bytesOf(tag(1, WireType.I32), [0x01, 0x02]),
      bytesOf(tag(1, WireType.I64), [0x01, 0x02, 0x03, 0x04]),
      bytesOf(tag(1, WireType.LEN), [0x05, 0x61]),
      Uint8Array.of(0x80),
    ];
    for (const bytes of cases) {
      expect(readField(createReader(bytes))).toMatchObject({ ok: false, error: { kind: 'truncated' } });
    }
    expect(cases).toHaveLength(5);
  });

  it('rejects field number 0', () => {
    const result = readField(createReader(bytesOf(tag(0, WireType.VARINT), [0x01])));
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-tag' } });
    expect(result.ok).toBe(false);
  });
});

describe('readMessage', () => {
  it('hands over every field in order, skipping nothing it has not been asked to', () => {
    const bytes = bytesOf(varintField(1, 300), fixed64Field(9, 1.5), float32Field(2, 25.77), stringField(3, 'x'));
    const seen: number[] = [];
    const failure = readMessage(createReader(bytes), (field) => {
      seen.push(field.number);
      return null;
    });
    expect(failure).toBeNull();
    expect(seen).toEqual([1, 9, 2, 3]);
  });

  it('stops at the first malformed field and reports where it starts', () => {
    const good = varintField(1, 1);
    const failure = readMessage(createReader(bytesOf(good, tag(2, WireType.SGROUP))), () => null);
    expect(failure).toMatchObject({ kind: 'unsupported-wire-type', offset: good.length });
    expect(failure?.message).toContain('wire type 3');
  });
});
