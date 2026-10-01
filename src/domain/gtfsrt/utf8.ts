import { invariant } from '../../lib/invariant';

/**
 * UTF-8 → string, without TextDecoder (not something to lean on under Hermes). This is the
 * WHATWG Encoding Standard's UTF-8 decoder: overlong forms, UTF-16 surrogates, code points above
 * U+10FFFF, stray continuation bytes and truncated sequences each become U+FFFD (one per maximal
 * invalid subpart, exactly as TextDecoder does), so a feed with one bad byte still decodes.
 */

export const REPLACEMENT_CHARACTER = 0xfffd;

/** A multi-byte sequence in progress; `needed === 0` means between characters. */
type Sequence = {
  readonly needed: number;
  readonly seen: number;
  readonly codePoint: number;
  /** The allowed range of the NEXT continuation byte (narrowed after E0, ED, F0, F4). */
  readonly lower: number;
  readonly upper: number;
};

const BETWEEN: Sequence = { needed: 0, seen: 0, codePoint: 0, lower: 0x80, upper: 0xbf };
/** String.fromCharCode is spread in chunks so a long string never exceeds the argument limit. */
const CHUNK = 0x1000;

export function decodeUtf8(bytes: Uint8Array, start: number = 0, end: number = bytes.length): string {
  invariant(Number.isInteger(start) && Number.isInteger(end), 'the byte range is integral');
  invariant(start >= 0 && start <= end && end <= bytes.length, 'the byte range lies inside the bytes');
  const units: number[] = [];
  let sequence = BETWEEN;
  let i = start;
  for (let step = 0; i < end; step += 1) {
    // A byte that breaks a sequence is examined twice (it may start the next character).
    invariant(step < 2 * (end - start), 'each byte is examined at most twice');
    const byte = bytes[i];
    invariant(byte !== undefined, 'the index stays inside the range');
    if (sequence.needed === 0) {
      sequence = leadByte(byte, units);
      i += 1;
    } else if (byte < sequence.lower || byte > sequence.upper) {
      units.push(REPLACEMENT_CHARACTER);
      sequence = BETWEEN;
    } else {
      sequence = continuationByte(sequence, byte, units);
      i += 1;
    }
  }
  if (sequence.needed !== 0) {
    units.push(REPLACEMENT_CHARACTER);
  }
  return fromCodeUnits(units);
}

/** A byte seen between characters: ASCII is emitted, a lead byte opens a sequence, anything else is U+FFFD. */
function leadByte(byte: number, units: number[]): Sequence {
  invariant(byte >= 0 && byte <= 0xff, 'a byte is 0 … 255');
  const before = units.length;
  let next = BETWEEN;
  if (byte <= 0x7f) {
    units.push(byte);
  } else if (byte >= 0xc2 && byte <= 0xdf) {
    next = { ...BETWEEN, needed: 1, codePoint: byte & 0x1f };
  } else if (byte >= 0xe0 && byte <= 0xef) {
    const lower = byte === 0xe0 ? 0xa0 : 0x80; // E0 80…9F would be overlong
    const upper = byte === 0xed ? 0x9f : 0xbf; // ED A0…BF would be a UTF-16 surrogate
    next = { needed: 2, seen: 0, codePoint: byte & 0x0f, lower, upper };
  } else if (byte >= 0xf0 && byte <= 0xf4) {
    const lower = byte === 0xf0 ? 0x90 : 0x80; // F0 80…8F would be overlong
    const upper = byte === 0xf4 ? 0x8f : 0xbf; // F4 90… would exceed U+10FFFF
    next = { needed: 3, seen: 0, codePoint: byte & 0x07, lower, upper };
  } else {
    units.push(REPLACEMENT_CHARACTER);
  }
  invariant((next.needed === 0) === (units.length === before + 1), 'a lead byte either emits one unit or opens a sequence');
  return next;
}

/** An in-range continuation byte: fold in six bits; emit the character once the sequence is complete. */
function continuationByte(sequence: Sequence, byte: number, units: number[]): Sequence {
  invariant(sequence.needed > 0 && sequence.seen < sequence.needed, 'a continuation byte belongs to an open sequence');
  invariant(byte >= sequence.lower && byte <= sequence.upper, 'the caller has range-checked the byte');
  const codePoint = (sequence.codePoint << 6) | (byte & 0x3f);
  const seen = sequence.seen + 1;
  if (seen < sequence.needed) {
    return { needed: sequence.needed, seen, codePoint, lower: 0x80, upper: 0xbf };
  }
  pushCodePoint(codePoint, units);
  return BETWEEN;
}

function pushCodePoint(codePoint: number, units: number[]): void {
  invariant(codePoint >= 0x80 && codePoint <= 0x10ffff, 'a multi-byte sequence decodes to U+0080 … U+10FFFF');
  invariant(codePoint < 0xd800 || codePoint > 0xdfff, 'the range checks exclude UTF-16 surrogates');
  if (codePoint <= 0xffff) {
    units.push(codePoint);
    return;
  }
  const offset = codePoint - 0x10000;
  units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
}

function fromCodeUnits(units: readonly number[]): string {
  invariant(units.every((unit) => unit >= 0 && unit <= 0xffff), 'UTF-16 code units are 16-bit');
  let text = '';
  for (let at = 0; at < units.length; at += CHUNK) {
    text += String.fromCharCode(...units.slice(at, at + CHUNK));
  }
  invariant(text.length === units.length, 'one character per code unit');
  return text;
}
